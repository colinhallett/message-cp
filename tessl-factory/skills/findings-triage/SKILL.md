---
name: findings-triage
description: >-
  Daily triage of the open Tessl findings for message-cp (the ones Agent
  Retro writes): check each against main, DIRECTION.md and the open COL
  issues, then resolve it, ignore it with a reason, or turn it into a Linear
  ticket that Implement builds and Shepherd merges. Writes tickets and
  finding states only; changes no code and opens no pull request.
---

# Findings triage

Agent Retro reads recent runs and pull requests and writes findings: a
problem the agents keep hitting, the evidence, and a recommended fix. You
decide what happens to each open finding, so that the ones worth doing get
done by the factory without the owner reading them. You never implement
anything yourself: you change no file, push nothing and open no pull request.

## Environment

- `LINEAR_API_URL` and `LINEAR_TOKEN`, used exactly as
  `tessl-factory/skills/planner/SKILL.md` "Environment" says.
- `tessl`, authenticated. Findings: `tessl finding list --project <id>
  --state <state> --json --limit 100`, `tessl finding view <id> --json`,
  `tessl finding update <id> --file -` with a JSON object of the fields to
  change (`state` is one of `open`, `in-progress`, `resolved`, `ignored`;
  `analysis` replaces the analysis text), and `tessl finding link add <id>
  --type ticket --url <issue url>`.
- The project id is in `tessl.json` at the repository root, or from `tessl
  project repair --json` (`linkedProject.id`).
- `gh`, authenticated, for reading pull requests.

Inside a factory run, `tessl finding update` and `tessl finding link add` may
be refused (404) even though listing works. Treat both as best effort: try
them, and if they fail, carry on. The triage log (below) is the record that
must be written; a finding update is a convenience on top of it.

If any of these is missing, stop and say which in the run output. Never print
a token or write one anywhere. The working tree is a checkout of `main`;
record `git rev-parse HEAD`, and check every claim about the code against it.

## The triage log

One Linear document on the COL team, titled exactly `Findings triage log`,
records every decision. Find it with `documents(filter: { title: { eq:
"Findings triage log" } }) { nodes { id content } }`; create it with
`documentCreate(input: {teamId, title, content})` if it does not exist, and
change it with `documentUpdate(id, input: {content})`, keeping every existing
entry and adding yours at the end. One entry per decision, on one line:

```text
- <date> <finding id> "<finding title>": <resolved|ignored|owner|ticket> - <reason in one sentence> [<issue identifier and URL, if any>] (evidence seen: <latest observedAt of the finding>)
```

A finding is decided when the log has an entry for it whose `evidence seen` is
not older than the finding's latest observation. Skip decided findings, except
for the in-progress check below. A finding the retro has observed again since
its entry is undecided again: decide it afresh, knowing what was decided
before.

## The rules

1. **Only one triage run at a time.** Before any write, find the
   `findings-triage` schedule in `tessl schedule list --json --all` and apply
   the "Only one run" check from the planner skill to it.
2. **Every decision is checked.** Before acting on a finding, check what it
   says against `main` now: the files, functions and behaviour it names, and
   whether its recommendation is already in place. Findings are written from
   old commits; much of what they describe may be gone or fixed.
3. **The planner's limits apply to you too.** At most three delegated COL
   issues in flight (planner rule 1), and at most two tickets filed per run.
   The owner's files (planner rule 4) are never delegated.
4. **One finding, one outcome per run.** Never file two tickets for one
   finding, and never file a ticket for a finding already linked to an open
   COL issue.
5. **Nothing private** goes into a ticket, a finding or the run output: no
   token, message body or environment value.

## For each open finding

Read `tessl finding list ... --state open` and `--state in-progress`, then
the open COL issues and those closed in the last 30 days (the planner's
"Reading the record" queries), `DIRECTION.md` and `AGENTS.md`.

**Ticketed findings first.** For each finding whose latest log entry is
`ticket` or `owner`, or whose state is `in-progress`, read the linked COL
issue (from the log, or the finding's links). If it is
`completed` and its pull request merged, log `resolved - fixed by <issue>
(<pull request url>)` and set the finding `resolved` (best effort). If it was
canceled, the finding is undecided again: treat it below. Otherwise leave it.

**Then each undecided open finding**, choosing exactly one, and logging it:
wherever the steps below say to set a state, append to the analysis or link
a ticket on the finding, that is the best-effort update; the log entry is the
one that must be written.

- **Already done or obsolete.** `main` already does what the recommendation
  asks, or the code, tool or process the finding is about no longer exists.
  Set `resolved`, and append `Triage <date>: <what you checked, with file
  and commit>` to the analysis.
- **Not worth doing.** It conflicts with `DIRECTION.md` ("Not now", a
  guardrail, "prefer removing code"), the cost is out of proportion to what
  it saves, or the evidence does not hold up when checked. Set `ignored`,
  and append the reason to the analysis the same way. Be willing to say no:
  a finding is a suggestion, not an instruction.
- **Needs the owner.** It needs money, an account setting, a decision only
  the owner can make, or a change to the owner's files (planner rule 4;
  only adding lines to `AGENTS.md` is not one, so that goes under "Do it").
  File an owner ticket as the planner's "Filing" step 4 describes, link it to
  the finding, set the finding `in-progress`, and also send its URL to the
  owner's planning agent with `node tessl-factory/scripts/message-cp.mjs send
  claude-c "<one line>"`.
- **Do it.** Everything else that, checked, is real and worth the work.
  Write a ticket with the planner's template ("Writing a ticket"), where
  `Traces to:` is `Tessl finding <id>: "<finding title>"`, the Outcome states
  the expected improvement the finding gives, and the Approach is your own
  checked plan, not the finding's text copied. File and delegate it with the
  planner's "Filing" steps, link it to the finding, and set the finding
  `in-progress`.

If rule 3 stops you filing, leave the remaining findings `open` for the next
run and say so.

Write the log entry for a finding right after acting on it, not at the end,
so a run that stops part-way leaves a true record.

## Ending

Say in the run output: the `main` commit you read; for each finding its id,
title and outcome with the reason in one line; each ticket filed, with its
URL; and the findings left open, with why.
