---
name: agents-md-tidy
description: >-
  Weekly sweep of message-cp's AGENTS.md: pick the few rules that are better
  as a test or lint, or that apply to one area only, and file and delegate one
  Linear ticket to move them, so AGENTS.md keeps only what holds everywhere.
  Writes one ticket at most; changes no code and opens no pull request.
---

# AGENTS.md tidy

`AGENTS.md` is read in full by every factory run, whatever the task. Rules
get added to it one review finding at a time, and many of them only matter in
one part of the code, or describe a check an agent is trusted to run by hand.
You find a few of those each week and file one ticket that moves them to a
better place. The implementing agent does the work; you change no file, push
nothing and open no pull request.

## Where a rule should live

Each bullet or paragraph of `AGENTS.md` belongs in one of three places:

1. **A test or lint**, when the rule describes something a check can catch:
   a value that must be quoted, inputs that must be refused, a query plan
   that must use an index, a list of places that must stay in step. The
   check fails on a change that breaks the rule. The rule then leaves
   `AGENTS.md`, or shrinks to one line naming the check.
2. **An area file**, when the rule only matters while changing one part of
   the code: the dashboard script, the site and README copy, the HTTP request
   handling, the SQL. These go in `docs/agent-rules/<area>.md`, and
   `AGENTS.md` keeps one line per area saying which files it covers and to
   read it before changing them.
3. **`AGENTS.md` itself**, when it holds for every change: nothing crosses
   between accounts, the scale message-cp is built for, how to install,
   build and test, and the files a factory run must never commit.

A rule is never just deleted. If it names code that no longer exists on
`main`, the ticket says so, with what `git grep` found, and asks the
implementer to confirm before removing it.

## Environment

- `LINEAR_API_URL` and `LINEAR_TOKEN`: every Linear call goes to
  `$LINEAR_API_URL/graphql` with `Authorization: Bearer $LINEAR_TOKEN`. Never
  call `api.linear.app` directly. Write each request body to a file with an
  editor, never through shell interpolation. A response with `errors` is a
  failed call.
- `gh`, authenticated, for reading pull requests.

If `LINEAR_API_URL` or `LINEAR_TOKEN` is unset, stop and say which in the run
output. Never print a token, and never write one anywhere.

The working tree is a checkout of `main`. Record its commit with
`git rev-parse HEAD`.

## When to file nothing

Read these first, and file nothing (saying why in the run output) when:

- an open COL issue (state type not `completed` or `canceled`) has
  `<!-- agents-md-tidy -->` in its description: one tidy ticket at a time;
- an open pull request changes `AGENTS.md`
  (`gh pr list --state open --json number,title,files`);
- three or more COL issues are delegated to Tessl and in a state of type
  `unstarted` or `started`: the factory is busy with other work;
- `AGENTS.md` has nothing left in the first two places above.

Find the Tessl delegate's id with `viewer { id }` (your token acts as Tessl)
and the COL team's id and states with `teams(filter: { key: { eq: "COL" } })
{ nodes { id states { nodes { id name type position } } } }`.

## Choosing the rules

1. Read `AGENTS.md`, all of it, and `git log --oneline -20 -- AGENTS.md`.
   If `docs/agent-rules/` exists, read it too.
2. For each rule in the first two places, check what it names against
   `main` (`git grep`, reading the file). Note what already exists: a test
   that already catches it, an area file that already holds it.
3. Pick one group for this week: either up to four rules that become tests
   or lints, or the rules of one area. Prefer the group that takes the most
   words out of `AGENTS.md` for the least new code. Leave the rest for next
   week.

## Writing the ticket

Title: what is true when it is done, under 80 characters, for example
"The dashboard script's rules move out of AGENTS.md into their own file".

Description:

```markdown
## Outcome

AGENTS.md is shorter by <the rules below>, and none of what they protect is
lost: <each becomes a test or lint that fails when the rule is broken | they
move to docs/agent-rules/<area>.md, which AGENTS.md points to for <files>>.

Done when: <checkable from the PR, including AGENTS.md's word count before
and after (`wc -w AGENTS.md`)>.

## Invariants

1. Every rule listed below ends up in exactly one place: a check that fails
   when it is broken, an area file, or AGENTS.md. None is dropped. A rule
   that names code no longer on main is removed only after the implementer
   confirms that with `git grep`, and the PR says so.
2. A new test or lint is shown to fail on a change that breaks its rule
   (make the change on a scratch commit, run it, put the failing output in
   the PR description, then revert), and to pass on main.
3. Nothing else in AGENTS.md changes meaning. Rules not listed here stay
   word for word.
4. <For an area file:> AGENTS.md keeps one line naming the files the area
   covers and telling an agent to read docs/agent-rules/<area>.md before
   changing them.

## The rules

<Each rule, quoted or named by its opening words, with where it goes and
why, and what you checked on main (commit <sha>). The implementer re-checks
these against main before starting.>

## Approach

* <The smallest change: which test file or lint, or the new area file.>

## Verification

* `npm run build` and `npm test` pass.
* For each new check, the failing run on a scratch change and the passing run
  on the branch, in the PR description.
* A legibility review and a fresh-eyes subagent review of the diff before
  opening the PR.

## Not in scope

* Rules not listed above, and any change to what a rule requires.
* DIRECTION.md, tessl.json and anything under tessl-factory/.

<!-- agents-md-tidy -->
```

Every claim about the code in the ticket is checked against `main` first.
Never put a token, an environment value or a message body in it.

## Filing

1. Read the open issues again. If anything under "When to file nothing" now
   holds, stop and say so.
2. Create the issue in the COL team's `backlog` state with the lowest
   `position`, no delegate, estimate 3 (5 if it adds more than one test or
   lint): `issueCreate(input: {teamId, title, description, estimate,
   stateId})`.
3. In one call, `issueUpdate(id, input: {description, delegateId, stateId})`
   with the same description, the Tessl delegate's id, and the team's
   `unstarted` state with the lowest `position` (Todo). That update starts the
   implementation. Make no further write to the issue.

## Ending

Say in the run output: the `main` commit you read, `AGENTS.md`'s word count,
the ticket filed with its URL and the rules it covers, or why nothing was
filed.
