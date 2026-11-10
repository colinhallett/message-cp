

# Agent Rules <!-- tessl-managed -->

@.tessl/RULES.md follow the [instructions](.tessl/RULES.md)

## Design constraints

message-cp is a small server for a few people's agents, reached over stdio on its own machine or over HTTPS, with a handful to a few dozen agents per account. Agents and messages belong to accounts, and nothing may cross between accounts: a finding that one account can see or affect another account's data is always blocking. An agent's or person's name is unique only within its account, ignoring case (`agents.name` in `src/db.ts`), and every `message-cp` command that takes `--account` and acts on one account uses the owner account when it is left out (`opts.get("--account") ?? "owner"` in `src/cli.ts`), while `agent list`, `person list` and `webhook list` without it list every account. So a name used as a key outside the database, such as a file name on the client, also carries the account and the server, as `listenServer` in `src/wait.ts` does, and a command printed by `src/` or written in docs that acts on an agent made with `--account <name>` passes that same `--account`. Other scale, paging or permission concerns are weighed against that scale:

- Broadcast (`send_message` to `all`) reaches every registered agent in the sender's account; do not cap recipients.
- Paged tools (`list_agents`, `read_inbox`) use `limit` plus `offset`; keyset/cursor paging is out of scope unless a ticket asks for it.
- `openDb` creates a missing directory 0700 and database file 0600; it does not change permissions on existing user-created or configured locations.
- Small, contained bounds (an input-length cap, an index for an existing query) are welcome. A change to a documented contract, the config schema or all paging tools belongs in a follow-up issue: decline in the thread with the reason instead of pushing it.
- Rules for SQL that holds SQLite's write lock (inside `.immediate()`, or a `DELETE` whose cascade reaches a child table), for a paged read (`LIMIT ? OFFSET ?`) over a history table and for a table whose row ids the API, the dashboard or a tool hands out are in `docs/agent-rules/sql.md`. Read it before adding or changing SQL in `src/`, or `SCHEMA` and `migrate` in `src/db.ts`.
- Rules for request paths in `src/http.ts` (body, hold and outbound caps), for code that accepts a URL from a flag, environment variable or file (in `src/cli.ts`, `src/connect.ts`, `src/init.ts`, `src/wait.ts`, `scripts/` and `ops/*.sh`), for commands that code in `src/` prints for a person or agent to paste, and for files that code in `src/` writes a token or key into, or prints a command to write one into, are in `docs/agent-rules/http-and-cli.md`. Read it before changing any of them.
- Rules for text in `README.md`, `CONTRIBUTING.md`, `ops/*.md`, `site/src/pages/*.astro`, `site/public/llms.txt`, `site/public/setup.md`, tool and parameter `description`s in `src/server.ts` and `instructions()` in `src/wait.ts` (what to say about tokens, the claim-by-claim check, the wake-up instructions and its `git grep`, and where to run commands that open the database) are in `docs/agent-rules/copy.md`. Read it before changing any of them.
- Several processes may open the same database file at once: each `serve`, each stdio server (`src/index.ts` calls `openDb()`), and `message-cp wait` and the other CLI commands (`src/cli.ts` calls `openDb()`). `openDb` in `src/db.ts` turns on WAL and a busy timeout so they can, as the "Database" section of the reference, in `site/src/pages/tools.astro`, says. So state that another process also reads or changes (a delivery claim, a session record, a count kept across processes such as a webhook's hourly allowance) is decided in the database inside a transaction, never in one process's memory, as `claimWithin.immediate` in `src/webhooks.ts` does when it claims a delivery and uses its webhook's allowance; a cap on one process's own requests, such as `waiting` in `src/http.ts`, stays in that process's memory. A column, format or stored value that exists only in the branch's own commits is in no database made by code on main (a database someone ran an earlier commit of the branch against is not one to migrate): check with `git fetch origin` and then `git grep <exact name> origin/main -- src`, and if it is not there, decline a finding asking for a migration of it, giving that reason. Every `serve` runs with `startHttp`'s default for each option `src/cli.ts` does not pass; it passes only `token`, `host`, `port` and `publicUrl`, so `idleTimeoutMs` is always `DEFAULT_IDLE_TIMEOUT_MS`. Code may rely on `serve` using those defaults where a comment at that code says so, as the session sweep comment in `src/http.ts` does ("`serve` always uses the default"). A finding that needs processes to coordinate beyond this, such as revoking a request already running on another process, belongs in a follow-up issue.
- Rules for a tool that acts as the caller and for a statement that reads or changes the caller's own state (finding the caller by its `Identity`, not its name, and where matching by name stays right) are in `docs/agent-rules/caller-identity.md`. Read it before adding or changing a tool in `src/server.ts` or such a statement in `src/agents.ts`, `src/messages.ts` or `src/channels.ts`.
- Rules for requests in the dashboard script (`SCRIPT` in `src/dashboard.ts`): how each answer is tied to the token, view and form it began in, with its controller, counters, in-flight markers and 401 handling, are in `docs/agent-rules/dashboard.md`. Read it before changing the script.

## Setup

From a fresh checkout, install, build and test with:

```sh
npm ci --ignore-scripts
npm run build
npm test
```

Keep the whole `npm test` output rather than piping it through `tail`, for example `npm test > /tmp/test.log 2>&1; tail -5 /tmp/test.log; grep -n FAIL /tmp/test.log`, so a failure is named on the first run.

A test that starts `src/index.ts` (the stdio server) as a child process builds the child's `env` from `process.env` without `MESSAGE_CP_AGENT` and `MESSAGE_CP_AGENT_KEY`, as "reports package.json's version to a client over stdio" in `test/version.test.ts` does, and sets either one only on purpose. `registerFromEnv` in `src/agents.ts` refuses one without the other, so a child that inherits a shell's lone `MESSAGE_CP_AGENT_KEY` exits before the test starts.

`better-sqlite3` ships prebuilt binaries under `node_modules/better-sqlite3/prebuilds/` for Linux (glibc and musl), macOS and Windows on x64 and arm64, so skipping its install script loses nothing. Plain `npm ci` compiles it and fails where there is no `make` or C++ compiler. If plain `npm ci` has already failed that way, use the commands above instead: do not install a compiler, shim `better-sqlite3` over `node:sqlite`, run the tests in a container, or skip them. [Building and testing](CONTRIBUTING.md#building-and-testing) in `CONTRIBUTING.md` gives the same install for people changing the code.

- Before a factory run starts, the environment changes `tessl.json` and may change the agent config files `.mcp.json`, `.codex/config.toml` and `.cursor/mcp.json`, and it adds skill folders under `.agents/`, `.claude/skills/`, `.codex/skills/`, `.cursor/skills/`, `.github/skills/` and `.tessl/plugins/`; run `git status` before your first change to see them. These are not your changes: never commit them. Stage your own files by name (`git add src/... test/... README.md`), never with `git commit -a`, `git commit -am`, `git add -A` or `git add .`. Run `git diff --cached --stat` before each commit and check that none of the environment's files is listed. If one was committed, undo it in a new commit: `git checkout origin/main -- <file>` for a file that is on `origin/main`, `git rm -r --cached <path>` for one that is not.

### Running the server by hand

Start it with `node dist/cli.js serve --port <port> > /tmp/serve.log 2>&1 & echo $! > /tmp/serve.pid` and stop it with `kill "$(cat /tmp/serve.pid)"`. Never use `pkill -f` or `pgrep -f` with a pattern from your own command line, because it matches and kills your own shell (exit 144). Keep the stop command in a tool call of its own.

### Screenshots

A pull request that changes how a page looks (`site/`, or the dashboard in `src/dashboard.ts`) carries screenshots of it (see `DIRECTION.md`); read `docs/agent-rules/screenshots.md` before taking them.
