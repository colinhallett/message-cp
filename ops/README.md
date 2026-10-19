# Operations

- **Deploys.** The server deploys `main` itself and rolls back a release that fails its check: see [deploy.md](deploy.md).
- **Backups.** Below, and restoring in [restore.md](restore.md).
- **Moving from the old names.** A server installed by `ops/` before the rename to message-cp: [migrate-from-memory-cp.md](migrate-from-memory-cp.md).

## Nightly database backup

`backup.sh` copies a consistent snapshot of the message-cp database to an Oracle Object Storage bucket once a night, at 02:30 UTC. Restoring is in [restore.md](restore.md). Only the database is backed up.

- **Snapshot.** `VACUUM INTO`, SQLite's online copy, so the snapshot is one point in time while `serve` keeps writing. Copying the file of a database in WAL mode is not safe and is never done. The snapshot must pass `PRAGMA integrity_check` before it is uploaded.
- **Object.** `message-cp-<UTC date>.sqlite.gz`, for example `message-cp-2026-10-17.sqlite.gz`. A second run on the same day writes a new version of that day's object. The bucket's lifecycle rules keep 30 days.
- **Credential.** A pre-authenticated request (PAR) on the bucket that only allows object writes. It cannot list, read or delete backups. It can overwrite an object, so the bucket keeps object versions: an overwrite adds a version and the earlier ones stay. The server needs no OCI CLI or API key; the upload is `curl -T`.
- **Failure.** Any failure exits non-zero, so it shows in `journalctl -u message-cp-backup` and `systemctl --failed`. The URL is never logged: it is passed to `curl` on stdin, not on its command line, and messages name the file it came from.
- **Local copy.** Built in a temporary directory that is deleted when the script exits, whether the upload worked or not.

### Install

Needs `sqlite3` (3.27 or later, for `VACUUM INTO`), `curl` and `gzip` on the server (`apt install sqlite3 curl`), and systemd 247 or later for `LoadCredential=`.

1. In the OCI console (or with the OCI CLI on the owner's machine, not the server), create the bucket with object versioning on, and give it lifecycle rules that delete objects and previous object versions after 30 days. Create a pre-authenticated request with access type **Permit object writes** on the whole bucket. Its URL ends in `/o/`. Every PAR has an expiry date: pick a far one and note it, because after it every backup fails with a 4xx until the URL in step 2 is replaced.
2. On the server, as root, store the URL where only root can read it:

   ```sh
   install -d -m 0700 /etc/message-cp
   install -m 0600 /dev/null /etc/message-cp/backup-url
   cat > /etc/message-cp/backup-url   # paste the URL, then Ctrl-D
   clear                             # the URL is now in the scrollback
   ```

3. Install the script and units:

   ```sh
   install -m 0755 ops/backup.sh /usr/local/bin/message-cp-backup
   install -m 0644 ops/message-cp-backup.service ops/message-cp-backup.timer /etc/systemd/system/
   ```

4. Run the backup as the account that runs `serve` and owns the database, with the same `MESSAGE_CP_DB` if `serve` sets one. `systemctl edit message-cp-backup.service` and add:

   ```ini
   [Service]
   User=message-cp
   Environment=MESSAGE_CP_DB=/var/lib/message-cp/db.sqlite
   ```

   (Without `MESSAGE_CP_DB` it backs up `~/.message-cp/db.sqlite` of that user, as the server does.)
5. Enable the timer and run one backup now:

   ```sh
   systemctl daemon-reload
   systemctl enable --now message-cp-backup.timer
   systemctl start message-cp-backup.service
   journalctl -u message-cp-backup -n 5    # message-cp-backup: uploaded message-cp-<date>.sqlite.gz (<n> bytes)
   ```

   Then check that the object is in the bucket. `systemctl list-timers message-cp-backup.timer` shows the next run.

To run it by hand outside systemd, point it at the URL file: `MESSAGE_CP_BACKUP_URL_FILE=/path/to/url ops/backup.sh`.
