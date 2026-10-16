---
name: prod-check
description: >-
  Hourly check of the live memory-cp server: run npm run e2e against it from a
  fresh checkout of main and, when it fails, file one Linear issue in COL
  labelled prod-check, or comment on the open one. Changes no code and opens no
  pull request.
---

# Prod check

You check the live memory-cp server the way a remote agent uses it, and tell
the owner in Linear when it is broken. One run is one check. You change no
code, push nothing, and open no pull request.

## Environment

- `MEMORY_CP_URL`: the live server, with or without `/mcp`.
- `MEMORY_CP_HTTP_TOKEN`: its bearer token. Never print, echo or write it
  anywhere, Linear included.
- `LINEAR_API_URL` and `LINEAR_TOKEN`: every Linear call goes to
  `$LINEAR_API_URL/graphql` with `Authorization: Bearer $LINEAR_TOKEN`. Never
  call `api.linear.app` directly. Write each request body to a file with an
  editor, never through shell interpolation. A response with `errors` is a
  failed call.

If any of these four is unset, stop and say which in the run output. Do not
run the check and do not write to Linear.

## The check

1. Record the time: `date -u +%Y-%m-%dT%H:%M:%SZ`.
2. Make a fresh checkout of `main` outside the working tree and record its
   commit. If the clone fails, stop and say so in the run output without
   writing to Linear: that is the factory failing, not the server.

   ```bash
   rm -rf /tmp/prod-check
   git clone --quiet --depth 1 --branch main "$(git remote get-url origin)" /tmp/prod-check
   git -C /tmp/prod-check rev-parse HEAD
   ```

3. Install with `npm ci --ignore-scripts --no-audit --no-fund` in
   `/tmp/prod-check`. The check needs only the MCP client, and the sandbox has
   no `make` to build `better-sqlite3`. If the install fails, that is a
   failure with the step `npm ci --ignore-scripts`.
4. Run the check and keep its output and exit code:

   ```bash
   cd /tmp/prod-check
   npm run e2e -- --url "$MEMORY_CP_URL" > /tmp/prod-check.out 2>&1; echo $? > /tmp/prod-check.code
   ```

Exit code 0 is a pass. Any other code is a failure. Nothing else counts:
not the output, not your opinion of the server.

The failed step is taken from the **last** line of `/tmp/prod-check.out` that
starts `FAIL ` (an earlier one may be `FAIL cleanup`). Report only the step
name: the text after `FAIL ` up to the first `: `. Never the rest of that
line, which can quote a message body or the server's error text. If the rest
of the line ends with a parenthesised error code such as `(ENOTFOUND)` or
`(ECONNREFUSED)`, report that code as the cause. For exit code 2, the step is
`usage`: the run itself was misconfigured. If there is no `FAIL` line, the
step is `no step reported`.

## Linear

The team is `COL`. Find the open check issue:

```graphql
issues(filter: { team: { key: { eq: "COL" } }, labels: { name: { eq: "prod-check" } },
  state: { type: { nin: ["completed", "canceled"] } } }) {
  nodes { id identifier url createdAt
    comments(last: 20, orderBy: createdAt) { nodes { body createdAt } } }
}
```

If there is more than one, use the oldest and say so in the run output.

**On a pass:**

- No open issue: do nothing.
- An open issue whose newest comment by `createdAt` carrying this skill's
  marker already says passing again: do nothing.
- Otherwise comment on it `Passing again at <time> on main <commit>.`
  Leave the issue open. Closing it is for whoever fixes it.

**On a failure:**

- An open issue: comment on it with the report below. Do not file another.
- None: file one with `issueCreate(input: {teamId, title, description,
  stateId, labelIds})`, with:
  - `teamId`: from `teams(filter: { key: { eq: "COL" } }) { nodes { id
    states { nodes { id type position } } labels { nodes { id name } } } }`.
  - `stateId`: the team's state of type `backlog` with the lowest
    `position`.
  - `labelIds`: the id of the `prod-check` label, from `issueLabels(filter:
    { name: { eq: "prod-check" } }) { nodes { id team { key } } }`, taking
    one whose team is `COL` or none (a workspace label). If there is none,
    create it with `issueLabelCreate(input: {name: "prod-check", teamId})`.
  - `title`: `Prod check failing: <failed step>`.
  - no `assigneeId` and no `delegateId`. What to build is for the planner and
    the owner to decide.

The report, used as the issue description or the comment:

```text
The hourly prod check failed.

- Step: <step name>
- Cause: <error code, or omit this line>
- Exit code: <code>
- Time: <time>
- main: <commit>
- Server: <MEMORY_CP_URL without any path>
```

That is all it contains. Do not paste the FAIL line, the rest of the e2e output, any message
body, the environment, or the token.

End every comment and description you write with `<!-- tessl-prod-check -->`.
That marker is how the next run tells this skill's comments from a person's.

## Ending

Say in the run output: pass or fail, the step, the commit, and what you did in
Linear with the issue's URL.
