# Deploying `main` to the server

The server deploys itself. Every two minutes `memory-cp-deploy.timer` runs `deploy.sh`, which fetches `origin/main` with a read-only deploy key and, if it is new, builds it, switches it in, restarts `memory-cp.service` and runs `npm run e2e` against the public URL. A release that fails `npm ci`, `npm run build` or that check is rolled back to the previous one, and its sha is written to `failed-sha` so it is not tried again until `main` moves. A release is live only once it has passed the check: its sha is then written to `live-sha`, and a run that ends between switching and checking (a reboot, a timeout) is undone by the next run, which puts `live-sha` back before anything else. A merge is live, or rolled back, within about five minutes.

| File | What it is |
| --- | --- |
| `deploy.sh` | One deploy run, as root. Installed as `/opt/memory-cp/deploy.sh`. |
| `memory-cp-deploy.service`, `memory-cp-deploy.timer` | Run `deploy.sh` two minutes after the last run ended. |
| `memory-cp.service` | `memory-cp serve` from `/opt/memory-cp/current`, as the `memory-cp` user. Replaces the server's existing unit. |
| `try-deploy.sh` | Tries all of it on any Linux machine, without root or systemd (see below). |

## Layout

```text
/opt/memory-cp/
  deploy.sh             this directory's deploy.sh (root's; a deploy never changes it)
  repo.git/             bare clone of the GitHub repo; only ever fetched
  releases/<sha>/       one built release per commit, root's and read-only to the server; the newest five are kept
  current -> releases/<sha>   the live release; switching it is the deploy, switching it back is the rollback
  live-sha              the last sha that passed its check
  failed-sha            the last sha that failed, not retried until main moves; its release is deleted
  deploy.lock           flock(1) lock: two runs never overlap
  build-home/           HOME and npm cache for builds (memory-cp-build's)
  check-home/           HOME and npm cache for the check (memory-cp's)
/etc/memory-cp.env      MEMORY_CP_HTTP_TOKEN, MEMORY_CP_PUBLIC_URL, MEMORY_CP_DB (root, 0600)
```

The database (`MEMORY_CP_DB`) and `/etc/memory-cp.env` are outside `releases/`, and no deploy writes them; `deploy.sh` refuses to run if `MEMORY_CP_DB` points inside a release. The token is read from `/etc/memory-cp.env` by root and given to the check in its environment, never on a command line, and nothing prints it. Builds run as `memory-cp-build`, a user that can read neither the token nor the database, so a dependency's install script cannot either; the check runs as `memory-cp`, the server's user. Everything `deploy.sh` prints goes to the journal: `journalctl -u memory-cp-deploy`.

## Install

As root, on a machine with Node 22.12 or later, git, curl, `flock` and `setpriv` (util-linux), and a C++ toolchain (`build-essential` on Debian and Ubuntu) in case `better-sqlite3` has no prebuilt binary for the server's Node:

1. A user for the server, one for builds, and the directories:

   ```sh
   useradd --system --home-dir /var/lib/memory-cp --create-home --shell /usr/sbin/nologin memory-cp
   useradd --system --no-create-home --shell /usr/sbin/nologin memory-cp-build
   chmod 700 /var/lib/memory-cp
   mkdir -p /opt/memory-cp
   ```

2. A read-only deploy key. Generate it, then add the `.pub` on GitHub under the repository's Settings → Deploy keys, with "Allow write access" left off:

   ```sh
   install -d -m 700 /root/.ssh
   ssh-keygen -t ed25519 -N '' -C memory-cp-deploy -f /root/.ssh/memory-cp-deploy
   ssh-keyscan github.com >> /root/.ssh/known_hosts
   ```

3. The bare clone, fetching with that key:

   ```sh
   GIT_SSH_COMMAND='ssh -i /root/.ssh/memory-cp-deploy -o IdentitiesOnly=yes' \
     git clone --bare git@github.com:colinhallett/memory-cp.git /opt/memory-cp/repo.git
   git --git-dir=/opt/memory-cp/repo.git config core.sshCommand 'ssh -i /root/.ssh/memory-cp-deploy -o IdentitiesOnly=yes'
   ```

4. `/etc/memory-cp.env`, if the server does not have it yet (keep the existing token and database path if it does, and add `MEMORY_CP_PUBLIC_URL`):

   ```sh
   MEMORY_CP_HTTP_TOKEN=<the token agents use>
   MEMORY_CP_PUBLIC_URL=https://memory.example.com
   MEMORY_CP_DB=/var/lib/memory-cp/db.sqlite
   ```

   `chown root:root /etc/memory-cp.env && chmod 600 /etc/memory-cp.env`. `MEMORY_CP_PUBLIC_URL` is the https URL clients use, without `/mcp`; the check runs against it, through Caddy.

5. The script and units, from a checkout of this repository:

   ```sh
   install -m 755 ops/deploy.sh /opt/memory-cp/deploy.sh
   install -m 644 ops/memory-cp.service ops/memory-cp-deploy.service ops/memory-cp-deploy.timer /etc/systemd/system/
   systemctl daemon-reload
   ```

   `memory-cp.service` replaces the server's existing unit of that name. Compare it first and carry over anything the old one needed (a different port or user, for example); Caddy keeps proxying to `127.0.0.1:8787`. It finds `node` on systemd's default PATH (`/usr/local/bin`, `/usr/bin`, ...); if node lives elsewhere, put its absolute path in `ExecStart`.

6. The first deploy, then the timer:

   ```sh
   systemctl enable memory-cp.service
   systemctl start memory-cp-deploy.service    # builds main, starts the server, runs the check
   journalctl -u memory-cp-deploy -n 50
   systemctl enable --now memory-cp-deploy.timer
   ```

   If the first deploy fails there is nothing to roll back to, so the server stays stopped until a commit passes.

To see what is live: `cat /opt/memory-cp/live-sha`. A failure while the registry, the network or Caddy was down also lands in `failed-sha`; to retry that sha without a new commit, `rm /opt/memory-cp/failed-sha`. To roll back by hand, stop the timer first (`systemctl stop memory-cp-deploy.timer`), since a run puts `live-sha` back and deploys `main` again.

## Trying it

`ops/try-deploy.sh` runs `deploy.sh` for real, without root or systemd: a bare git repo stands in for GitHub, and a stand-in `systemctl` starts the server from `current` on port 18787 (`PORT=` to change it). It deploys this checkout's HEAD and checks it, runs again and does nothing, then pushes a commit whose server answers every authorised request with 500 and checks that it fails `npm run e2e`, is rolled back and deleted, is not retried, and that the previous release passes the check again; last, it points `current` at an unchecked release, as a killed run would leave it, and checks that the next run restores the good one. It exits 0 when all of that holds and keeps its work directory for inspection.
