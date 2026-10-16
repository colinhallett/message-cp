#!/usr/bin/env bash
# Nightly backup of the memory-cp database to object storage. See ops/README.md to install, ops/restore.md to restore.
#
# Takes a consistent snapshot with VACUUM INTO (safe while serve is writing; a plain copy of a WAL database is not),
# checks it, gzips it to memory-cp-<UTC date>.sqlite.gz and PUTs it to a write-only pre-authenticated request URL.
# The local copy is always deleted. Any failure exits non-zero. The upload URL is never printed or put on a command line.
#
# Environment:
#   MEMORY_CP_DB                 database to back up, else ~/.memory-cp/db.sqlite (the server's own default)
#   MEMORY_CP_BACKUP_URL_FILE    file holding the bucket's write URL (ending in /o/), else $CREDENTIALS_DIRECTORY/backup-url,
#                                which is where the systemd unit's LoadCredential= puts it
set -euo pipefail

say() { echo "memory-cp-backup: $*" >&2; }
fail() { say "$*"; exit 1; }

for tool in sqlite3 gzip curl; do
  command -v "$tool" >/dev/null || fail "$tool is not installed"
done

[ -n "${MEMORY_CP_DB:-}" ] || [ -n "${HOME:-}" ] || fail "set MEMORY_CP_DB, or User= in the unit so HOME is set"
db="${MEMORY_CP_DB:-$HOME/.memory-cp/db.sqlite}"
[ -f "$db" ] || fail "no database at $db"
# Run as the database's owner: sqlite3 may create the -wal and -shm files, and ones owned by another user lock the server out.
[ -O "$db" ] || fail "run as the user that owns $db"

if [ -n "${MEMORY_CP_BACKUP_URL_FILE:-}" ]; then
  url_file="$MEMORY_CP_BACKUP_URL_FILE"
elif [ -n "${CREDENTIALS_DIRECTORY:-}" ]; then
  url_file="$CREDENTIALS_DIRECTORY/backup-url"
else
  fail "set MEMORY_CP_BACKUP_URL_FILE, or run from memory-cp-backup.service"
fi
[ -r "$url_file" ] || fail "cannot read the upload URL file $url_file"
url="$(tr -d '[:space:]' <"$url_file")"
# Checked so it can go into curl's config safely: a plain host name (no userinfo), an optional port, and a path ending in /o/ with no query or fragment.
# The message names the file, never the URL.
# Plain http is allowed only to this machine, for testing: the URL's path is the credential.
[[ "$url" =~ ^(https://[A-Za-z0-9.-]+|http://(127\.0\.0\.1|localhost))(:[0-9]+)?/([^\"\\?#]*/)?o/$ ]] ||
  fail "$url_file must hold one https URL ending in /o/"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
name="memory-cp-$(date -u +%F).sqlite.gz"
snap="$work/snapshot.sqlite"

# VACUUM INTO reads the database in one read transaction, so writers carry on and the snapshot is one point in time.
sqlite3 -bail "$db" ".timeout 10000" "VACUUM INTO '$snap';" || fail "snapshot of $db failed"
check="$(sqlite3 -bail "$snap" "PRAGMA integrity_check;")" || fail "integrity check of the snapshot failed"
[ "$check" = "ok" ] || fail "snapshot failed its integrity check: $check"

gzip -9 -c "$snap" >"$work/$name"
size="$(wc -c <"$work/$name")"

# The URL reaches curl on stdin as config, so it is not in the process list; curl's own errors do not print the URL (its path is the credential).
printf 'url = "%s%s"\n' "$url" "$name" |
  curl --config - --silent --show-error --fail --retry 3 --max-time 600 --upload-file "$work/$name" --output /dev/null ||
  fail "upload of $name failed"

say "uploaded $name ($size bytes)"
