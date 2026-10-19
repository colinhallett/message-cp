# Moving a server from the memory-cp names to message-cp

A server installed by the old `ops/` runs under memory-cp names. This moves it to the names the rest of `ops/` now uses, keeping the database, the token, the release history and the deploy key. `migrate-from-memory-cp.sh` does the work; this page says what it does, what it needs, and how to undo it. It is for one move, once; after it, the server is installed as [deploy.md](deploy.md) and [README.md](README.md) describe.

| Old | New |
| --- | --- |
| users and groups `memory-cp`, `memory-cp-build` | `message-cp`, `message-cp-build` (renamed, same uid and gid) |
| `/opt/memory-cp/` (`repo.git`, `releases/`, `current`, `live-sha`, `failed-sha`, `rollback-pending`, `deploy.lock`, `build-home/`, `check-home/`, `deploy.sh`) | `/opt/message-cp/`, the same inside |
| `/var/lib/memory-cp/` (the server's home and database) | `/var/lib/message-cp/` |
| `/etc/memory-cp.env` with `MEMORY_CP_*` | `/etc/message-cp.env` with `MESSAGE_CP_*`, the same values |
| `/etc/memory-cp/backup-url` (the old bucket) | `/etc/message-cp/backup-url` (the new `message-cp-backups` bucket) |
| `/usr/local/bin/memory-cp-backup` | `/usr/local/bin/message-cp-backup` |
| `/root/.ssh/memory-cp-deploy` and `.pub` | `/root/.ssh/message-cp-deploy` and `.pub`, the same key |
| `memory-cp.service`, `memory-cp-deploy.service` / `.timer`, `memory-cp-backup.service` / `.timer`, and their drop-ins | `message-cp.service`, `message-cp-deploy.service` / `.timer`, `message-cp-backup.service` / `.timer`, and their drop-ins |
| backups `memory-cp-<date>.sqlite.gz` | `message-cp-<date>.sqlite.gz`, in the new bucket |

**Users are renamed, not created.** `usermod -l` and `groupmod -n` keep the uid and gid, so every file the server or the builds own (the database and its `-wal` and `-shm`, `check-home`, `build-home`) keeps its owner without a `chown -R`, and undo is renaming them back. New users would have new ids, every file would have to be re-owned, and a file missed would lock the server out of it.

**Nothing is deleted.** Each old path is copied to its new name (`cp -a`, keeping owners, modes and times), and only then renamed aside to `<old path>.pre-message-cp`. The copy is taken with the server, the backup and any deploy stopped, so the database, its WAL and its shared-memory file are copied together and at rest. The old units and drop-ins are renamed aside the same way. The old bucket and its backups are not touched.

**Nothing secret is printed.** The env file is rewritten in place with `sed`, the backup URL file is copied with `install`, and the token reaches the check in its environment, as in `deploy.sh`. Every file holding a token, a key or a URL stays `root:root` and `0600` (directories `0700`), as before.

## Before you start

1. **The live release reads `MESSAGE_CP_*`.** The new env file has only the new names, and a rollback goes back to `live-sha`, so that release must be one from after the package rename (COL-50, #32). The script checks `live-sha`'s release and refuses otherwise; let `main` deploy first.
2. **A new bucket, `message-cp-backups`.** Object Storage cannot rename a bucket, so backups under the new name go to a new one, set up as the old one was ([README.md](README.md), Install, step 1): private (no public access), object versioning on, lifecycle rules that delete objects and previous versions after 30 days, and a pre-authenticated request with access type **Permit object writes** on the whole bucket, with a far expiry. Its URL ends in `/o/`.
3. **That URL in a root-only file on the server**, which the script installs as `/etc/message-cp/backup-url`:

   ```sh
   install -m 0600 -o root -g root /dev/null /root/message-cp-backup-url
   cat > /root/message-cp-backup-url   # paste the URL, then Ctrl-D
   clear                               # the URL is now in the scrollback
   ```

4. **A checkout of this repository** at the commit that added this page or later, on the server: the script installs `deploy.sh`, `backup.sh` and the units from it. The server's own clone has it once `main` is fetched, with no credentials needed: `mkdir /root/message-cp-src && git --git-dir=/opt/memory-cp/repo.git archive refs/remotes/origin/main | tar -x -C /root/message-cp-src`.
5. **Free space** beside `/opt/memory-cp` and `/var/lib/memory-cp` for one more copy of each (`du -sh /opt/memory-cp /var/lib/memory-cp`; the releases' `node_modules` are most of it). The script checks and refuses otherwise.
6. **Nothing else holds the database open.** Stop any stdio server, `hive` or `message-cp wait` running as `memory-cp` on that file: the move renames the user, which fails while one of its processes runs.

The server is down from step 1 of the move until step 6 passes: as long as a deploy run already under way takes to finish, then the time to copy `/opt/memory-cp` and the database (seconds for a few hundred MB on local disk), then the check.

## The move

As root, from the checkout:

```sh
ops/migrate-from-memory-cp.sh move /root/message-cp-backup-url
```

It refuses to start, and changes nothing, if the URL file is missing, empty or not `root:root 0600`, if there is no old install, if any new name (a path, unit, drop-in, user or group), a `.partial` copy or a `.pre-message-cp` copy exists already, if there is not enough free space, or if the live release does not read `MESSAGE_CP_*`. Then:

1. **Stops everything that writes.** Stops and disables `memory-cp-deploy.timer` (and `memory-cp-backup.timer`), so no new deploy run starts; takes `/opt/memory-cp/deploy.lock` with `flock`, which waits until a run already under way has finished and keeps out one started by hand (after step 3 it holds the lock in `/opt/message-cp` too); then stops `memory-cp-deploy.service`, `memory-cp-backup.service` and `memory-cp.service`, and disables `memory-cp.service`. It makes `/opt/memory-cp/deploy.sh` unexecutable, so no deploy run can start at all, and waits out any run that started before that (it exits at the lock), since a run that reached `deploy.sh` once `/opt/memory-cp` is set aside would recreate it. It goes no further unless each of those units is `inactive` or `failed` and nothing runs as `memory-cp` (a stdio server, say): it stops with nothing copied, and undo starts the old server again. No message-cp deploy can run until step 7.
2. **Renames the users**: `memory-cp` to `message-cp` (its group too, and its home from `/var/lib/memory-cp` to `/var/lib/message-cp`), and `memory-cp-build` to `message-cp-build`.
3. **Copies and sets aside** each old path in the table, then the timer stamps in `/var/lib/systemd/timers/`. `current` is a relative link (`releases/<sha>`), so it points into the copy. A database at the server's default path (`~/.memory-cp/db.sqlite`, when `MEMORY_CP_DB` was unset) moves to the new default, `~/.message-cp/db.sqlite`.
4. **Rewrites names inside the copies.** In `/etc/message-cp.env`: `MEMORY_CP_` keys become `MESSAGE_CP_`, and `/var/lib/memory-cp` and `/opt/memory-cp` in values become the new paths; the token and URL are unchanged. `repo.git`'s `core.sshCommand` names the moved key, and its `origin` URL names `message-cp.git` where it named `memory-cp.git` (GitHub serves a renamed repository at both); so does `/root/.ssh/config` if it named the old one (kept as `config.pre-message-cp`). The new bucket's URL is installed as `/etc/message-cp/backup-url`.
5. **Installs** `deploy.sh` as `/opt/message-cp/deploy.sh` and `backup.sh` as `/usr/local/bin/message-cp-backup` from the checkout, and carries the units over: each old unit file is written under its new name with `memory-cp` and `MEMORY_CP_` replaced, so an edit made to it (a port, the path to `node`) is kept; a unit the old install did not have comes from the checkout. Each old unit's drop-in directory (`systemctl edit`, such as the backup unit's `User=` and `MEMORY_CP_DB`) is copied to the new unit's, with `memory-cp` and `MEMORY_CP_` replaced. If the backup unit had none, it writes one with `User=message-cp` and the env file's `MESSAGE_CP_DB`.
6. **Starts `message-cp.service` and checks it**: makes sure the database is where the server will look (the server would create an empty one, and that would pass the check), waits for `/mcp` to answer 401, then runs the live release's `npm run e2e -- --url <MESSAGE_CP_PUBLIC_URL>` as `message-cp`, as `deploy.sh` does.
7. **Runs one backup**, which writes `message-cp-<date>.sqlite.gz` to the new bucket, then enables `message-cp-backup.timer` and `message-cp-deploy.timer`.

Then check:

```sh
journalctl -u message-cp-backup -n 3          # message-cp-backup: uploaded message-cp-<date>.sqlite.gz (<n> bytes)
systemctl list-timers 'message-cp-*'
ops/migrate-from-memory-cp.sh check
journalctl -u message-cp-deploy -f            # the next run (within two minutes) fetches with the moved key; Ctrl-C once it has
```

`check` runs `find / -xdev -name '*memory-cp*'` (on the root file system only: if `/var` or `/opt` is a mount of its own, run the same `find` on it too) and `systemctl list-units --all '*memory-cp*'`. It expects only the `*.pre-message-cp` copies and the `ops/memory-cp*` unit files inside an older release's source (they go when that release ages out of the newest five); it exits 1 on anything else, on any memory-cp unit systemd still knows, or on a memory-cp user or group. Check also that the object is in the new bucket, and, from an agent, that `list_agents` and `read_inbox` show what they did before, with the same token.

Caddy needs no change: it proxies to `127.0.0.1:8787` as before. Agents need no change: the URL and tokens are the same.

## If it fails part-way

Every step before 6 is a rename, a copy or a rewrite of a copy, and the script stops at the first failure and says to run undo. If step 6 fails (the new server does not start or does not pass its check), it stops before enabling any timer. Either way, as root, from the same checkout:

```sh
ops/migrate-from-memory-cp.sh undo
```

It stops the new units, takes the new deploy lock, and puts the old names back:

- **The database, `/opt` and the env file go back from their new copies**, since the new server may have written to them since the move (messages, `live-sha`); the copies taken before the move are kept as `<old path>.pre-message-cp.undone-<time>`. The env file's keys and paths are rewritten back to `MEMORY_CP_*`, and `/opt/memory-cp/deploy.sh` is put back from the copy taken before the move.
- **Everything else goes back from what was set aside**: the old backup URL (the old bucket), the deploy key, `/root/.ssh/config`, the backup script, the timer stamps and the old units and drop-ins. The new copies of those are kept as `<new path>.undone-<time>`.
- **The users are renamed back**, and the new unit files are removed (the `origin` URL in `repo.git` keeps the new name, which GitHub serves too); their drop-ins are kept as `<drop-in dir>.undone-<time>`, in case one holds an edit made since.
- **An old path that something recreated after the move set it aside** (a deploy run started by hand with `bash`, say) is kept as `<old path>.recreated-<time>`, and the old path is restored over it.
- **A path the move had copied but not yet set aside** keeps its old copy, which is the one the server used; the new copy is kept as `.undone-<time>`, as is any unfinished `.partial` copy.

It makes `/opt/memory-cp/deploy.sh` executable again. Then it starts `memory-cp.service` and leaves both timers off. Check the old server, then turn them on:

```sh
(set -a && . /etc/memory-cp.env && set +a && cd /opt/memory-cp/current && npm run e2e -- --url "$MEMORY_CP_PUBLIC_URL")
systemctl enable --now memory-cp-deploy.timer memory-cp-backup.timer
```

If undo itself stops (a process still running as `message-cp` blocks the user rename, say), fix that and run it again: it carries on from where it stopped. Once you know why the move failed, delete the `*.undone-*` copies and run the move again.

### If only the first backup fails (step 7)

Then the move is done and the server is serving under the new names, but both timers are off. The likely causes are a URL that is wrong, expired or not a write PAR on the new bucket. Fix `/etc/message-cp/backup-url` (root's, 0600), then:

```sh
systemctl start message-cp-backup.service && journalctl -u message-cp-backup -n 3
systemctl enable --now message-cp-backup.timer message-cp-deploy.timer
```

Or run undo, as above, to go back to the old names and bucket.

## Afterwards

Delete `/root/message-cp-backup-url` once step 7 has passed: it holds the live write URL, which is now in `/etc/message-cp/backup-url`.

Leave the `*.pre-message-cp` copies until the new install has run for a while (a few deploys and nightly backups); nothing reads them, and `undo` works until they are gone. A later clean-up ticket removes them (`rm -rf /opt/memory-cp.pre-message-cp /var/lib/memory-cp.pre-message-cp ...`, everything `check` lists as kept aside), and the old bucket once its backups have expired.

## Rehearsal

This was rehearsed end to end in a disposable Ubuntu 24.04 container running systemd 255: installed with `main`'s `ops/` (an ssh-reachable bare repo standing in for GitHub, a local PUT server for the bucket), with two accounts' agents and messages in the WAL; moved while a deploy run was under way; checked; undone with new data written after the move; failed on purpose at step 6 and undone; and moved again. One thing could not run there: `LoadCredential=` does not work in that container, so the backup unit read its URL file through a drop-in that only the rehearsal added. The pull request that added this page has the commands and output.
