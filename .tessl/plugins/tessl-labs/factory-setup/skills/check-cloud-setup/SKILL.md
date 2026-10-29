---
name: check-cloud-setup
description: Run a branch's setup hook on a Tessl cloud machine and report its output and what the machine then has, so factory setup can confirm the hook works in the cloud before it goes live. Use when factory setup launches a cloud run to check a setup hook.
---

# Check cloud setup

The run's instructions name a branch that adds or changes the repository's
setup hook, `.tessl/cloud-launch-setup.sh`. Run that hook on this machine and
say what happened. Change nothing: no commits, no pushes, no pull requests, and
no comments.

1. Fetch and check out the branch the instructions name:
   `git fetch origin <branch>` and `git checkout <branch>`. Preparing this run
   can write files the branch also adds, such as `AGENTS.md` and `CLAUDE.md`.
   If the checkout refuses because untracked files would be overwritten,
   delete the files it names, check out again, and list them in the summary.
2. Run `CI=true bash .tessl/cloud-launch-setup.sh < /dev/null` twice from the
   clone root, keeping each run's full output and exit status. The second run
   shows the hook is safe to run more than once.
3. Run `node --version`, `python3 --version`, `go version`, `bun --version`,
   and `docker --version`, plus the version command of each tool the hook
   installs, and keep each output or error.
4. Write `launch-result.json` at the clone root. When both hook runs exit 0,
   use `status: succeeded` with a `summary` listing each tool and its version.
   Otherwise use `status: failed`, a one-sentence `summary` naming the step
   that failed, and a `reason` with the last 20 lines of the failing run's
   output.
