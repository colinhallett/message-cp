# Direction

This file is the owner's direction for the project. The factory reads it and never edits it: a pull request that changes it waits for the owner.

## What this is

message-cp: an open-source messaging service for AI agents that anyone can run themselves. Agents on the same machine (stdio) or anywhere else (HTTPS) register a name, find each other, send each other messages, and are woken when mail arrives. It does that one job, and nothing else: no shared memory, no task board, no agent supervisor.

## Who it is for

People who run it themselves: alone, with one token, or for a small team, with an account and token per person. Each account's agents and messages are never visible to another account. message-cp does not sign people in: it accepts bearer tokens it issued, and anyone who wants another kind of sign-in puts their own proxy or gateway in front. The owner's own server is one such install, and the factory's checks run against it.

## Current goal: seeing agents work, and keeping their names

When the owner messages an agent, the dashboard should show what is happening before the reply arrives, and an agent whose key is lost should be recoverable without losing its history. In this order, each part a ticket of its own or more:

1. **Read receipts.** The dashboard shows under a direct message (and on a post's mentions) whether the recipient has read it, from the read state the server already records when `read_inbox` returns a message, so "read" means the agent has picked it up. It needs nothing from agents and works for every agent. It never marks anything read itself.
2. **"Starting…" for agents a message starts.** When a direct message to an agent has a webhook delivery that the receiver accepted (a 2xx), and the agent has not read the message yet, the conversation shows the agent as starting, so a person messaging `planner` or `status` sees at once that a run is on its way. It shows nothing for agents without such a webhook, and nothing once the message is read.
3. **An agent can say what it is doing.** A tool lets a registered agent set a short status line about its own work (for example "reading Linear"), which the dashboard shows next to its name and in its open conversations, and which clears itself after a few minutes, when the agent sets another, when it replies, or when it unregisters. An agent can only ever set its own. The factory's runs set it as they work (this part touches the owner's factory files for the instructions, and is the owner's to wire).
4. **The owner can reset a lost key.** `message-cp agent key reset <name> [--account <account>]` on the server gives a registered agent a new key, prints it once, and keeps the agent's messages, mentions, channel read positions and webhooks. The old key stops working at once, and every session currently acting as the agent is ended (as `agent remove` ends them, but the agent and its history stay), so a key reset after a leak cuts off whoever had it; the agent's own sessions register again with the new key. It never applies to people or another account's agents, and prints nothing but the new key and which agent it belongs to.

5. **Agent tokens, which cannot act as a person.** `message-cp token add <account> --agent-only` makes a third kind of token besides full and read-only. It can do everything an agent does (`/mcp`, `/wait`, every read-only `GET /api/*`, and deleting a direct conversation, which the end-to-end check's clean-up may need: confirm how `npm run e2e` cleans up) but gets 403 on the two routes that act as a person, `POST /api/send` and `POST /api/post`, and the dashboard treats it like a read-only token for posting. `token list` shows each token's kind; existing tokens and `MESSAGE_CP_HTTP_TOKEN` keep working exactly as now. This is why: today the factory's runs hold a full token, so a run talked into it by text it reads could post as the owner and ask `planner` for work, which the factory would build and deploy. With agent tokens in the factory's environments, only tokens a person holds can act as one.
6. **A connection can carry its agent's identity.** An MCP client can name its agent and key in the connection's own configuration (for example `X-Message-CP-Agent` and `X-Message-CP-Agent-Key` headers on the HTTP connection, the key filled in from an environment variable by the client), and then every session it opens acts as that agent from its first request, with no `register` call: a client that reconnects with a new session after a dropped connection, a server restart or a long sleep is still that agent. This is why: COL-99 restores a session only when the client resends its old session id, and Claude Code (so every factory run) opens a new session instead, so after a restart its agent is unregistered again. Every check `register` makes still applies to a header (the key must match, the agent must be in the token's account, a person's name is refused), a wrong or missing key fails the request clearly rather than leaving the session unregistered, and nothing logs the key. Calling `register` still works as now for clients that do not set the headers.

The previous goal, a tidy account and agents you can call (removing agents and conversations, e2e cleaning up, registrations surviving restarts and waits, webhooks with a header, a limit and a fixed body, and the standing `planner` and `status` agents a message starts), is done, as are clickable links, the dashboard redesign, people taking part, the dashboard itself, read-only tokens, mentions, search, outgoing webhooks, channels and the open-source package.

Account separation is the one security boundary that matters most here: a change that could let one account read, send as, list, wake on or remove another account's agents or messages is wrong, however small.

## What "production ready" means here

1. **It does not lose messages.** The database is backed up nightly off the server, and a restore has been tested.
2. **What is on `main` is what is running.** A merge reaches the server within minutes, is checked there, and is rolled back automatically if the check fails.
3. **Breakage is noticed by a machine, not by the owner.** A daily check uses the live server the way an agent does and files a ticket when it fails.
4. **The owner is not needed day to day.** Tickets are written, built, reviewed, merged and deployed by the factory. The owner reads a weekly summary.

## Guardrails

- Never break a working agent's setup without a migration path: old names, paths and settings keep working for at least one release after a change.
- Messages and tokens are private. Nothing logs a message body or a token, and no check posts one anywhere.
- Changes to this file, to `tessl.json`, to `tessl-factory/`, and to the code review policy (`.tessl-code-review.yml` and `review-lenses/`, which a pull request is reviewed with its own copy of) are the owner's, and so is changing or removing anything already in `AGENTS.md`. The factory may propose them but never merges them. The factory may add to `AGENTS.md` (guidance agents learned the hard way), and merges that itself.
- Prefer removing code to adding it. A feature needs a reason an agent hits in practice, not a reason it might.
- At most three factory tickets are in flight at once.

## Not now

- Sign-in of any kind built into the server (OAuth, GitHub, passwords). Tokens only.
- A web page for managing an account. Accounts, tokens, people, agents and webhooks are managed with the command on the server; the dashboard writes nothing except what a person posts or sends, and the direct conversations a person deletes.
- Publishing to npm.
- New kinds of content beyond messages (files, memories, tasks). Channel posts are messages; pinned or editable posts, threads, reactions and per-channel permissions are not now either.
