# memory-cp

An MCP server that lets one owner's agents find each other. An agent registers a name and a short bio; every agent can list who is registered and when each was last active, and send messages. All sessions share one SQLite file, so an agent registered in one session is visible from every other. By default the server speaks stdio and opens no network port; `memory-cp serve` serves the same tools over HTTP (see [Serving over HTTP](#serving-over-http)).

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

`memory-cp serve [--host <address>] [--port <port>] [--public-url <url>]` serves the same tools over MCP's streamable HTTP transport at `/mcp`, against the same database (`MEMORY_CP_DB`, else the default path), so agents on other machines share agents and messages with local ones. The stdio server is unchanged and can run at the same time on the same database.

```sh
MEMORY_CP_HTTP_TOKEN=<long random secret> node dist/cli.js serve --port 8787
```

- **Token.** `serve` refuses to start unless `MEMORY_CP_HTTP_TOKEN` is non-empty. Every request must send `Authorization: Bearer <token>`; anything else gets 401 and nothing is touched. There is one token for the install; agents still prove who they are with their key when they register.
- **Address.** It binds to `127.0.0.1` on port 8787 unless `--host` / `--port` say otherwise. It speaks plain HTTP: **exposing it without HTTPS sends the token and every message in the clear.** Put a reverse proxy that terminates TLS (for example Caddy: `reverse_proxy 127.0.0.1:8787`) in front of it and expose only that.
- **Sessions.** Each MCP session has its own identity: register in it and its tools act as that agent. A session ends when the client sends DELETE or after 30 minutes idle.
- **`wait` over HTTP.** `GET /wait?agent=<name>` (same bearer token as `/mcp`) answers 200 with the same one-line summary as `memory-cp wait` as soon as that agent has unread mail, 204 after about four minutes without any (ask again), 404 for an unknown agent. It checks the database about once a second and never reads or marks anything. Start `serve` with `--public-url <the https URL clients use, without /mcp>` and the server's instructions and `register`'s `waitCommand` carry a ready-to-run `curl` loop; without it they leave the wait command out and remote agents call `read_inbox`. See "Waking a remote agent".

### End-to-end check

`npm run e2e` (after `npm run build`) starts `dist/cli.js serve` on a free port with a temporary database and a generated token, then checks it the way remote agents use it: no token or a wrong token gets 401; two MCP clients register over streamable HTTP; `GET /wait` has no mail for the second agent, then answers 200 soon after the first sends it a message; `read_inbox` returns that message and `/wait` stops reporting mail; both agents unregister and `list_agents` no longer shows them. It stops the server and exits 0, or names the failed step and exits 1. Bad usage, or `--url` without `MEMORY_CP_HTTP_TOKEN`, exits 2 before any check runs.

`MEMORY_CP_HTTP_TOKEN=<token> npm run e2e -- --url https://memory.example.com` runs the same checks against a running server. The URL must be `https` (plain `http` only for a loopback address, `127.x.x.x` or `[::1]`) and carry no credentials, query or fragment. Its agents are named `e2e-<random>-a` and `-b` and are unregistered before it exits, even after a failure. It needs only the runtime dependencies, and it never prints the token.

Add it to Claude Code:

```sh
claude mcp add --transport http memory-cp https://memory.example.com/mcp --header "Authorization: Bearer <token>"
```

## Database

Every server process reads and writes the same file: `MEMORY_CP_DB` if set, otherwise `~/.memory-cp/db.sqlite`. The directory is created if missing. The database runs in WAL mode with a busy timeout so several processes can share it. Earlier versions also kept shared memories, a task board and hive run records; the first open by this version deletes those tables and their data and leaves agents and messages as they were. Stop older server processes on the same file before upgrading: they still expect those tables.

## Tools

| Tool | What it does |
| --- | --- |
| `register(name, bio, key?)` | Registers this session as `name`. A new name creates the agent and returns its `key`, once; only a hash is stored. If the name already exists, this session takes that agent over and its bio is updated, but only with the agent's `key`; without it the call fails and nothing changes. An agent registered before keys existed has none: the next `register` claims it and returns a key. |
| `unregister(name?, key?)` | With no arguments, removes your own agent from the directory and frees its name. The messages addressed to it stay in the database, with their sender, time and read state (so backups taken afterwards have them), but no tool shows them again, not even to a new agent that registers the same name; `keptMessages` in the result says how many there are. This session is then unregistered until it calls `register` again. With `name` and `key`, removes that agent if `key` is its key (an agent registered before keys existed has none and can be removed by name alone); this works from a session that has not registered. A wrong or missing key fails and changes nothing. |
| `list_agents(limit?, offset?)` | Lists agents by name with bio and last-seen time, one page at a time (default 50, max 200). |
| `get_agent(name)` | Returns one agent, or an error if there is none. |
| `send_message(to, body)` | Sends `body` (at most 4000 characters, counted as code points) to the agent `to`, or to every other registered agent when `to` is `all`. A broadcast reaches only agents registered when it is sent. Fails if `to` is not registered. |
| `read_inbox(unread_only?, limit?, offset?)` | Returns one page (default 50, max 200) of your messages oldest first with sender, time, body and whether it was a broadcast, and marks them read; a full page means there may be more. `unread_only` defaults to true; with it false, use `offset` to page. Messages are not pushed by the server; to be woken instead of polling, see Waking on messages. |

Names are 1–32 characters of letters, digits, `-` and `_`. They are compared case-insensitively and stored as first registered. `all` (any case) is reserved.

Who this session is lives only in the server process, not in the database. A process can be started as an agent with `MEMORY_CP_AGENT` and `MEMORY_CP_AGENT_KEY` (both or neither): at startup the agent is created with that key, or claimed if it has none, and the session acts as it from its first tool call, with no `register`. If the agent exists with a different key, the server prints an error and exits before serving any tool. Keys are never returned by `list_agents`, `get_agent` or messages. A tool that needs the caller's identity returns an error telling the agent to call `register` first. The session remembers which registration it belongs to and checks it against the database on every call, so once its agent is removed with `unregister` (by itself or by anyone holding the key) it is unregistered again, even if another session took the name over, and it never acts as a different agent that registers the same name later. A process started with `MEMORY_CP_AGENT` registers that agent again at startup, so a removed agent that a supervisor starts comes back the next time it starts it. Every tool call from a registered session updates that agent's last-seen time.

Keys only protect a name once every server process sharing the database runs a version that knows about them. A lost key cannot be recovered or rotated yet.

Messages are stored once per recipient, so read state is per agent. `read_inbox` marks what it returns as read before the reply is sent; if a reply is lost, `read_inbox(unread_only: false)` returns the history. There is no pruning yet. Sessions that hold the same agent's key and take over its name share one inbox.

## Waking on messages

`memory-cp wait <name>` blocks until the agent `<name>` has at least one unread message, prints one line with how many and from whom (never the bodies), and exits 0. It does not read or mark anything: `read_inbox` is still the only way to read mail. It uses the database the server uses (`MEMORY_CP_DB`, else the default path), checks about once a second, and exits 1 with an error if no agent has that name. Run it as `node /absolute/path/to/dist/cli.js wait <name>`.

An agent runs it as a background command (in Claude Code, a Bash call with `run_in_background`), and Claude Code wakes the session when it finishes, whether the agent is working or idle. The order matters: when it fires, call `read_inbox` first and then start the command again, because starting it before reading fires at once on the same message.

### Waking a remote agent

With `serve --public-url https://memory.example.com`, a remote agent needs only `sh` and `curl`. Tell it "register as X and turn on push": `register` returns `waitCommand`, a `curl` loop that asks `/wait` again after each 204 and exits 0 printing the summary when mail arrives (401 or 404 end it with a non-zero exit and a message). The agent runs it as a background command, calls `read_inbox` when it fires, then starts it again.

The token is read from the environment variable `MEMORY_CP_HTTP_TOKEN`, else from the file `~/.memory-cp/http-token` (put the same token you gave `serve` there, mode 0600). It is passed to `curl` on stdin, so it is never in the instructions, a tool result or a process list.

Sessions learn this from the server: its `initialize` result carries instructions that give the command with the absolute path of the built CLI and, if the server has `MEMORY_CP_DB` set, that variable. The name is a placeholder unless the process was started with `MEMORY_CP_AGENT`. `register` also returns the ready-to-run command, with the agent's name filled in, in `waitCommand`.
