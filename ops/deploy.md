# Deploying `main` to the server

The server deploys itself. Every two minutes `message-cp-deploy.timer` runs `deploy.sh`, which fetches `origin/main` with a read-only deploy key and, if it is new, builds it, switches it in, restarts `message-cp.service` and runs `npm run e2e` against the public URL. A release that fails `npm ci`, `npm run build` or that check is rolled back to the previous one, and its sha is written to `failed-sha` so it is not tried again until `main` moves. A rollback is finished only once the restored release passes the check too; until then `rollback-pending` exists, and every run tries the rollback again first and deploys nothing new until the restored release has restarted and passed the check. A release is live only once it has passed the check: its sha is then written to `live-sha`, and a run that ends between switching and checking (a reboot, a timeout) is undone by the next run, which puts `live-sha` back before anything else. When runs take their usual minute or two, a merge is live, or rolled back, within about five minutes; a run that hangs holds up the next one for up to its 15-minute timeout.

| File | What it is |
| --- | --- |
| `deploy.sh` | One deploy run, as root. Installed as `/opt/message-cp/deploy.sh`. |
| `message-cp-deploy.service`, `message-cp-deploy.timer` | Run `deploy.sh` two minutes after the last run ended. |
| `message-cp.service` | `message-cp serve` from `/opt/message-cp/current`, as the `message-cp` user. Replaces the server's existing unit. |
| `try-deploy.sh` | Tries all of it on any Linux machine, without root or systemd (see below). |

## Layout

```text
/opt/message-cp/
  deploy.sh             this directory's deploy.sh (root's; a deploy never changes it)
  repo.git/             bare clone of the GitHub repo; only ever fetched
  releases/<sha>/       one built release per commit, root's and read-only to the server; the newest five are kept
  current -> releases/<sha>   the live release; switching it is the deploy, switching it back is the rollback
  live-sha              the last sha that passed its check
  failed-sha            the sha that failed at main's current tip, not retried until main moves; its release is deleted
  rollback-pending      present while a rollback has not yet passed its check; the next run tries it again
  deploy.lock           flock(1) lock: two runs never overlap
  build-home/           HOME and npm cache for builds (message-cp-build's)
  check-home/           HOME and npm cache for the check (message-cp's)
/etc/message-cp.env      MESSAGE_CP_HTTP_TOKEN, MESSAGE_CP_PUBLIC_URL, MESSAGE_CP_DB (root, 0600)
```

The database (`MESSAGE_CP_DB`) and `/etc/message-cp.env` are outside `releases/`, and no deploy script writes them; `deploy.sh` refuses to run if `MESSAGE_CP_DB` points inside a release. The token is read from `/etc/message-cp.env` by root and given to the check in its environment, never on a command line, and nothing prints it. Builds run as `message-cp-build`, a user that can read neither the token nor the database, so a dependency's install script cannot either; the check runs as `message-cp`, the server's user. Everything `deploy.sh` prints goes to the journal: `journalctl -u message-cp-deploy`.

A rollback switches the code, not the database. A release that is started and then fails its check has already opened the database, and its startup migrations have run, so a rolled-back release must still work on the database as the newer one left it. Keep migrations additive (add tables and columns; drop them only in a release after the one that stopped using them), as `src/db.ts` does. If a bad release did damage data, restore the night's backup (see `restore.md`).

### The accounts release cannot be rolled back automatically

The release that added accounts is the one exception. Its first open rebuilds the `agents` table so that names are unique per account, and every earlier release's `register` (`INSERT ... ON CONFLICT(name)`) fails on the rebuilt table. If that release fails its check, `deploy.sh` rolls back as usual and the restored release starts and answers `/mcp`, but cannot register agents, so its check fails too and `rollback-pending` stays. Worse, an earlier release reads agents by name alone, so once a second account exists it would show every account's agents in `list_agents`, `get_agent` and `/wait`. Do not leave an earlier release serving the rebuilt file, and stop any stdio server on it too. Recover by hand, at once:

1. As root, stop the timer, wait for any deploy run already under way, and keep later ones out, then stop the server: `systemctl stop message-cp-deploy.timer`, then `exec 9>/opt/message-cp/deploy.lock && flock 9` in the shell you recover from (it returns once a running `deploy.sh` has finished, and any run started while you hold it exits at once), then `systemctl stop message-cp.service`. Keep that shell open until step 4 is done.
2. Put back the database as it was before the rebuild. The release copied it to `<MESSAGE_CP_DB>.before-accounts` (mode 0600) just before rebuilding; anything written after that is lost. Swap it in with the steps in `restore.md` from step 4, using that copy instead of `"$WORK/restore.sqlite"`, and keeping the `-wal` and `-shm` files with the old file. Then move the copy into `$OLD` too (`mv "$DB.before-accounts" "$OLD/"`), so it stays with the files it was taken from: the next accounts release replaces any copy it finds with a fresh one. If the copy is missing or fails `PRAGMA integrity_check`, use the night's backup (`restore.md`, from step 1).
3. Switch back to the previous release: `ln -sfn releases/$(cat /opt/message-cp/live-sha) /opt/message-cp/current.new && mv -T /opt/message-cp/current.new /opt/message-cp/current`, then `rm -f /opt/message-cp/rollback-pending` and `systemctl start message-cp.service`.
4. Check it from that release, with the token and URL from the server's environment file: `(set -a && . /etc/message-cp.env && set +a && cd /opt/message-cp/current && npm run e2e -- --url "$MESSAGE_CP_PUBLIC_URL")`. Then let go of the lock (`exec 9>&-`), and leave the timer stopped until a fixed release is on `main`: with the timer on, the next run deploys `main` again once `main` moves past `failed-sha`.

Once the accounts release is live, delete `<MESSAGE_CP_DB>.before-accounts` when you no longer need it; nothing reads it.

## Install

As root, on a machine with Node 22.14 or later, git, curl, `flock` and `setpriv` (util-linux), and a C++ toolchain (`build-essential` on Debian and Ubuntu) in case `better-sqlite3` has no prebuilt binary for the server's Node:

1. A user for the server, one for builds, and the directories:

   ```sh
   useradd --system --home-dir /var/lib/message-cp --create-home --shell /usr/sbin/nologin message-cp
   useradd --system --no-create-home --shell /usr/sbin/nologin message-cp-build
   chmod 700 /var/lib/message-cp
   mkdir -p /opt/message-cp
   ```

2. A read-only deploy key. Generate it, then add the `.pub` on GitHub under the repository's Settings → Deploy keys, with "Allow write access" left off:

   ```sh
   install -d -m 700 /root/.ssh
   ssh-keygen -t ed25519 -N '' -C message-cp-deploy -f /root/.ssh/message-cp-deploy
   ssh-keyscan github.com >> /root/.ssh/known_hosts
   ```

3. The bare clone, fetching with that key:

   ```sh
   GIT_SSH_COMMAND='ssh -i /root/.ssh/message-cp-deploy -o IdentitiesOnly=yes' \
     git clone --bare git@github.com:colinhallett/message-cp.git /opt/message-cp/repo.git
   git --git-dir=/opt/message-cp/repo.git config core.sshCommand 'ssh -i /root/.ssh/message-cp-deploy -o IdentitiesOnly=yes'
   ```

4. `/etc/message-cp.env`, if the server does not have it yet (keep the existing token and database path if it does, and add `MESSAGE_CP_PUBLIC_URL`):

   ```sh
   install -m 600 -o root -g root /dev/null /etc/message-cp.env
   cat >/etc/message-cp.env <<'EOF'
   MESSAGE_CP_HTTP_TOKEN=replace-with-the-token-agents-use
   MESSAGE_CP_PUBLIC_URL=https://message.example.com
   MESSAGE_CP_DB=/var/lib/message-cp/db.sqlite
   EOF
   ```

   Then edit the token and URL in place. An existing file must also be `root:root` and `0600`: `chown root:root /etc/message-cp.env && chmod 600 /etc/message-cp.env`. `MESSAGE_CP_PUBLIC_URL` is the https URL clients use, without `/mcp`; the check runs against it, through Caddy.

5. The script and units, from a checkout of this repository:

   ```sh
   install -m 755 ops/deploy.sh /opt/message-cp/deploy.sh
   install -m 644 ops/message-cp.service ops/message-cp-deploy.service ops/message-cp-deploy.timer /etc/systemd/system/
   systemctl daemon-reload
   ```

   `message-cp.service` replaces the server's existing unit of that name. Compare it first and carry over anything the old one needed (a different port or user, for example); Caddy keeps proxying to `127.0.0.1:8787`. It finds `node` on systemd's default PATH (`/usr/local/bin`, `/usr/bin`, ...); if node lives elsewhere, put its absolute path in `ExecStart`.

6. The first deploy, then the timer:

   ```sh
   systemctl enable message-cp.service
   systemctl start message-cp-deploy.service    # builds main, starts the server, runs the check
   journalctl -u message-cp-deploy -n 50
   systemctl enable --now message-cp-deploy.timer
   ```

   If the first deploy fails there is nothing to roll back to. On a fresh install the server stays stopped until a commit passes. When replacing a running server, a failed `npm ci` or `npm run build` leaves the old process running (nothing was switched or restarted), but a release that starts and then fails its check is stopped, and the server stays stopped until a commit passes.

To see what is live: `cat /opt/message-cp/live-sha`. A failed `git fetch` records nothing; the next run fetches again. But once a sha has been fetched, a failure while the registry, the network or Caddy was down lands in `failed-sha` like any other; to retry that sha without a new commit, `rm /opt/message-cp/failed-sha`. To roll back by hand, stop the timer first (`systemctl stop message-cp-deploy.timer`), since a run puts `live-sha` back and deploys `main` again.

## Trying it

`ops/try-deploy.sh` runs `deploy.sh` for real, without root or systemd: a bare git repo stands in for GitHub, and a stand-in `systemctl` starts the server from `current` on port 18787 (`PORT=` to change it). It deploys this checkout's HEAD and checks it, runs again and does nothing, then pushes a commit whose server answers every authorised request with 500 and checks that it fails `npm run e2e`, is rolled back and deleted, is not retried, and that the previous release passes the check again; last, it points `current` at an unchecked release, as a killed run would leave it, and checks that the next run restores the good one; then it leaves a rollback unfinished and checks that the next run finishes it, and moves `main` back to the good sha and on to the bad one again and checks that the bad one is tried, and rolled back, again; last, it makes restarts fail with a new commit on `main` and checks that nothing is deployed until the rollback passes. It exits 0 when all of that holds and keeps its work directory for inspection.
