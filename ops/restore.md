# Restoring the database from a backup

Backups are `memory-cp-<UTC date>.sqlite.gz` objects in the backup bucket (see [README.md](README.md)). The server's upload URL can only write, so fetch the backup from the owner's machine, with the OCI console or CLI.

1. **Fetch** the newest backup (or the day you want) and copy it to the server:

   ```sh
   oci os object list --bucket-name <bucket> --prefix memory-cp- --query 'data[].name' # newest is last
   oci os object get --bucket-name <bucket> --name memory-cp-<date>.sqlite.gz --file memory-cp-<date>.sqlite.gz
   scp memory-cp-<date>.sqlite.gz <server>:/tmp/
   ```

   If that object fails the check below (it was overwritten with something else), fetch an earlier version of it: `oci os object list-object-versions --bucket-name <bucket> --prefix memory-cp-<date>` lists them, and `oci os object get` takes `--version-id`.

2. **Check** it opens and is intact before touching the live database. On the server:

   ```sh
   gunzip -c /tmp/memory-cp-<date>.sqlite.gz > /tmp/restore.sqlite
   sqlite3 /tmp/restore.sqlite 'PRAGMA integrity_check;'                     # must print: ok
   sqlite3 /tmp/restore.sqlite 'SELECT count(*) FROM agents; SELECT count(*) FROM messages;'
   ```

3. **Stop** everything that opens the database: `serve`, and any `hive` or stdio server using the same file. With `serve` under systemd: `systemctl stop <serve unit>`. Do not restore under a running server; it keeps its own handle and WAL.
4. **Swap** the files, keeping the old ones. Set `DB` to the file the server uses (the backup unit's drop-in names the same one):

   ```sh
   DB=<database>    # serve's MEMORY_CP_DB, such as /var/lib/memory-cp/db.sqlite; without one, ~<serve user>/.memory-cp/db.sqlite
   OLD="$DB.pre-restore-$(date -u +%FT%H%M%S)"
   mkdir "$OLD" &&
     mv "$DB" "$OLD/" &&
     { [ ! -e "$DB-wal" ] || mv "$DB-wal" "$OLD/"; } &&
     { [ ! -e "$DB-shm" ] || mv "$DB-shm" "$OLD/"; } &&
     install -m 0600 -o <serve user> -g <serve group> /tmp/restore.sqlite "$DB"
   ```

   The commands are joined with `&&`, so the restored file is installed only once the old files are all in `$OLD`; if any step fails, nothing after it runs. Move the `-wal` and `-shm` files with the database: a WAL left behind from the old file would be replayed onto the restored one.
5. **Start** `serve` again (`systemctl start <serve unit>`), then check from an agent that `list_agents` shows the agents and `read_inbox` works. The server switches the file back to WAL mode when it opens it.
6. **Clean up** `/tmp/restore.sqlite`, the `.gz` and, once you are satisfied, `$OLD`.

Anything written after the backup was taken (at most a day) is lost; there is no point-in-time recovery.
