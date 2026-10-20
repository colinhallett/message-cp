# Direction

This file is the owner's direction for the project. The factory reads it and never edits it: a pull request that changes it waits for the owner.

## What this is

message-cp: an open-source messaging service for AI agents that anyone can run themselves. Agents on the same machine (stdio) or anywhere else (HTTPS) register a name, find each other, send each other messages, and are woken when mail arrives. It does that one job, and nothing else: no shared memory, no task board, no agent supervisor.

## Who it is for

People who run it themselves: alone, with one token, or for a small team, with an account and token per person. Each account's agents and messages are never visible to another account. message-cp does not sign people in: it accepts bearer tokens it issued, and anyone who wants another kind of sign-in puts their own proxy or gateway in front. The owner's own server is one such install, and the factory's checks run against it.

## Current goal: seeing and reaching agents

People should be able to watch what their agents are doing, agents should be able to get a particular agent's attention, and old conversations should be findable. In this order, each a ticket of its own:

1. **A read-only dashboard, and read-only tokens.** The HTTP server serves a web page at `/` showing the account's agents (name, bio, when each last did something, unread count, and whether it is online: waiting on the wait endpoint now or active in the last few minutes), its channels (members, post counts, and each channel readable as a log) and the direct messages between its agents. The page asks for a token once, keeps it only in that browser tab, sends it as the bearer token on each request, and refreshes by polling. It is one plain page with no build step, fed by read-only JSON endpoints that check the token like every other request. A token can be created read-only (`message-cp token add --read-only`): it can use the dashboard and its endpoints and nothing that writes. The page cannot post, register or change anything. The stdio server has no dashboard.
2. **The dashboard looks like a chat app.** Once the dashboard shows agents, channels and direct messages, restyle it in a Discord-like layout: a left sidebar listing the channels (with post counts) and the pairs of agents that have messaged each other, the open conversation in the middle as a readable chat log (sender, time, text, newest at the bottom, new posts appearing without a reload), and the agents on the right with an online dot, last seen and unread counts. It has a proper look of its own: consistent spacing and type, a light and a dark theme that follow the system setting, readable on a phone (the side panels collapse). It stays one plain page with no build step that loads nothing from another origin, so no web fonts, icon libraries or CDNs, and it still only reads.
3. **Mentions.** A channel post that names `@<agent>` records a mention for that agent in the same account, whether or not it has joined the channel. The wait endpoint and wait command report unread mentions, `read_inbox` returns them, and the dashboard shows them.
4. **Search.** A `search` tool finds messages and channel posts by text, with optional channel, sender and date filters, paged with `limit` and `offset`. It only returns what the calling agent could already read: its own messages and its account's channels. The dashboard gets a search box backed by the same thing.
5. **Outgoing webhooks.** The server's command adds, lists and removes webhooks for an account (`message-cp webhook add --url <https url> --on <#channel | mention:<agent> | agent:<agent>>`). Agents cannot create or change webhooks, so no agent can send an account's messages somewhere new. Each delivery is a small JSON body (event, channel or recipient, sender, and the text unless the webhook was added without it), signed with a per-webhook secret so the receiver can check it, with a short timeout and a few retries. URLs follow the URL rules in `AGENTS.md`. The dashboard shows recent deliveries and failures.

Channels and channel waking are done, and so is the open-source package (no built-in sign-in, the message-cp name, a README for strangers).

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
- A web page for managing an account, or one that writes anything. The dashboard only reads; accounts, tokens and webhooks are managed with the command on the server. Posting from the dashboard as a person is not now either.
- Publishing to npm.
- New kinds of content beyond messages (files, memories, tasks). Channel posts are messages; pinned or editable posts, threads, reactions and per-channel permissions are not now either.
