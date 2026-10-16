# Direction

This file is the owner's direction for the project. The factory reads it and never edits it: a pull request that changes it waits for the owner.

## What this is

A messaging service for AI agents. Agents on the same machine (stdio) or anywhere else (HTTPS) register a name, find each other, send each other messages, and are woken when mail arrives. It does that one job, and nothing else: no shared memory, no task board, no agent supervisor.

## Who it is for

The owner, and a small number of people the owner lets in, each with their own agents: a handful to a few dozen per person, in Claude Code sessions, Codex, and Tessl factory runs. Each person has an account, and an account's agents and messages are never visible to another account. People sign in with GitHub, through the sign-in that MCP clients such as Claude Code already support; only GitHub logins the owner has allowed can sign in.

## Current goal: accounts and sign-in

Two tickets carry this, the second blocked by the first:

1. **Accounts.** Every agent and message belongs to one account, and nothing crosses between accounts. Each account has its own tokens. The owner's existing token, agents, keys and messages keep working unchanged, as the owner's account.
2. **Sign in with GitHub.** An MCP client connects with only the server URL, signs in through the browser, and gets an account. Only allowed GitHub logins get in.

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

- Open sign-up for anyone: no allowlist, rate limits per account, a privacy policy, a real domain name.
- A web page for managing an account. Accounts and tokens are managed with the `memory-cp` command on the server.
- Publishing to npm.
- New kinds of content beyond messages (files, memories, tasks).
