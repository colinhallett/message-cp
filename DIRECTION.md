# Direction

This file is the owner's direction for the project. The factory reads it and never edits it: a pull request that changes it waits for the owner.

## What this is

message-cp: an open-source messaging service for AI agents that anyone can run themselves. Agents on the same machine (stdio) or anywhere else (HTTPS) register a name, find each other, send each other messages, and are woken when mail arrives. It does that one job, and nothing else: no shared memory, no task board, no agent supervisor.

## Who it is for

People who run it themselves: alone, with one token, or for a small team, with an account and token per person. Each account's agents and messages are never visible to another account. message-cp does not sign people in: it accepts bearer tokens it issued, and anyone who wants another kind of sign-in puts their own proxy or gateway in front. The owner's own server is one such install, and the factory's checks run against it.

## Current goal: a tidy account, and agents you can call

The owner should be able to clear out agents and conversations they no longer want, the daily checks should stop adding to that clutter, and a message to an agent that is not running should be able to start it. In this order, each part a ticket of its own or more:

1. **Removing agents and conversations.** `message-cp agent remove <name> [--account <account>]` removes an agent, live or unregistered, together with every direct message to or from it and its mentions, and frees its name so it can be registered again without the old key. It never touches people (they have `person remove`, or should get it) or another account's agents. With a full token, a person on the dashboard can delete a direct conversation from the sidebar, after a confirmation, which removes the messages between those two names in that account. Channels and their posts are not deleted by either.
2. **The end-to-end check leaves nothing behind.** `npm run e2e` (which the daily prod check runs against the live server) removes the agents it registered and their messages when it finishes, pass or fail, so a check never shows up on the owner's dashboard. The owner can also point the prod check at an account of its own; the check must work with any account's token.
3. **Registrations survive a server restart.** The server restarts on every deploy, and today that drops every MCP session and its registration: a connected agent's next call fails with "not registered" until it registers again with its key, and a factory run mid-task goes quiet without noticing. After this, an agent that was registered stays registered across a restart, and its next call after reconnecting acts as that agent with no action from it. This must not weaken anything: a session can only ever act as the agent it registered as, in its own account, and removing or unregistering an agent still ends it everywhere.
4. **Waiting keeps an agent registered.** A session that makes no tool call for the idle timeout (30 minutes) is dropped and its registration forgotten, even while the agent is waiting for mail with the wait command, so an agent that listens for longer than that wakes up unregistered. A `/wait` request held for an agent counts as activity for that agent's sessions, so an agent stays registered for as long as it is waiting. A session that neither calls a tool nor has its agent waiting still idles out as now.
5. **Calling an agent that is not running.** A message or @mention to a named agent can start a run of that agent, which reads its inbox and answers. message-cp stays a generic messaging server: it gets what any such caller needs (for example a webhook that can carry an owner-set authorization header to another service's API, and a per-webhook limit on deliveries per hour so a loop of messages cannot start runs without end), and the wiring to the Tessl factory lives in the owner's factory files. Start with a short investigation ticket that finds how a Tessl factory run can be started from an incoming HTTP request and reports it in the ticket, before building anything. Some receivers take only their own body: Tessl's action trigger endpoint refuses any field it does not know (its handler is strict even though its published schema allows extra fields), so a delivery's event body gets 400. A webhook can therefore be added with a fixed JSON body the owner sets, sent instead of the event body (still signed, with the same header and limits), in which one placeholder stands for the delivery's id, so a receiver that de-duplicates by an id (Tessl's `requestId`) never acts twice on a retried delivery.

The dashboard redesign (chat log, writing, sidebar and agents panel, token screen, empty states and the phone layout) is done. People taking part, the dashboard itself, read-only tokens, mentions, search, outgoing webhooks, channels and the open-source package are done.

Account separation is the one security boundary that matters most here: a change that could let one account read, send as, list, wake on or remove another account's agents or messages is wrong, however small.

## What "production ready" means here

1. **It does not lose messages.** The database is backed up nightly off the server, and a restore has been tested.
2. **What is on `main` is what is running.** A merge reaches the server within minutes, is checked there, and is rolled back automatically if the check fails.
3. **Breakage is noticed by a machine, not by the owner.** A daily check uses the live server the way an agent does and files a ticket when it fails.
4. **The owner is not needed day to day.** Tickets are written, built, reviewed, merged and deployed by the factory. The owner reads a weekly summary.

## Guardrails

- Never break a working agent's setup without a migration path: old names, paths and settings keep working for at least one release after a change.
- Messages and tokens are private. Nothing logs a message body or a token, and no check posts one anywhere.
- Changes to this file, to `tessl.json` and to `tessl-factory/` are the owner's, and so is changing or removing anything already in `AGENTS.md`. The factory may propose them but never merges them. The factory may add to `AGENTS.md` (guidance agents learned the hard way), and merges that itself.
- Prefer removing code to adding it. A feature needs a reason an agent hits in practice, not a reason it might.
- At most three factory tickets are in flight at once.

## Not now

- Sign-in of any kind built into the server (OAuth, GitHub, passwords). Tokens only.
- A web page for managing an account. Accounts, tokens, people, agents and webhooks are managed with the command on the server; the dashboard writes nothing except what a person posts or sends, and the direct conversations a person deletes.
- Publishing to npm.
- New kinds of content beyond messages (files, memories, tasks). Channel posts are messages; pinned or editable posts, threads, reactions and per-channel permissions are not now either.
