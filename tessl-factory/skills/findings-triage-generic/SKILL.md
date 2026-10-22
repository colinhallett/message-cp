---
name: findings-triage-generic
description: >-
  Triage a project's open Tessl findings in any Tessl factory: check each
  against the code, then resolve it, ignore it with a reason, hand it to a
  person, or file a ticket the factory's own ticket-to-PR loop will build.
  Works out from the factory itself where tickets come from (Linear, GitHub
  issues or something else) and how to file one so the factory picks it up.
  Writes tickets and finding states only; changes no code and opens no pull
  request.
---

# Findings triage

Tessl's review loops (Agent Retro and others) write findings: a problem the
agents keep hitting, the evidence, and a recommended fix. You decide what
happens to each open finding, so that the ones worth doing get built by the
factory without a person reading them. You never implement anything yourself:
you change no file in the repository, push nothing and open no pull request.

Your run's instructions may add rules for this factory: where to record
decisions, who to tell, limits, files only people may change. They come
first wherever they differ from this skill.

## 1. Find the findings

- The project id is in `tessl.json` at the repository root, or from
  `tessl project repair --json` (`linkedProject.id`).
- `tessl finding list --project <id> --state open --json --limit 100`, and the
  same with `--state in-progress`. `tessl finding view <id> --json` gives one
  in full.
- Changing a finding: `tessl finding update <id> --file -` with a JSON object
  (`state` is `open`, `in-progress`, `resolved` or `ignored`; `analysis`
  replaces the analysis text), and `tessl finding link add <id> --type ticket
  --url <url>`. Inside a factory run these may be refused (404). Treat them as
  best effort and keep a record elsewhere (section 6).

The working tree is a checkout of the default branch. Record `git rev-parse
HEAD`; every claim about the code is checked against it.

## 2. Work out how this factory takes work

Find the loop that turns a ticket into a pull request, and exactly what
starts it. Do this from the factory's own configuration, in this order:

1. **The triggers in `tessl.json`.** Find the triggers whose action implements
   a ticket (its skill is an implement skill, or its name or instructions say
   it builds an issue into a PR) and that fire on an issue event, such as
   `linear:Issue.create` / `linear:Issue.update` or `github:issues.labeled`.
   Read every condition under `when` and `on`: those are what a ticket must
   satisfy. Typical ones: a Linear delegate id (`event.data.delegateId`) and a
   state type (`event.data.state.type`); a GitHub label name
   (`event.label.name`). If several triggers route by a field (for example an
   estimate choosing between actions), note that too. Also note any trigger
   that would fire again on later edits, so you know to make the ticket
   complete before it first matches.
2. **If `tessl.json` has no such trigger,** ask Tessl:
   `tessl api /experimental/projects/<id>/factory/ticket-to-pr`. Its
   `issueSource.type` names the issue source (`linear` or `github`) and its
   `loops` show the triggers the standard setup uses. For a standard setup,
   `POST /experimental/projects/<id>/factory/implement/issues` (Linear) or
   `.../implement/github-issues` (GitHub) creates a ticket the factory will
   pick up; read their descriptions in `https://api.tessl.io/openapi.json`
   before using them.
3. **If neither finds a way in,** the factory takes no tickets: you can only
   resolve, ignore or hand findings to a person. Say so in your output.

Then find how you can reach that tracker from this run: for Linear, the
environment (for example `LINEAR_API_URL` / `LINEAR_TOKEN`, or a Linear MCP
server); for GitHub, `gh`. If you can read but not write, decide and record,
but file nothing, and say why.

State in your output, in one or two lines, what you found: the source, the
conditions a ticket must meet, and how you will meet them.

## 3. Learn how tickets are written here

A ticket here is read by an implementing agent that does exactly what it says.
Match the project's own way of writing them. Look, in this order, for:

1. A skill or doc in the repository about writing or filing tickets (search
   the factory's plugin directories, `.tessl/plugins/`, `.claude/skills/`,
   `.agents/`, `docs/` for planner, ticket or issue skills).
2. The last few tickets that the factory built into merged pull requests:
   their sections, length, tone, labels, estimate and any trailer lines.
3. If there is neither, use: a one-line outcome, "Done when" bullets you can
   check, the invariants the change must keep, an approach in a few bullets
   with what you checked, and `Traces to: Tessl finding <id>: "<title>"`.

Every claim in a ticket about the code (files, functions, commands,
behaviour) is checked against the checkout before you file it.

## 4. Learn this project's rules

Read `AGENTS.md`, `CLAUDE.md`, any direction or roadmap document the
repository keeps (such as `DIRECTION.md`), and `CODEOWNERS` if present. From
them, and from your instructions, note:

- Work the project has ruled out or deferred: never file it.
- Files or areas only people may change: such work is filed for a person,
  not for the factory.
- Limits on work in flight. If none is given: file at most two tickets per
  run, and none while three or more factory tickets are already in flight.

## 5. Decide each finding

First, findings already ticketed (state `in-progress`, a ticket link, or a
record from an earlier run): if the ticket was completed and its pull request
merged, mark the finding `resolved` with the fix; if it was canceled, decide
the finding again below; otherwise leave it.

Then each undecided finding gets exactly one outcome. Check what it says
against the code first: findings are written from older commits and often
describe something since fixed or removed.

- **Resolved:** the code already does what the recommendation asks, or what
  the finding is about no longer exists. Say what you checked, with file and
  commit.
- **Ignored:** it conflicts with the project's direction or rules, the cost is
  out of proportion to the benefit, or the evidence does not hold up. Say why.
  A finding is a suggestion, not an instruction: be willing to say no.
- **For a person:** it needs money, an account setting, a decision only a
  person can make, or a change to files only people may change. File a ticket
  that does not start the factory (it does not meet the trigger's
  conditions), and tell whoever your instructions name.
- **Ticket:** everything else that is real and worth the work. Write it as
  section 3 says and file it so that it meets every condition from section 2.
  If a trigger fires on edits while the ticket matches, create it first in a
  state that does not match, then change it to the matching state with its
  full text in one update, and never touch it again.

Never file two tickets for one finding, or a ticket for a finding already
linked to an open one.

## 6. Record every decision

For each finding, right after acting on it: set its state and, for a ticket,
link it (best effort), and append to its analysis `Triage <date>: <outcome> -
<reason>`. Also write the decision wherever your instructions say decisions
are recorded. If finding updates are refused and your instructions name no
other record, keep one in the tracker you file to (a document or issue titled
`Findings triage log`, one line per decision with the finding id, outcome,
reason and any ticket), and read it at the start of the next run to know what
is decided.

## 7. Only one run, nothing private

- Before your first write, check for another run of this skill on this
  repository (`tessl launch list --json --limit 50`: same `config.skillRef`
  and `config.repoUrl`, status `pending` or `running`, not
  `$TESSL_LAUNCH_RUN_ID`). If an earlier one is running, write nothing and
  stop.
- Never put a token, an environment value or a message body into a ticket, a
  finding or your output.

## Ending

Say in your output: the commit you read; how this factory takes tickets (from
section 2); for each finding its id, title, outcome and one-line reason; each
ticket filed, with its URL; and the findings left open, with why.
