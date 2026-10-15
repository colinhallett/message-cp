# memory-cp

An MCP server that lets one owner's agents find each other. An agent registers a name and a short bio; every agent can list who is registered and when each was last active, send messages, and share memories. All sessions share one SQLite file, so an agent registered in one session is visible from every other. By default the server speaks stdio and opens no network port; `memory-cp serve` serves the same tools over HTTP (see [Serving over HTTP](#serving-over-http)).

## Build

Requires Node 22.12 or later.

```sh
npm install
npm run build
npm test
```

The server starts with `node dist/index.js`.

## Add it to an agent

Use the absolute path to the built file.

Claude Code:

```sh
claude mcp add memory-cp -- node /absolute/path/to/dist/index.js
```

Cursor (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "memory-cp": {
      "command": "node",
      "args": ["/absolute/path/to/dist/index.js"]
    }
  }
}
```

## Serving over HTTP

`memory-cp serve [--host <address>] [--port <port>] [--public-url <url>]` serves the same tools over MCP's streamable HTTP transport at `/mcp`, against the same database (`MEMORY_CP_DB`, else the default path), so agents on other machines share agents, messages, memories and tasks with local ones. The stdio server is unchanged and can run at the same time on the same database.

```sh
MEMORY_CP_HTTP_TOKEN=<long random secret> node dist/cli.js serve --port 8787
```

- **Token.** `serve` refuses to start unless `MEMORY_CP_HTTP_TOKEN` is non-empty. Every request must send `Authorization: Bearer <token>`; anything else gets 401 and nothing is touched. There is one token for the install; agents still prove who they are with their key when they register.
- **Address.** It binds to `127.0.0.1` on port 8787 unless `--host` / `--port` say otherwise. It speaks plain HTTP: **exposing it without HTTPS sends the token and every message in the clear.** Put a reverse proxy that terminates TLS (for example Caddy: `reverse_proxy 127.0.0.1:8787`) in front of it and expose only that.
- **Sessions.** Each MCP session has its own identity: register in it and its tools act as that agent. A session ends when the client sends DELETE or after 30 minutes idle.
- **`wait` over HTTP.** `GET /wait?agent=<name>` (same bearer token as `/mcp`) answers 200 with the same one-line summary as `memory-cp wait` as soon as that agent has unread mail, 204 after about four minutes without any (ask again), 404 for an unknown agent. It checks the database about once a second and never reads or marks anything. Start `serve` with `--public-url <the https URL clients use, without /mcp>` and the server's instructions and `register`'s `waitCommand` carry a ready-to-run `curl` loop; without it they leave the wait command out and remote agents call `read_inbox`. See "Waking a remote agent".

Add it to Claude Code:

```sh
claude mcp add --transport http memory-cp https://memory.example.com/mcp --header "Authorization: Bearer <token>"
```

## Database

Every server process reads and writes the same file: `MEMORY_CP_DB` if set, otherwise `~/.memory-cp/db.sqlite`. The directory is created if missing. The database runs in WAL mode with a busy timeout so several processes can share it.

## Tools

| Tool | What it does |
| --- | --- |
| `register(name, bio, key?)` | Registers this session as `name`. A new name creates the agent and returns its `key`, once; only a hash is stored. If the name already exists, this session takes that agent over and its bio is updated, but only with the agent's `key`; without it the call fails and nothing changes. An agent registered before keys existed has none: the next `register` claims it and returns a key. |
| `unregister(name?, key?)` | With no arguments, removes your own agent: its registration and the messages addressed to it. Tasks it claimed go back to open; memories it wrote and tasks it posted stay. This session is then unregistered until it calls `register` again. With `name` and `key`, removes that agent if `key` is its key (an agent registered before keys existed has none and can be removed by name alone); this works from a session that has not registered. A wrong or missing key fails and changes nothing. |
| `list_agents(limit?, offset?)` | Lists agents by name with bio and last-seen time, one page at a time (default 50, max 200). |
| `get_agent(name)` | Returns one agent, or an error if there is none. |
| `send_message(to, body)` | Sends `body` (at most 4000 characters, counted as code points) to the agent `to`, or to every other registered agent when `to` is `all`. A broadcast reaches only agents registered when it is sent. Fails if `to` is not registered. |
| `read_inbox(unread_only?, limit?, offset?)` | Returns one page (default 50, max 200) of your messages oldest first with sender, time, body and whether it was a broadcast, and marks them read; a full page means there may be more. `unread_only` defaults to true; with it false, use `offset` to page. Messages are not pushed by the server; to be woken instead of polling, see Waking on messages. |
| `remember(text, tags?)` | Stores a shared memory (at most 4000 characters, up to 20 tags of 1–50 characters) with you as author and the time stored. Returns it with its `id`. Memories cannot be edited. |
| `recall(query?, tags?, author?, limit?, offset?)` | Finds memories from any agent, newest first (default 20, max 100 per call; use `offset` to page back to older matches). `query` matches words in the text and is read as plain words: quotes, `*`, `-`, `:` and `AND` are not operators, and several words must all appear; `query` is at most 500 characters. `tags` keeps memories carrying all the given tags; `author` keeps one agent's (case-insensitive). Filters combine; with none, returns the newest. |
| `get_memory(id)` | Fetches one memory by id, in the same shape `recall` returns. Errors if the id does not exist. |
| `forget(id)` | Deletes a memory. Any registered agent can delete any memory. Errors if the id does not exist. |
| `forget_memories(tags?, author?, query?, dry_run?)` | Deletes every memory `recall` would find with the same filters, with no paging limit. At least one filter is required once `recall`'s clean-up is applied: a blank `query` or empty `tags` do not count. `dry_run` defaults to true and only returns the number of matches and up to 100 of their ids; with `dry_run: false` it deletes them all in one transaction and returns the count. |
| `post_task(title, details, tags?)` | Posts an open task to the shared board with you as poster. Title at most 200 characters, details at most 4000, tags as for `remember`. Returns the task with its `id`. |
| `list_tasks(status?, tags?, assignee?, limit?, offset?)` | Lists tasks oldest first, one page at a time (default 50, max 200). `status` is `open`, `claimed` or `done`; `tags` keeps tasks carrying all the given tags; `assignee` keeps one agent's (case-insensitive). Filters combine. |
| `get_task(id)` | Returns one task, including its result once done. |
| `claim_task(id)` | Claims an open task. When several agents claim at once, exactly one succeeds; the others get an error naming the holder. |
| `release_task(id)` | Puts a task you claimed back to open. Only the claimer can. |
| `complete_task(id, result)` | Marks a task you claimed as done with a result (at most 4000 characters) and sends it to the poster as a message. Only the claimer can. |

Names are 1–32 characters of letters, digits, `-` and `_`. They are compared case-insensitively and stored as first registered. `all` (any case) is reserved.

Who this session is lives only in the server process, not in the database. A process can be started as an agent with `MEMORY_CP_AGENT` and `MEMORY_CP_AGENT_KEY` (both or neither): at startup the agent is created with that key, or claimed if it has none, and the session acts as it from its first tool call, with no `register`. If the agent exists with a different key, the server prints an error and exits before serving any tool. Keys are never returned by `list_agents`, `get_agent` or messages. A tool that needs the caller's identity returns an error telling the agent to call `register` first. The session remembers which registration it belongs to and checks it against the database on every call, so once its agent is removed with `unregister` (by itself or by anyone holding the key) it is unregistered again, even if another session took the name over, and it never acts as a different agent that registers the same name later. A process started with `MEMORY_CP_AGENT` registers that agent again at startup, so a removed agent that a supervisor such as the hive starts comes back the next time it runs it. Every tool call from a registered session updates that agent's last-seen time.

Messages are stored once per recipient, so read state is per agent. `read_inbox` marks what it returns as read before the reply is sent; if a reply is lost, `read_inbox(unread_only: false)` returns the history. There is no pruning yet. Sessions that hold the same agent's key and take over its name share one inbox.

Memories are shared by every registered agent and live in the same database file. `remember`, `recall`, `get_memory`, `forget` and `forget_memories` need a registered session. Removing an agent does not delete its memories; use `forget_memories(author: ...)` for that. Author and time are fixed when a memory is stored. Keyword search uses SQLite FTS5 and matches whole words, not prefixes or stems.

## Waking on messages

`memory-cp wait <name>` blocks until the agent `<name>` has at least one unread message, prints one line with how many and from whom (never the bodies), and exits 0. It does not read or mark anything: `read_inbox` is still the only way to read mail. It uses the database the server uses (`MEMORY_CP_DB`, else the default path), checks about once a second, and exits 1 with an error if no agent has that name. Run it as `node /absolute/path/to/dist/cli.js wait <name>`.

An agent runs it as a background command (in Claude Code, a Bash call with `run_in_background`), and Claude Code wakes the session when it finishes, whether the agent is working or idle. The order matters: when it fires, call `read_inbox` first and then start the command again, because starting it before reading fires at once on the same message.

### Waking a remote agent

With `serve --public-url https://memory.example.com`, a remote agent needs only `sh` and `curl`. Tell it "register as X and turn on push": `register` returns `waitCommand`, a `curl` loop that asks `/wait` again after each 204 and exits 0 printing the summary when mail arrives (401 or 404 end it with a non-zero exit and a message). The agent runs it as a background command, calls `read_inbox` when it fires, then starts it again.

The token is read from the environment variable `MEMORY_CP_HTTP_TOKEN`, else from the file `~/.memory-cp/http-token` (put the same token you gave `serve` there, mode 0600). It is passed to `curl` on stdin, so it is never in the instructions, a tool result or a process list.

Sessions learn this from the server: its `initialize` result carries instructions that give the command with the absolute path of the built CLI and, if the server has `MEMORY_CP_DB` set, that variable. The name is a placeholder unless the process was started with `MEMORY_CP_AGENT`. `register` also returns the ready-to-run command, with the agent's name filled in, in `waitCommand`.

## Tasks

Tasks are a shared board in the same database. A task is `open`, `claimed` by one agent, or `done`; the only moves are open → claimed (`claim_task`), claimed → open (`release_task`, by the claimer) and claimed → done (`complete_task`, by the claimer). Any other move returns an error naming the current state and changes nothing. A claim is one conditional `UPDATE` inside an IMMEDIATE transaction, so when several server processes claim the same task at once exactly one wins. Completing a task changes its state and sends the poster one message from the claimer (`Task <id> done: <title>`, then the result) in a single transaction; a result too long for a message is shortened there and ends in `… (full result: get_task(<id>))`. No message is sent if the poster completes their own task. There is no claim expiry yet: a stuck claim is released by its claimer. Every task tool needs a registered session.

Keys only protect a name once every server process sharing the database runs a version that knows about them. A lost key cannot be recovered or rotated yet.

## Hive

`memory-cp hive --config hive.json` runs in the foreground and gives agents that are not running a way to receive work. About once a second it checks the database for unread messages to the agents named in the config. When one has some, the hive starts the agent's CLI in the agent's working directory with those messages as the prompt, resumes the agent's previous session, and lets it reply with `send_message`. Any agent on the same database can send it work. Stop it with Ctrl-C; it waits for running agents to finish first.

```json
{
  "pollMs": 1000,
  "agents": [
    {
      "name": "worker-1",
      "cli": "claude",
      "key": "a-secret-only-this-file-holds",
      "cwd": "/path/to/project",
      "model": "sonnet",
      "allowedTools": ["Read", "Grep", "Bash(git status)"],
      "timeoutSeconds": 600,
      "rolePrompt": "You are the docs worker."
    }
  ]
}
```

`cli` (`claude` by default, or `codex`), `model`, `rolePrompt` and `pollMs` are optional; the rest are required. Relative `cwd`s are resolved against the config file. The file holds keys, so `chmod 600` it; the hive warns if others can read it.

- **One run per agent.** Messages that arrive during a run wait for the next run, oldest first, at most 20 per run.
- **Read at start.** A run's messages are marked read when it starts, so a restart never hands them out again. If a run fails, those messages are not retried; the failure is in `hive_runs`.
- **Identity.** The run's `memory-cp` server starts as the agent through `MEMORY_CP_AGENT` and `MEMORY_CP_AGENT_KEY`. The key is written to a temporary MCP config with mode 0600, deleted when the run ends. It is not in the prompt, the logs or any command line. An agent in the config whose key does not match the database is skipped, with a log line.
- **Permissions.** Claude Code runs with `-p --permission-mode dontAsk --permission-prompts none`, so anything not in `allowedTools` is refused and nothing waits for a prompt. The `memory-cp` tools are always allowed. Settings files are not read (`--setting-sources ""`), so a `.claude/settings.json` in the agent's directory cannot grant more. There is no way to turn permission checks off.
- **Codex.** `"cli": "codex"` runs `codex exec --json` (`codex exec resume <thread id>` for later runs) and reads the session id from the `thread.started` event. Codex has no per-tool allowlist, so `allowedTools` maps onto its sandbox: an unscoped `Edit`, `Write`, `MultiEdit` or `NotebookEdit` entry gives `workspace-write`, anything else `read-only` (a scoped entry such as `Edit(src/**)` stays `read-only`, since the sandbox cannot confine writes to a path); `Bash(...)` patterns cannot be honoured per command. Approval is `never`, so a refused action fails rather than waiting. Sandbox and approval are `-c` overrides on every run (`codex exec resume` has no flag for either), user config and rules files are ignored, and the working directory is the agent's `cwd` (`-C` on a first run, the process's own on a resume). `memory-cp` is passed as a `mcp_servers.memory-cp` override; its identity and key reach it through the process environment, never argv, and are kept out of the commands Codex runs.
- **Failures.** A run that fails or exceeds `timeoutSeconds` (it is killed), or a CLI that is not installed, is recorded and does not affect the hive or other agents.
- **Records.** The `hive_runs` table holds, per run: agent, message ids, start and end time, exit status (`ok`, `exit N`, `timeout`, `error`, `abandoned`), session id and error text. The next run resumes the latest session id for that agent, unless a run that resumed it failed (including by timeout), in which case the agent starts a fresh session. Runs a killed hive left unfinished are marked `abandoned` once their heartbeat is 30 seconds stale (a live hive on the same database keeps its runs); an agent with an unfinished run is not started again by any hive until it ends or goes stale; their messages were already read and are not retried. An agent whose `cli` is unknown is skipped at startup, leaving its messages unread.

The command line for each agent CLI is built behind the small `AgentCli` interface in `src/hive/agent-cli.ts`; Claude Code and Codex are implemented.
