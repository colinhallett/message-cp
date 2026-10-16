# Nightly database backup

`backup.sh` copies a consistent snapshot of the memory-cp database to an Oracle Object Storage bucket once a night, at 02:30 UTC. Restoring is in [restore.md](restore.md). Only the database is backed up.

- **Snapshot.** `VACUUM INTO`, SQLite's online copy, so the snapshot is one point in time while `serve` keeps writing. Copying the file of a database in WAL mode is not safe and is never done. The snapshot must pass `PRAGMA integrity_check` before it is uploaded.
- **Object.** `memory-cp-<UTC date>.sqlite.gz`, for example `memory-cp-2026-10-17.sqlite.gz`. A second run on the same day replaces that day's object. The bucket's lifecycle rule keeps 30 days.
- **Credential.** A pre-authenticated request (PAR) on the bucket that only allows object writes. It cannot list, read or delete backups, so a compromised server cannot destroy them. The server needs no OCI CLI or API key; the upload is `curl -T`.
- **Failure.** Any failure exits non-zero, so it shows in `journalctl -u memory-cp-backup` and `systemctl --failed`. The URL is never logged: it is passed to `curl` on stdin, not on its command line, and messages name the file it came from.
- **Local copy.** Built in a temporary directory that is deleted when the script exits, whether the upload worked or not.

## Install

Needs `sqlite3` (3.27 or later, for `VACUUM INTO`), `curl` and `gzip` on the server: `apt install sqlite3 curl`.

1. In the OCI console (or with the OCI CLI on the owner's machine, not the server), create the bucket, give it a lifecycle rule that deletes objects after 30 days, and create a pre-authenticated request with access type **Permit object writes** on the whole bucket. Its URL ends in `/o/`.
2. On the server, as root, store the URL where only root can read it:

   ```sh
   install -d -m 0700 /etc/memory-cp
   install -m 0600 /dev/null /etc/memory-cp/backup-url
   cat > /etc/memory-cp/backup-url   # paste the URL, then Ctrl-D
   ```

3. Install the script and units:

   ```sh
   install -m 0755 ops/backup.sh /usr/local/bin/memory-cp-backup
   install -m 0644 ops/memory-cp-backup.service ops/memory-cp-backup.timer /etc/systemd/system/
   ```

4. Run the backup as the account that runs `serve` and owns the database, with the same `MEMORY_CP_DB` if `serve` sets one. `systemctl edit memory-cp-backup.service` and add:

   ```ini
   [Service]
   User=memory-cp
   Environment=MEMORY_CP_DB=/var/lib/memory-cp/db.sqlite
   ```

   (Without `MEMORY_CP_DB` it backs up `~/.memory-cp/db.sqlite` of that user, as the server does.)
5. Enable the timer and run one backup now:

   ```sh
   systemctl daemon-reload
   systemctl enable --now memory-cp-backup.timer
   systemctl start memory-cp-backup.service
   journalctl -u memory-cp-backup -n 5    # memory-cp-backup: uploaded memory-cp-<date>.sqlite.gz (<n> bytes)
   ```

   Then check that the object is in the bucket. `systemctl list-timers memory-cp-backup.timer` shows the next run.

To run it by hand outside systemd, point it at the URL file: `MEMORY_CP_BACKUP_URL_FILE=/path/to/url ops/backup.sh`.
