---
name: prod-check
description: >-
  Daily check of the live message-cp server: run npm run e2e against it from a
  fresh checkout of main and, when it fails, file one Linear issue in COL
  labelled prod-check, or comment on the open one. Changes no code and opens no
  pull request.
---

# Prod check

You check the live message-cp server the way a remote agent uses it, and tell
the owner in Linear when it is broken. One run is one check. You change no
code, push nothing, and open no pull request.

## Environment

- `MESSAGE_CP_URL`: the live server, with or without `/mcp`.
- `MESSAGE_CP_HTTP_TOKEN`: its bearer token. Never print, echo or write it
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
   CHECK_DIR=$(mktemp -d /tmp/prod-check.XXXXXX); echo "$CHECK_DIR"
   git clone --quiet --depth 1 --branch main "$(git remote get-url origin)" "$CHECK_DIR/main"
   git -C "$CHECK_DIR/main" rev-parse HEAD
   ```

   Every path below is under this run's own `$CHECK_DIR` (the path it
   printed; set it again in each new shell). A run that overlaps another, a
   slow check or one triggered by hand, never touches its checkout or output.

3. Install with `npm ci --ignore-scripts --no-audit --no-fund` in
   `$CHECK_DIR/main`. The check needs only the MCP client, and the sandbox has
   no `make` to build `better-sqlite3`. If the install fails, that is a
   failure with the step `npm ci --ignore-scripts`.
4. Run the check and keep its output and exit code:

   ```bash
   cd "$CHECK_DIR/main"
   npm run e2e -- --url "$MESSAGE_CP_URL" > "$CHECK_DIR/out" 2>&1; echo $? > "$CHECK_DIR/code"
   ```

Exit code 0 is a pass. Any other code is a failure. Nothing else counts:
not the output, not your opinion of the server.

The failed step is taken from the **last** line of `$CHECK_DIR/out` that
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
  nodes { id identifier number url createdAt
    comments(last: 20, orderBy: createdAt) { nodes { body createdAt } } }
}
```

If there is more than one, use the one with the lowest `number` and say so
in the run output.

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

  Then run the lookup again. Another run may have filed one at the same
  time. If an open `prod-check` issue with a lower `number` than yours
  exists, comment your report on the lowest and cancel yours with
  `issueUpdate(id, input: {stateId})`, using the team's state of type
  `canceled` with the lowest `position`. Issue numbers are unique in the
  team, so overlapping runs always agree on one open issue.

The report, used as the issue description or the comment:

```text
The daily prod check failed.

- Step: <step name>
- Cause: <error code, or omit this line>
- Exit code: <code>
- Time: <time>
- main: <commit>
- Server: <origin>
```

`<origin>` is the output of
`node -e 'try { console.log(new URL(process.env.MESSAGE_CP_URL).origin) } catch { console.log("unparseable") }'`:
scheme, host and port only, never a user, password, path, query or fragment.
Write that, not `MESSAGE_CP_URL`, even when the check failed because the URL
was rejected.

That is all it contains. Do not paste the FAIL line, the rest of the e2e output, any message
body, the environment, or the token.

End every comment and description you write with `<!-- tessl-prod-check -->`.
That marker is how the next run tells this skill's comments from a person's.

## Ending

Say in the run output: pass or fail, the step, the commit, and what you did in
Linear with the issue's URL.
