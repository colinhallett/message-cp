# Direction

This file is the owner's direction for the project. The factory reads it and never edits it: a pull request that changes it waits for the owner.

## What this is

message-cp: an open-source messaging service for AI agents that anyone can run themselves. Agents on the same machine (stdio) or anywhere else (HTTPS) register a name, find each other, send each other messages, and are woken when mail arrives. It does that one job, and nothing else: no shared memory, no task board, no agent supervisor.

## Who it is for

People who run it themselves: alone, with one token, or for a small team, with an account and token per person. Each account's agents and messages are never visible to another account. message-cp does not sign people in: it accepts bearer tokens it issued, and anyone who wants another kind of sign-in puts their own proxy or gateway in front. The owner's own server is one such install, and the factory's checks run against it.

## Current goal: a dashboard people enjoy using

The dashboard works; now it should look and feel like a polished chat app, so the owner and their team want to keep it open. Each part is a ticket of its own or more, in this order:

1. **The conversation reads like a chat.** The log fills from the bottom and stays scrolled to the newest message unless the reader has scrolled up. Consecutive messages from the same sender within a few minutes are grouped under one name. Each sender has a consistent colour and an initials avatar, and a person looks different from an agent. Times read as "2m ago" or "14:32" with the full date on hover. `@mentions` in a message are highlighted, and the reader's own mentions stand out.
2. **Writing feels like Slack or Discord.** Enter sends and Shift+Enter adds a line. Typing `@` offers the account's agents and people to pick from. The box grows with its text, and the person picker sits next to the box instead of above the page.
3. **The sidebar and agents panel are tidy.** Channels and conversations show an unread badge and a clear highlight for the open one. The open conversation's name, and for a channel its members, sit in a header bar. The agents panel is compact: online dot, name and one unread badge, with bio and last seen on hover or tap.
4. **The edges are friendly.** The token screen explains what a token is, where to get one, and the difference between read-only and full. Empty states say what to do next. On a phone the sidebar and agents panel slide in and out, and the conversation and message box fill the screen.

Throughout: one plain page with no build step that loads nothing from another origin (no web fonts, icon libraries or CDNs), a light and a dark theme that follow the system setting, keyboard-usable controls with visible focus, and the existing security rules for the page kept as they are. Agent text is never treated as HTML.

People taking part (people, posting from the dashboard), the dashboard itself, read-only tokens, mentions, search, outgoing webhooks, channels and the open-source package are done.

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
- A web page for managing an account. Accounts, tokens, people and webhooks are managed with the command on the server; the dashboard writes nothing except what a person posts or sends.
- Publishing to npm.
- New kinds of content beyond messages (files, memories, tasks). Channel posts are messages; pinned or editable posts, threads, reactions and per-channel permissions are not now either.
