# Restoring the database from a backup

Backups are `message-cp-<UTC date>.sqlite.gz` objects in the backup bucket (see [README.md](README.md)). The server's upload URL can only write, so fetch the backup from the owner's machine, with the OCI CLI.

A backup holds every account's data: every message and channel post, the webhooks with their secrets, and the token and agent key hashes. Keep every copy of it, compressed or not, private to you and the server's root. The steps below never write it, or a file made from it, outside a directory that only its owner can open: on the owner's machine it is never written at all, and on the server it goes into a fresh `mktemp -d` directory (mode 0700) under `umask 077` (files in it 0600) that is deleted when the shell that made it exits or loses its connection, whether the restore worked or not (only a shell killed outright, or a crash, leaves it for you to delete). Do not save the object to a file in a shared place such as `/tmp`, or `scp` it to one: under the usual umask 022 that file is readable by every user of the machine.

1. **Prepare** a private directory on the server. Get a root shell there (`sudo -i`; steps 3 and 4 need root) and keep it open until step 6. In it:

   ```sh
   umask 077                      # every file this shell creates from now on is 0600, every directory 0700
   WORK="$(mktemp -d)" && echo "$WORK"
   trap 'rm -rf "$WORK"' EXIT     # deletes $WORK and everything in it when this shell exits, even if a step fails
   ```

   `mktemp -d` makes a new directory with an unpredictable name, mode 0700, owned by root. If the shell ends early (a dropped connection, `exit` after a failed step), the trap deletes the directory with it; start again from this step.
2. **Fetch** the newest backup (or the day you want) from the owner's machine straight into that directory, with `<work>` the path step 1 printed:

   ```sh
   oci os object list --bucket-name <bucket> --prefix message-cp- --query 'data[].name' # newest is last
   oci os object get --bucket-name <bucket> --name message-cp-<date>.sqlite.gz --file - |
     ssh <server> "sudo sh -c 'umask 077 && cat > <work>/backup.sqlite.gz'"
   ```

   `--file -` writes the object to the pipe, so no copy of it is kept on the owner's machine, and on the server it is written as root, 0600, into the 0700 directory. That needs `sudo` without a password on the server; if it asks for one, use `ssh root@<server> 'umask 077 && cat > <work>/backup.sqlite.gz'` instead. Then **check** it opens and is intact before touching the live database. Back in the server's shell from step 1:

   ```sh
   gunzip -c "$WORK/backup.sqlite.gz" > "$WORK/restore.sqlite"
   sqlite3 "$WORK/restore.sqlite" 'PRAGMA integrity_check;'                  # must print: ok
   sqlite3 "$WORK/restore.sqlite" 'SELECT count(*) FROM agents; SELECT count(*) FROM messages;'
   ls -la "$WORK"                                                            # drwx------ for ., -rw------- for each file
   ```

   Any file `sqlite3` makes beside the copy while it checks it (a `-journal`, `-wal` or `-shm`) is in `$WORK` too. If the object fails the check (it was overwritten with something else, or the transfer broke off), fetch an earlier version of it into the same directory, replacing `backup.sqlite.gz`: `oci os object list-object-versions --bucket-name <bucket> --prefix message-cp-<date>` lists them, and `oci os object get` takes `--version-id`. Then run the check again.

3. **Stop** everything that opens the database: `serve`, and any `hive` or stdio server using the same file. With `serve` under systemd: `systemctl stop <serve unit>`. Do not restore under a running server; it keeps its own handle and WAL.
4. **Swap** the files, keeping the old ones, in the same shell. Set `DB` to the file the server uses (the backup unit's drop-in names the same one):

   ```sh
   DB=<database>    # serve's MESSAGE_CP_DB, such as /var/lib/message-cp/db.sqlite; without one, ~<serve user>/.message-cp/db.sqlite
   OLD="$DB.pre-restore-$(date -u +%FT%H%M%S)"
   mkdir "$OLD" &&
     mv "$DB" "$OLD/" &&
     { [ ! -e "$DB-wal" ] || mv "$DB-wal" "$OLD/"; } &&
     { [ ! -e "$DB-shm" ] || mv "$DB-shm" "$OLD/"; } &&
     install -m 0600 -o <serve user> -g <serve group> "$WORK/restore.sqlite" "$DB"
   ```

   The commands are joined with `&&`, so the restored file is installed only once the old files are all in `$OLD`; if any step fails, nothing after it runs. `$OLD` is made under `umask 077`, so it is 0700 too. Move the `-wal` and `-shm` files with the database: a WAL left behind from the old file would be replayed onto the restored one.
5. **Start** `serve` again (`systemctl start <serve unit>`), then check from an agent that `list_agents` shows the agents and `read_inbox` works. The server switches the file back to WAL mode when it opens it.
6. **Clean up**: `rm -rf "$WORK"`, or leave the shell, whose trap deletes it. Once you are satisfied, delete `$OLD` as well: it holds the old database, which is as private as a backup.

Anything written after the backup was taken (at most a day) is lost; there is no point-in-time recovery.
