#!/usr/bin/env bash
# Deploys the newest commit on origin/main and rolls it back if it fails its check.
#
# Run as root by memory-cp-deploy.service (memory-cp-deploy.timer starts it every two minutes). One run:
#   1. fetches origin/main into $ROOT/repo.git (a bare clone; it only fetches, never pushes);
#   2. stops if that sha is the live release or the last one that failed;
#   3. builds it in $ROOT/releases/<sha> (npm ci, npm run build) as $BUILD_USER, which never sees the token;
#   4. points the $ROOT/current symlink at it and restarts memory-cp.service;
#   5. runs the release's `npm run e2e -- --url <public URL>` as $SERVER_USER, with the token in its environment only;
#   6. records the sha in $ROOT/live-sha once that passes; on any failure, records its sha in $ROOT/failed-sha so it
#      is not tried again until main moves, points current back at the previous release, restarts and checks it,
#      and deletes the failed release.
# A rollback is finished only once the restored release passes its check; until then $ROOT/rollback-pending exists.
# A run that ends between 4 and 6 (a reboot, a timeout), or a rollback whose restart or check failed, leaves current
# pointing past live-sha or rollback-pending in place; the next run restores live-sha first, then deploys main.
# failed-sha holds back only an unchanged main: a run that sees main elsewhere removes it.
# It keeps the five releases that went live most recently. The database and /etc/memory-cp.env are never inside
# $ROOT/releases and nothing here writes them. Everything it prints goes to the journal; it never prints the token.
set -euo pipefail
umask 022

ROOT=${MEMORY_CP_ROOT:-/opt/memory-cp}
ENV_FILE=${MEMORY_CP_ENV_FILE:-/etc/memory-cp.env}
SERVICE=${MEMORY_CP_SERVICE:-memory-cp}
# Builds run as BUILD_USER, so dependencies' install scripts cannot read the server's token or database; the check
# runs as SERVER_USER, which already holds both. Empty runs that step as the caller (only for try-deploy.sh).
BUILD_USER=${MEMORY_CP_BUILD_USER-memory-cp-build}
SERVER_USER=${MEMORY_CP_SERVER_USER-memory-cp}
KEEP=5
READY_SECONDS=60

log() { echo "deploy: $*"; }

mkdir -p "$ROOT/releases" "$ROOT/build-home" "$ROOT/check-home"

# One run at a time: a run that finds another in progress leaves it alone.
exec 9>"$ROOT/deploy.lock"
if ! flock -n 9; then
  log "another deploy is running; nothing to do"
  exit 0
fi

# Prints the value of KEY in the systemd environment file, without sourcing it.
env_value() {
  local line
  line=$(grep -E "^[[:space:]]*$1=" "$ENV_FILE" | tail -n 1) || return 0
  line=${line#*=}
  line=${line%\"}; line=${line#\"}
  line=${line%\'}; line=${line#\'}
  printf '%s' "$line"
}

# `as_user <user> <home> cmd...` runs cmd as <user> with only PATH, HOME, the npm cache and, if the caller set it,
# MEMORY_CP_HTTP_TOKEN in its environment. The token travels in the environment, never in an argument list.
as_user() (
  user=$1 home=$2 token=${MEMORY_CP_HTTP_TOKEN-} path=$PATH
  shift 2
  while read -r name; do unset "$name" 2>/dev/null || true; done < <(compgen -e)
  export PATH=$path HOME=$home npm_config_cache=$home/.npm
  if [ -n "$token" ]; then export MEMORY_CP_HTTP_TOKEN=$token; fi
  if [ -n "$user" ]; then
    exec setpriv --reuid="$user" --regid="$user" --init-groups -- "$@"
  fi
  exec "$@"
)

# Points current at releases/<sha> by renaming a new symlink over it, so it is never missing or half-written.
switch_to() {
  ln -sfn "releases/$1" "$ROOT/current.new"
  mv -T "$ROOT/current.new" "$ROOT/current"
}

# Waits until the public URL answers /mcp with 401 (the server is up and wants the token).
wait_ready() {
  local i code
  for ((i = 0; i < READY_SECONDS; i++)); do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$PUBLIC_URL/mcp" || true)
    [ "$code" = 401 ] && return 0
    sleep 1
  done
  log "$PUBLIC_URL/mcp did not answer 401 within ${READY_SECONDS}s (last status: ${code:-none})"
  return 1
}

# Writes <value> to $ROOT/<file> by renaming, so a run killed mid-write leaves the old value or the new one.
write_state() {
  echo "$2" >"$ROOT/$1.new"
  mv -T "$ROOT/$1.new" "$ROOT/$1"
}

# Runs release <sha>'s end-to-end check against the public URL. The token goes in its environment only.
check() {
  wait_ready || return 1
  (cd "$ROOT/releases/$1" && MEMORY_CP_HTTP_TOKEN=$TOKEN as_user "$SERVER_USER" "$ROOT/check-home" \
    npm run --silent e2e -- --url "$PUBLIC_URL")
}

TOKEN=$(env_value MEMORY_CP_HTTP_TOKEN)
PUBLIC_URL=$(env_value MEMORY_CP_PUBLIC_URL)
PUBLIC_URL=${PUBLIC_URL%/}
if [ -z "$TOKEN" ] || [ -z "$PUBLIC_URL" ]; then
  log "$ENV_FILE must set MEMORY_CP_HTTP_TOKEN and MEMORY_CP_PUBLIC_URL"
  exit 1
fi
case "$(env_value MEMORY_CP_DB)" in
  "$ROOT"/releases/* | "$ROOT"/current/*)
    log "MEMORY_CP_DB must be outside $ROOT/releases: a release directory is replaced and deleted"
    exit 1
    ;;
esac

if [ -n "$BUILD_USER" ]; then chown "$BUILD_USER:" "$ROOT/build-home"; fi
if [ -n "$SERVER_USER" ]; then chown "$SERVER_USER:" "$ROOT/check-home"; fi
# A build that an earlier run did not finish (power loss, timeout) is left as releases/.<sha>.build.
rm -rf "$ROOT"/releases/.*.build

git --git-dir="$ROOT/repo.git" fetch --quiet origin +refs/heads/main:refs/remotes/origin/main
SHA=$(git --git-dir="$ROOT/repo.git" rev-parse --verify 'refs/remotes/origin/main^{commit}')
LIVE=$(cat "$ROOT/live-sha" 2>/dev/null || true)
FAILED=$(cat "$ROOT/failed-sha" 2>/dev/null || true)
CURRENT=$(basename "$(readlink "$ROOT/current" 2>/dev/null || true)")

# Points current back at $LIVE, restarts it and checks it. rollback-pending stays until that check passes, so a
# rollback that was interrupted or whose restart or check failed is tried again by the next run.
restore_live() {
  touch "$ROOT/rollback-pending"
  switch_to "$LIVE"
  systemctl restart "$SERVICE" || log "systemctl restart $SERVICE failed"
  if check "$LIVE"; then
    rm -f "$ROOT/rollback-pending"
    log "$LIVE is serving again and passes its check"
  else
    log "$LIVE is restored but does not pass its check; the next run tries again"
    return 1
  fi
}

RESTORED=ok
# An earlier run switched current but never finished its check, or did not finish a rollback: put back the release
# that passed one.
if [ "$CURRENT" != "$LIVE" ] || [ -e "$ROOT/rollback-pending" ]; then
  if [ -n "$LIVE" ] && [ -d "$ROOT/releases/$LIVE" ]; then
    log "current is $CURRENT and live-sha is $LIVE, and no check has passed since; restoring $LIVE"
    restore_live || RESTORED=failed
  elif [ -L "$ROOT/current" ]; then
    log "current is $CURRENT, which was never checked, and nothing has passed a check; stopping $SERVICE"
    rm "$ROOT/current"
    systemctl stop "$SERVICE"
    rm -f "$ROOT/rollback-pending"
  else
    rm -f "$ROOT/rollback-pending"
  fi
fi

if [ "$SHA" = "$FAILED" ]; then
  log "origin/main is still $SHA, which failed; waiting for main to move"
  [ "$RESTORED" = ok ] || exit 1
  exit 0
fi
# main has moved since that failure, so the failure no longer holds back its sha if main comes back to it.
rm -f "$ROOT/failed-sha"
if [ "$SHA" = "$LIVE" ]; then
  [ "$RESTORED" = ok ] || exit 1
  exit 0
fi

log "deploying $SHA (live: ${LIVE:-none})"

fail() {
  log "$SHA failed: $1"
  write_state failed-sha "$SHA"
  if [ -n "$LIVE" ] && [ -d "$ROOT/releases/$LIVE" ]; then
    if [ "$(basename "$(readlink "$ROOT/current")")" != "$LIVE" ] || [ -e "$ROOT/rollback-pending" ]; then
      log "rolling back to $LIVE"
      restore_live || true
    fi
  elif [ -L "$ROOT/current" ]; then
    log "no earlier release to roll back to; stopping $SERVICE"
    rm "$ROOT/current"
    systemctl stop "$SERVICE" || log "systemctl stop $SERVICE failed"
  fi
  # A failed release is never live again, so it does not take one of the $KEEP places.
  rm -rf "${ROOT:?}/releases/$SHA"
  exit 1
}

RELEASE=$ROOT/releases/$SHA

# A release is only ever renamed into releases/<sha> once it is fully built.
if [ ! -d "$RELEASE" ]; then
  BUILD=$ROOT/releases/.$SHA.build
  mkdir "$BUILD"
  git --git-dir="$ROOT/repo.git" archive "$SHA" | tar -x -C "$BUILD"
  if [ -n "$BUILD_USER" ]; then chown -R "$BUILD_USER:" "$BUILD"; fi
  (cd "$BUILD" && as_user "$BUILD_USER" "$ROOT/build-home" npm ci --no-audit --no-fund) || { rm -rf "$BUILD"; fail "npm ci"; }
  (cd "$BUILD" && as_user "$BUILD_USER" "$ROOT/build-home" npm run build) || { rm -rf "$BUILD"; fail "npm run build"; }
  # Neither the server nor the next build can change a built release.
  if [ -n "$BUILD_USER" ]; then chown -R root:root "$BUILD"; fi
  mv -T "$BUILD" "$RELEASE"
fi

switch_to "$SHA"
systemctl restart "$SERVICE" || fail "systemctl restart $SERVICE"
check "$SHA" || fail "npm run e2e against $PUBLIC_URL"
write_state live-sha "$SHA"
rm -f "$ROOT/rollback-pending"
log "$SHA is live and passes its check"

# Keep the $KEEP releases that went live most recently (one that goes live again counts as new).
touch "$RELEASE"
# shellcheck disable=SC2012 # release names are hex shas
ls -1t "$ROOT/releases" | tail -n +$((KEEP + 1)) | while read -r old; do
  [ "$old" = "$SHA" ] || rm -rf "${ROOT:?}/releases/$old"
done
