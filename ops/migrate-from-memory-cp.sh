#!/usr/bin/env bash
# Moves a server installed by the old ops/ (memory-cp names) to the message-cp names. See ops/migrate-from-memory-cp.md.
#
#   ops/migrate-from-memory-cp.sh move <new backup URL file>   as root, from a checkout of this repository
#   ops/migrate-from-memory-cp.sh check                       lists anything still named memory-cp; exits 1 if some is in use
#   ops/migrate-from-memory-cp.sh undo                        puts the old names back, if a move stopped part-way
#
# Nothing is deleted: every old file and directory is renamed aside to <path>.pre-message-cp, and undo renames it back.
# Nothing it prints holds a token, a key or a URL: env files are rewritten with sed, never printed, and the backup URL
# file is copied, never read.
set -Eeuo pipefail
umask 077

OLD=memory-cp NEW=message-cp ASIDE=.pre-message-cp
SRC=$(cd "$(dirname "$0")/.." && pwd)
UNITS=/etc/systemd/system
LIB=/var/lib/$NEW

say() { echo "migrate: $*"; }
fail() { say "$*"; exit 1; }
[ "$(id -u)" = 0 ] || fail "run as root"

# The paths the old ops/ created, each renamed to the same path with memory-cp replaced by message-cp.
# The timer stamps are systemd's record of the last run, which Persistent=true reads.
PATHS=(/opt/$OLD /var/lib/$OLD /etc/$OLD.env /etc/$OLD /usr/local/bin/$OLD-backup /root/.ssh/$OLD-deploy /root/.ssh/$OLD-deploy.pub
  /var/lib/systemd/timers/stamp-$OLD-backup.timer /var/lib/systemd/timers/stamp-$OLD-deploy.timer)
OLD_UNITS=($OLD.service $OLD-deploy.service $OLD-deploy.timer $OLD-backup.service $OLD-backup.timer)
new_name() { echo "${1//$OLD/$NEW}"; }

# Prints the value of KEY in an environment file, as deploy.sh reads it, without sourcing or printing the file.
env_value() {
  local line
  line=$(grep -E "^[[:space:]]*$2=" "$1" | tail -n 1) || return 0
  line=${line#*=}; line=${line%\"}; line=${line#\"}; line=${line%\'}; line=${line#\'}
  printf '%s' "$line"
}

# Stops the old units, so nothing writes the database or /opt while files move. The deploy timer goes first, so no
# new run starts; flock then waits for a run already under way to finish, and holding the lock keeps out one started
# by hand. The old deploy.sh is then renamed aside (keeping its mode), so no run can start at all, however it is
# invoked, and any run that started before that but had not yet reached the lock (it exits there) is waited out: once
# step 3 sets /opt/memory-cp aside, the lock held is on the file set aside, and a run reaching deploy.sh's mkdir then
# would recreate /opt/memory-cp.
# Nothing is copied unless every old unit has stopped and nothing runs as the server's user.
# No message-cp deploy can start until step 7 enables its timer.
stop_old() {
  local u i state
  for u in $OLD-deploy.timer $OLD-backup.timer; do systemctl disable --now $u 2>/dev/null || true; done
  if [ -d /opt/$OLD ]; then
    exec 9>/opt/$OLD/deploy.lock
    say "waiting for any deploy run under way to finish"
    flock 9
  fi
  # A unit that does not exist cannot be stopped; whether each one has stopped is checked below.
  for u in $OLD-deploy.service $OLD-backup.service $OLD.service; do systemctl stop $u 2>/dev/null || true; done
  systemctl disable $OLD.service 2>/dev/null || true
  if [ -f /opt/$OLD/deploy.sh ]; then mv -T /opt/$OLD/deploy.sh /opt/$OLD/deploy.sh$ASIDE; fi
  for ((i = 0; i < 30; i++)); do
    pgrep -f "/opt/$OLD/deploy.sh" >/dev/null || break
    sleep 1
  done
  if pgrep -f "/opt/$OLD/deploy.sh" >/dev/null; then
    fail "a deploy run of /opt/$OLD/deploy.sh is still running; nothing was copied. Run '$0 undo' to start the old server again"
  fi
  for u in $OLD-deploy.service $OLD-backup.service $OLD.service; do
    state=$(systemctl show -p ActiveState --value $u 2>/dev/null || true)
    case "$state" in
      "" | inactive | failed) ;;
      *) fail "$u is still $state after systemctl stop; nothing was copied. Run '$0 undo' to start the old server again" ;;
    esac
  done
  if pgrep -u $OLD >/dev/null; then
    fail "processes still run as $OLD (a stdio server, say: pgrep -u $OLD -a); nothing was copied. Stop them and run '$0 undo', then move again"
  fi
}

move() {
  local url_file=${1:-} p n q origin
  [ -n "$url_file" ] || fail "usage: $0 move <file holding the message-cp-backups bucket's write URL>"
  [ -f "$url_file" ] && [ -s "$url_file" ] || fail "$url_file is missing or empty"
  [ "$(stat -c %u:%g:%a "$url_file")" = 0:0:600 ] || fail "$url_file must be root:root and mode 0600"
  [ -d /opt/$OLD ] && [ -f /etc/$OLD.env ] || fail "no /opt/$OLD and /etc/$OLD.env: is this a server installed by the old ops/?"
  # A leftover .partial copy from an earlier attempt would make cp -a nest the new copy inside it.
  for p in "${PATHS[@]}" "${OLD_UNITS[@]/#/$UNITS/}"; do
    n=$(new_name "$p")
    for q in "$n" "$n.partial" "$n.d" "$p$ASIDE"; do
      if [ -e "$q" ]; then fail "$q exists already; nothing was changed"; fi
    done
  done
  if [ -e /opt/$OLD/deploy.sh$ASIDE ]; then fail "/opt/$OLD/deploy.sh$ASIDE exists already; nothing was changed"; fi
  # Every old path is copied once, so the file systems holding them need that much free.
  local need=0 have
  for p in /opt/$OLD /var/lib/$OLD; do
    need=$(du -sk "$p" | cut -f1)
    have=$(df -Pk "$p" | awk 'NR == 2 { print $4 }')
    [ "$have" -gt $((need + need / 10)) ] || fail "$p needs $((need / 1024)) MiB free beside it to be copied; $((have / 1024)) MiB is"
  done
  for u in $NEW $NEW-build; do
    if getent passwd $u >/dev/null || getent group $u >/dev/null; then fail "user or group $u exists already; nothing was changed"; fi
  done
  getent passwd $OLD >/dev/null || fail "no user $OLD"
  # The new env file and units set only MESSAGE_CP_*, which the live release and any rollback target must read.
  local live
  live=$(cat /opt/$OLD/live-sha 2>/dev/null || true)
  [ -n "$live" ] && [ -f /opt/$OLD/releases/$live/dist/settings.js ] &&
    grep -q MESSAGE_CP_ /opt/$OLD/releases/$live/dist/settings.js ||
    fail "the live release (${live:-none}) does not read MESSAGE_CP_*; let a release from after the package rename go live first"

  # From here on a failure leaves the install half-moved: say how to put it back.
  trap 'say "the move stopped part-way; run \"$0 undo\" to put the old names back, then look at what failed"' ERR

  say "1/7 stopping the old units and holding the deploy lock"
  stop_old

  say "2/7 renaming users $OLD and $OLD-build (same uid and gid, so file ownership is unchanged)"
  local home
  home=$(getent passwd $OLD | cut -d: -f6)
  usermod -l $NEW $OLD
  groupmod -n $NEW $OLD
  if [ "$home" = /var/lib/$OLD ]; then usermod -d "$LIB" $NEW; fi
  if getent passwd $OLD-build >/dev/null; then
    usermod -l $NEW-build $OLD-build
    if getent group $OLD-build >/dev/null; then groupmod -n $NEW-build $OLD-build; fi
  fi

  say "3/7 copying each old path to its new name, then setting the old one aside as *$ASIDE"
  # The copy keeps owners, modes and timestamps, and is taken with everything stopped, so the database and its WAL
  # are copied together at rest. The old path is renamed aside only once its copy is complete.
  for p in "${PATHS[@]}"; do
    [ -e "$p" ] || continue
    n=$(new_name "$p")
    cp -a "$p" "$n.partial"
    mv -T "$n.partial" "$n"
    mv -T "$p" "$p$ASIDE"
  done
  # The lock held since step 1 is on the file now set aside; take the new one too, so a message-cp deploy started by
  # hand before step 7 waits.
  exec 8>/opt/$NEW/deploy.lock
  flock 8
  # current is a relative link (releases/<sha>), so it points into the copy. Without MEMORY_CP_DB the database was
  # ~/.memory-cp/db.sqlite in the server's home; its copy takes the new default name.
  if [ -d "$LIB/.$OLD" ] && [ ! -e "$LIB/.$NEW" ]; then mv -T "$LIB/.$OLD" "$LIB/.$NEW"; fi

  say "4/7 rewriting names inside the copies"
  # MEMORY_CP_X= becomes MESSAGE_CP_X=, and /var/lib/memory-cp paths in values become /var/lib/message-cp. Values are
  # never printed. The token, URL and anything else keep their values.
  sed -i -E "s/^([[:space:]]*)MEMORY_CP_/\1MESSAGE_CP_/; s#/var/lib/$OLD(/|\$)#/var/lib/$NEW\1#g; s#/opt/$OLD(/|\$)#/opt/$NEW\1#g" /etc/$NEW.env
  chown root:root /etc/$NEW.env
  chmod 600 /etc/$NEW.env
  # repo.git fetches with the deploy key named in its config; ~/.ssh/config may name it too.
  if [ -d /opt/$NEW/repo.git ]; then
    git --git-dir=/opt/$NEW/repo.git config core.sshCommand "ssh -i /root/.ssh/$NEW-deploy -o IdentitiesOnly=yes"
    # GitHub serves a renamed repository at its old URL too, so this changes the name only.
    origin=$(git --git-dir=/opt/$NEW/repo.git remote get-url origin)
    git --git-dir=/opt/$NEW/repo.git remote set-url origin "${origin/\/$OLD.git/\/$NEW.git}"
  fi
  if [ -f /root/.ssh/config ] && grep -q "$OLD-deploy" /root/.ssh/config; then
    cp -a /root/.ssh/config /root/.ssh/config$ASIDE
    sed -i "s#/root/.ssh/$OLD-deploy#/root/.ssh/$NEW-deploy#g; s#~/.ssh/$OLD-deploy#~/.ssh/$NEW-deploy#g" /root/.ssh/config
  fi
  # The new bucket's write URL replaces the old one; the old file stays in /etc/memory-cp.pre-message-cp.
  install -m 0700 -d /etc/$NEW
  install -m 0600 -o root -g root "$url_file" /etc/$NEW/backup-url

  say "5/7 installing the new deploy and backup scripts; carrying the units and their drop-ins over"
  install -m 0755 "$SRC/ops/deploy.sh" /opt/$NEW/deploy.sh
  install -m 0755 "$SRC/ops/backup.sh" /usr/local/bin/$NEW-backup
  local u
  for u in "${OLD_UNITS[@]}"; do
    # The old unit, with its names rewritten, so any edit made to it (a port, node's path) is kept; a unit the old
    # install never had (the backup, when it was not set up) comes from this checkout.
    if [ -f "$UNITS/$u" ]; then
      sed -E "s/MEMORY_CP_/MESSAGE_CP_/g; s/$OLD/$NEW/g" "$UNITS/$u" >"$UNITS/$(new_name "$u")"
      chmod 644 "$UNITS/$(new_name "$u")"
    else
      install -m 0644 "$SRC/ops/$(new_name "$u")" $UNITS/
    fi
    # A drop-in (systemctl edit) names the old user and MEMORY_CP_DB, such as the backup unit's User= and database.
    if [ -d "$UNITS/$u.d" ]; then
      cp -a "$UNITS/$u.d" "$UNITS/$(new_name "$u").d"
      sed -i -E "s/MEMORY_CP_/MESSAGE_CP_/g; s/$OLD/$NEW/g" "$UNITS/$(new_name "$u")".d/*.conf
      mv -T "$UNITS/$u.d" "$UNITS/$u.d$ASIDE"
    fi
    if [ -e "$UNITS/$u" ]; then mv -T "$UNITS/$u" "$UNITS/$u$ASIDE"; fi
  done
  # backup.sh must run as the database's owner; an install that never had the backup has no drop-in to carry over.
  if [ ! -d $UNITS/$NEW-backup.service.d ]; then
    mkdir -p $UNITS/$NEW-backup.service.d
    local db
    db=$(env_value /etc/$NEW.env MESSAGE_CP_DB)
    {
      echo "[Service]"
      echo "User=$NEW"
      if [ -n "$db" ]; then echo "Environment=MESSAGE_CP_DB=$db"; fi
    } >$UNITS/$NEW-backup.service.d/override.conf
    chmod 644 $UNITS/$NEW-backup.service.d/override.conf
  fi
  systemctl daemon-reload
  # A failed old unit stays listed until this, even with its file renamed aside.
  systemctl reset-failed "$OLD*" "$NEW*" 2>/dev/null || true

  say "6/7 starting $NEW.service and checking it"
  # The server creates an empty database where none is, and that would pass the check below; make sure it is there.
  local db_file
  db_file=$(env_value /etc/$NEW.env MESSAGE_CP_DB)
  db_file=${db_file:-$LIB/.$NEW/db.sqlite}
  [ -s "$db_file" ] || fail "no database at $db_file, where $NEW.service will look; run '$0 undo'"
  systemctl enable $NEW.service
  systemctl start $NEW.service
  local url token
  url=$(env_value /etc/$NEW.env MESSAGE_CP_PUBLIC_URL)
  token=$(env_value /etc/$NEW.env MESSAGE_CP_HTTP_TOKEN)
  [ -n "$url" ] && [ -n "$token" ] || fail "/etc/$NEW.env has no MESSAGE_CP_PUBLIC_URL or MESSAGE_CP_HTTP_TOKEN; run '$0 undo'"
  local i code=
  for ((i = 0; i < 60; i++)); do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "${url%/}/mcp" || true)
    [ "$code" = 401 ] && break
    sleep 1
  done
  [ "$code" = 401 ] || fail "${url%/}/mcp did not answer 401 (last status: ${code:-none}); run '$0 undo'"
  # The check runs as the server's user from the live release, as deploy.sh's does. The token is exported, never put in
  # an argument list, and the rest of root's environment is dropped first.
  (
    path=$PATH
    cd /opt/$NEW/current
    while read -r name; do unset "$name" 2>/dev/null || true; done < <(compgen -e)
    export PATH=$path HOME=/opt/$NEW/check-home npm_config_cache=/opt/$NEW/check-home/.npm MESSAGE_CP_HTTP_TOKEN=$token
    exec setpriv --reuid=$NEW --regid=$NEW --init-groups -- npm run --silent e2e -- --url "$url"
  ) || fail "npm run e2e against $url failed; run '$0 undo'"

  say "7/7 running one backup, then enabling the backup and deploy timers"
  systemctl start $NEW-backup.service ||
    fail "the server is moved and serving, but the first backup failed: see journalctl -u $NEW-backup and ops/migrate-from-memory-cp.md; the timers are still off"
  systemctl enable --now $NEW-backup.timer
  exec 8>&- 9>&-
  systemctl enable --now $NEW-deploy.timer
  say "done. The old files are kept as *$ASIDE; run '$0 check' for anything still named $OLD."
}

# Puts the old names back, after a move that stopped part-way or whose new install misbehaves. The database, /opt
# (live-sha, releases) and the env file go back from their new copies, since the new server may have written them
# since; the copies taken before the move are kept as *.pre-message-cp.undone-<time>. Everything else (the backup URL,
# the deploy key, units) goes back from what was set aside. Nothing is deleted except the new units it installed.
undo() {
  local p n u stamp
  stamp=$(date -u +%FT%H%M%S)
  trap 'say "undo stopped part-way; fix what failed and run \"$0 undo\" again: it carries on from where it stopped"' ERR
  for u in $NEW-deploy.timer $NEW-backup.timer; do systemctl disable --now $u 2>/dev/null || true; done
  if [ -d /opt/$NEW ]; then exec 9>/opt/$NEW/deploy.lock; flock 9; fi
  for u in $NEW-deploy.service $NEW-backup.service $NEW.service; do systemctl stop $u 2>/dev/null || true; done
  systemctl disable $NEW.service 2>/dev/null || true
  for p in "${PATHS[@]}"; do
    n=$(new_name "$p")
    # The move stopped between copying this path and setting it aside: the old path is the one the server used.
    if [ -e "$p" ] && [ ! -e "$p$ASIDE" ]; then
      if [ -e "$n" ]; then mv -T "$n" "$n.undone-$stamp"; fi
      if [ -e "$n.partial" ]; then mv -T "$n.partial" "$n.partial.undone-$stamp"; fi
      continue
    fi
    # Both the old path and its copy set aside: something recreated the old path after the move set it aside.
    if [ -e "$p" ]; then mv -T "$p" "$p.recreated-$stamp"; fi
    case "$p" in
      /opt/$OLD | /var/lib/$OLD | /etc/$OLD.env)
        # A copy the move did not finish holds nothing the old path does not.
        if [ -e "$n.partial" ]; then mv -T "$n.partial" "$n.partial.undone-$stamp"; fi
        if [ -e "$n" ] && [ -e "$p$ASIDE" ]; then mv -T "$p$ASIDE" "$p$ASIDE.undone-$stamp"; fi
        if [ -e "$n" ]; then mv -T "$n" "$p"; elif [ -e "$p$ASIDE" ]; then mv -T "$p$ASIDE" "$p"; fi
        ;;
      *)
        if [ -e "$n.partial" ]; then mv -T "$n.partial" "$n.partial.undone-$stamp"; fi
        if [ -e "$n" ] && [ -e "$p$ASIDE" ]; then mv -T "$n" "$n.undone-$stamp"; fi
        if [ -e "$p$ASIDE" ]; then mv -T "$p$ASIDE" "$p"; elif [ -e "$n" ]; then mv -T "$n" "$p"; fi
        ;;
    esac
  done
  if [ -d /var/lib/$OLD/.$NEW ] && [ ! -e /var/lib/$OLD/.$OLD ]; then mv -T /var/lib/$OLD/.$NEW /var/lib/$OLD/.$OLD; fi
  if [ -f /etc/$OLD.env ]; then
    sed -i -E "s/^([[:space:]]*)MESSAGE_CP_/\1MEMORY_CP_/; s#/var/lib/$NEW(/|\$)#/var/lib/$OLD\1#g; s#/opt/$NEW(/|\$)#/opt/$OLD\1#g" /etc/$OLD.env
  fi
  if [ -d /opt/$OLD/repo.git ]; then
    git --git-dir=/opt/$OLD/repo.git config core.sshCommand "ssh -i /root/.ssh/$OLD-deploy -o IdentitiesOnly=yes"
  fi
  # Step 1 set the old deploy.sh aside in /opt/memory-cp, and that went into the copy; step 5 put the new one beside it.
  if [ -f /opt/$OLD/deploy.sh$ASIDE ]; then mv -T /opt/$OLD/deploy.sh$ASIDE /opt/$OLD/deploy.sh; fi
  if [ -e /root/.ssh/config$ASIDE ]; then mv -T /root/.ssh/config$ASIDE /root/.ssh/config; fi
  for u in "${OLD_UNITS[@]}"; do
    rm -f "$UNITS/$(new_name "$u")"
    # A drop-in may hold an edit made since the move, so it is kept, renamed aside.
    if [ -e "$UNITS/$(new_name "$u").d" ]; then mv -T "$UNITS/$(new_name "$u").d" "$UNITS/$(new_name "$u").d.undone-$stamp"; fi
    if [ -e "$UNITS/$u$ASIDE" ]; then mv -T "$UNITS/$u$ASIDE" "$UNITS/$u"; fi
    if [ -e "$UNITS/$u.d$ASIDE" ]; then mv -T "$UNITS/$u.d$ASIDE" "$UNITS/$u.d"; fi
  done
  if getent passwd $NEW >/dev/null; then
    usermod -l $OLD $NEW
    groupmod -n $OLD $NEW
    if [ "$(getent passwd $OLD | cut -d: -f6)" = "$LIB" ]; then usermod -d /var/lib/$OLD $OLD; fi
  fi
  if getent passwd $NEW-build >/dev/null; then
    usermod -l $OLD-build $NEW-build
    if getent group $NEW-build >/dev/null; then groupmod -n $OLD-build $NEW-build; fi
  fi
  systemctl daemon-reload
  systemctl reset-failed "$OLD*" "$NEW*" 2>/dev/null || true
  systemctl enable --now $OLD.service
  # The timers are left off: start them once the old server is checked (see ops/migrate-from-memory-cp.md).
  exec 9>&-
  say "the old names are back and $OLD.service is started; the deploy and backup timers are off"
}

# Lists what is still named memory-cp. The *.pre-message-cp copies kept aside and the source of older releases are
# expected; anything else, a memory-cp unit systemd still knows, or a memory-cp user makes it exit 1.
check() {
  local bad=0 f u
  say "files named *$OLD* on the root file system:"
  while IFS= read -r f; do
    case "$f" in
      *"$ASIDE" | *"$ASIDE"/*) echo "  kept aside: $f" ;;
      */migrate-from-$OLD.*) ;; # this procedure, in a checkout or a release
      /opt/$NEW/releases/*) echo "  in an older release's source (goes when the release ages out): $f" ;;

      *) echo "  STILL IN USE: $f"; bad=1 ;;
    esac
  done < <(find / -xdev -name "*$OLD*" -not -path '/proc/*' -prune 2>/dev/null)
  say "systemd units named *$OLD*:"
  if systemctl list-units --all --no-legend "*$OLD*" | grep -q .; then
    systemctl list-units --all --no-legend "*$OLD*"
    bad=1
  else
    echo "  none"
  fi
  for u in $OLD $OLD-build; do
    if getent passwd $u >/dev/null || getent group $u >/dev/null; then echo "  STILL IN USE: user or group $u"; bad=1; fi
  done
  return $bad
}

case "${1:-}" in
  move) move "${2:-}" ;;
  undo) undo ;;
  check) check ;;
  *) fail "usage: $0 move <new backup URL file> | check | undo" ;;
esac
