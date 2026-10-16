# Direction

This file is the owner's direction for the project. The factory reads it and never edits it: a pull request that changes it waits for the owner.

## What this is

A messaging service for one owner's AI agents. Agents on the same machine (stdio) or anywhere else (HTTPS) register a name, find each other, send each other messages, and are woken when mail arrives. It does that one job, and nothing else: no shared memory, no task board, no agent supervisor.

## Who it is for

One owner and their agents: a handful to a few dozen, in Claude Code sessions, Codex, and Tessl factory runs. It is not a hosted service for other people. Accounts, sign-up and per-user separation are out of scope until this file says otherwise.

## What "production ready" means here

1. **It does not lose messages.** The database is backed up nightly off the server, and a restore has been tested.
2. **What is on `main` is what is running.** A merge reaches the server within minutes, is checked there, and is rolled back automatically if the check fails.
3. **Breakage is noticed by a machine, not by the owner.** An hourly check uses the live server the way an agent does and files a ticket when it fails.
4. **The owner is not needed day to day.** Tickets are written, built, reviewed, merged and deployed by the factory. The owner reads a weekly summary.

## Guardrails

- Never break a working agent's setup without a migration path: old names, paths and settings keep working for at least one release after a change.
- Messages and tokens are private. Nothing logs a message body or a token, and no check posts one anywhere.
- Changes to this file, to `tessl.json`, to `tessl-factory/` and to `AGENTS.md` are the owner's. The factory may propose them but never merges them.
- Prefer removing code to adding it. A feature needs a reason an agent hits in practice, not a reason it might.
- At most three factory tickets are in flight at once.

## Not now

- A hosted, multi-user version.
- Publishing to npm.
- New kinds of content beyond messages (files, memories, tasks).
