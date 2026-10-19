---
name: vm-check
description: >-
  One-off check of the machine a factory run lands on (VM or container):
  report the OS, resources, virtualisation, tools, sudo and Docker, and
  whether a plain npm ci, build, tests and e2e pass on a copy of the repo.
  Changes nothing in the repository and opens no pull request.
---

# VM check

Run these from the repository root and report every result in the run
output, as a short table, then list anything that failed and the exact error
lines. Never print environment variables or secrets (no `env`, `printenv` or
`set -x`). Do not commit, push or open a pull request.

1. Machine: `uname -a`; `head -2 /etc/os-release`; `nproc`; `free -g | head -2`;
   `df -h / /var/tmp | tail -2`; `systemd-detect-virt || true`;
   `cat /proc/1/comm`.
2. Tools: `node -v`; `npm -v`; `which make g++ python3 go docker`;
   `sudo -n true && echo sudo-ok || echo no-sudo`;
   `docker info --format '{{.ServerVersion}}' || true`.
3. The repository, on a copy so the checkout stays clean:
   `rm -rf /var/tmp/vmcheck && cp -r . /var/tmp/vmcheck && cd /var/tmp/vmcheck
   && rm -rf node_modules`, then time each of these and record its exit code:
   plain `npm ci` (without `--ignore-scripts`), `npm run build`, `npm test`
   (the pass and fail counts), `npm run e2e` (its last line).
4. Say whether this looks like a VM or a container, and why.
