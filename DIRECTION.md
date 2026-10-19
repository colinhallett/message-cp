# Direction

This file is the owner's direction for the project. The factory reads it and never edits it: a pull request that changes it waits for the owner.

## What this is

message-cp (the repository and package are still named memory-cp until the rename lands): an open-source messaging service for AI agents that anyone can run themselves. Agents on the same machine (stdio) or anywhere else (HTTPS) register a name, find each other, send each other messages, and are woken when mail arrives. It does that one job, and nothing else: no shared memory, no task board, no agent supervisor.

## Who it is for

People who run it themselves: alone, with one token, or for a small team, with an account and token per person. Each account's agents and messages are never visible to another account. message-cp does not sign people in: it accepts bearer tokens it issued, and anyone who wants another kind of sign-in puts their own proxy or gateway in front. The owner's own server is one such install, and the factory's checks run against it.

## Current goal: an open-source package

In this order, each a ticket of its own. The old name goes completely; git history and closed pull requests keep it.

1. **Remove the GitHub sign-in.** The OAuth endpoints, the GitHub flow, waking by agent key, and their tables go. Accounts and tokens stay.
2. **Rename to message-cp.** Package, command, server name, environment variables and default paths. The old `memory-cp` command, `MEMORY_CP_*` variables and `~/.memory-cp/` paths keep working.
3. **Rename the server setup in ops/ to message-cp, with a procedure that moves a running install over.** The owner's server is moved with it.
4. **Remove the old memory-cp names once the live server and the factory use the new ones.** After this, nothing in the repository says memory-cp.
5. **A README for strangers.** What it is, how to run it alone and for a team, the token model, and how to put your own sign-in in front.

Account separation is the one security boundary that matters most here: a change that could let one account read, send as, list, wake on or remove another account's agents or messages is wrong, however small.

## What "production ready" means here

1. **It does not lose messages.** The database is backed up nightly off the server, and a restore has been tested.
2. **What is on `main` is what is running.** A merge reaches the server within minutes, is checked there, and is rolled back automatically if the check fails.
3. **Breakage is noticed by a machine, not by the owner.** A daily check uses the live server the way an agent does and files a ticket when it fails.
4. **The owner is not needed day to day.** Tickets are written, built, reviewed, merged and deployed by the factory. The owner reads a weekly summary.

## Guardrails

- Never break a working agent's setup without a migration path: old names, paths and settings keep working for at least one release after a change.
- Messages and tokens are private. Nothing logs a message body or a token, and no check posts one anywhere.
- Changes to this file, to `tessl.json`, to `tessl-factory/` and to `AGENTS.md` are the owner's. The factory may propose them but never merges them.
- Prefer removing code to adding it. A feature needs a reason an agent hits in practice, not a reason it might.
- At most three factory tickets are in flight at once.

## Not now

- Sign-in of any kind built into the server (OAuth, GitHub, passwords). Tokens only.
- A web page for managing an account. Accounts and tokens are managed with the command on the server.
- Publishing to npm.
- New kinds of content beyond messages (files, memories, tasks).
