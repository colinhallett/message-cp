#!/usr/bin/env bash
# Exercises deploy.sh end to end without root or systemd: a bare git repo stands in for GitHub, and a stand-in
# `systemctl` runs `node current/dist/cli.js serve` in the background. It deploys a good commit, then a commit
# whose server builds but fails `npm run e2e`, and checks that the good release is live and serving again, that a
# run interrupted before its check or rollback is undone by the next one, and that a failed sha is tried again once
# main has moved away from it and back.
#
#   ops/try-deploy.sh            (from a clone of this repo; needs git, node, npm, curl, flock)
#
# Exits 0 when all of that holds, 1 otherwise. Its work directory is printed and kept for inspection.
set -euo pipefail

SRC=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/memory-cp-try-deploy.XXXXXX")
ROOT=$WORK/opt/memory-cp
PORT=${PORT:-18787}
echo "try-deploy: working in $WORK"

say() { echo; echo "=== $*"; }
fail() { echo "try-deploy: FAIL $*"; exit 1; }

# The stand-in for GitHub, whose main is one commit holding this checkout's HEAD.
commit() { git -C "$WORK/src" -c user.name=try-deploy -c user.email=try-deploy@example.invalid commit --quiet "$@"; }
git init --quiet --bare "$WORK/origin.git"
git init --quiet "$WORK/src"
git -C "$SRC" archive HEAD | tar -x -C "$WORK/src"
git -C "$WORK/src" add -A
commit -m "HEAD of $SRC"
git -C "$WORK/src" push --quiet "$WORK/origin.git" HEAD:refs/heads/main

mkdir -p "$ROOT" "$WORK/etc" "$WORK/var" "$WORK/bin"
git clone --quiet --bare "$WORK/origin.git" "$ROOT/repo.git"
cp "$SRC/ops/deploy.sh" "$ROOT/deploy.sh"
cat >"$WORK/etc/memory-cp.env" <<EOF
MEMORY_CP_HTTP_TOKEN=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
MEMORY_CP_PUBLIC_URL=http://127.0.0.1:$PORT
MEMORY_CP_DB=$WORK/var/db.sqlite
EOF
chmod 600 "$WORK/etc/memory-cp.env"

# `systemctl restart|stop memory-cp`, as the memory-cp.service unit would do it.
cat >"$WORK/bin/systemctl" <<EOF
#!/usr/bin/env bash
set -eu
pid=$WORK/var/server.pid
if [ -f "\$pid" ]; then kill "\$(cat "\$pid")" 2>/dev/null || true; rm -f "\$pid"; sleep 1; fi
[ "\$1" = restart ] || exit 0
set -a; . $WORK/etc/memory-cp.env; set +a
cd $ROOT/current
# Closing fd 9 matters: deploy.sh holds its lock on it, and systemd would not hand it to the service.
nohup node dist/cli.js serve --port $PORT --public-url "\$MEMORY_CP_PUBLIC_URL" >>$WORK/var/server.log 2>&1 9>&- &
echo \$! >"\$pid"
EOF
chmod +x "$WORK/bin/systemctl"
trap '"$WORK/bin/systemctl" stop memory-cp' EXIT

deploy() {
  PATH=$WORK/bin:$PATH MEMORY_CP_ROOT=$ROOT MEMORY_CP_ENV_FILE=$WORK/etc/memory-cp.env MEMORY_CP_BUILD_USER='' MEMORY_CP_SERVER_USER='' \
    "$ROOT/deploy.sh"
}
live() { basename "$(readlink "$ROOT/current")"; }

say "1. a good commit is deployed and checked"
GOOD=$(git -C "$WORK/origin.git" rev-parse main)
deploy || fail "the good commit did not deploy"
[ "$(live)" = "$GOOD" ] || fail "current is $(live), not $GOOD"

say "2. a run with nothing new does nothing"
deploy || fail "a second run failed"
[ "$(live)" = "$GOOD" ] || fail "current moved to $(live)"

say "3. a commit whose server fails the check is rolled back"
# It builds, starts and answers 401, but every authorised request gets 500, so npm run e2e fails.
sed -i 's|// The token is the first thing a request meets.|if (tokenMatches(req.headers.authorization, options.token)) return reply(res, 500, "broken on purpose");|' \
  "$WORK/src/src/http.ts"
grep -q "broken on purpose" "$WORK/src/src/http.ts" || fail "could not make the bad commit"
commit -am "A server that fails its check"
git -C "$WORK/src" push --quiet "$WORK/origin.git" HEAD:refs/heads/main
BAD=$(git -C "$WORK/origin.git" rev-parse main)
if deploy; then fail "the bad commit deployed"; fi
[ "$(live)" = "$GOOD" ] || fail "current is $(live) after the rollback, not $GOOD"
[ "$(cat "$ROOT/failed-sha")" = "$BAD" ] || fail "failed-sha does not record $BAD"

say "4. the bad commit is not tried again until main moves"
deploy || fail "the run after a failure failed"
[ "$(live)" = "$GOOD" ] || fail "current moved to $(live)"

say "5. the restored release serves: npm run e2e against it"
# shellcheck disable=SC1091
(cd "$ROOT/current" && set -a && . "$WORK/etc/memory-cp.env" && set +a && npm run --silent e2e -- --url "$MEMORY_CP_PUBLIC_URL") \
  || fail "the restored release does not pass its check"

say "6. a run that ended before its check is undone by the next run"
# As if a run was killed between switching current and passing the check: current points at an unchecked release.
cp -a "$ROOT/releases/$GOOD" "$ROOT/releases/unchecked"
ln -sfn releases/unchecked "$ROOT/current"
deploy || fail "the run after an interrupted one failed"
[ "$(live)" = "$GOOD" ] || fail "current is $(live), not $GOOD"

say "7. a rollback that did not pass its check is tried again by the next run"
# As if a rollback's restart failed: current is live-sha, but rollback-pending says the rollback is not finished.
"$WORK/bin/systemctl" stop memory-cp
touch "$ROOT/rollback-pending"
deploy || fail "the run after an unfinished rollback failed"
[ -e "$ROOT/rollback-pending" ] && fail "rollback-pending is still there"
curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/mcp" | grep -qx 401 || fail "the restored release is not serving"

say "8. once main moves away from a failed sha and back, that sha is tried again"
git -C "$WORK/origin.git" update-ref refs/heads/main "$GOOD"
deploy || fail "the run with main back on the live sha failed"
[ -e "$ROOT/failed-sha" ] && fail "failed-sha was kept after main moved"
git -C "$WORK/origin.git" update-ref refs/heads/main "$BAD"
if deploy; then fail "the bad commit deployed the second time"; fi
[ "$(live)" = "$GOOD" ] || fail "current is $(live) after the second rollback, not $GOOD"
[ "$(cat "$ROOT/failed-sha")" = "$BAD" ] || fail "failed-sha does not record $BAD again"

[ -d "$ROOT/releases/$BAD" ] && fail "the failed release was kept"
grep -qF "$(grep TOKEN "$WORK/etc/memory-cp.env" | cut -d= -f2)" "$WORK/var/server.log" && fail "the server log has the token"
echo
echo "try-deploy: good $GOOD deployed; bad $BAD rolled back to it; all checks passed"
