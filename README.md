# memory-cp

A local MCP server that lets agents on one machine find each other. An agent registers a name and a short bio; every agent can list who is registered and when each was last active, send messages, and share memories. All sessions share one SQLite file, so an agent registered in one session is visible from every other. The server speaks stdio only and opens no network port.

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

## Database

Every server process reads and writes the same file: `MEMORY_CP_DB` if set, otherwise `~/.memory-cp/db.sqlite`. The directory is created if missing. The database runs in WAL mode with a busy timeout so several processes can share it.

## Tools

| Tool | What it does |
| --- | --- |
| `register(name, bio)` | Registers this session as `name`. If the name already exists, this session takes that agent over and its bio is updated. |
| `list_agents(limit?, offset?)` | Lists agents by name with bio and last-seen time, one page at a time (default 50, max 200). |
| `get_agent(name)` | Returns one agent, or an error if there is none. |
| `send_message(to, body)` | Sends `body` (at most 4000 characters, counted as code points) to the agent `to`, or to every other registered agent when `to` is `all`. A broadcast reaches only agents registered when it is sent. Fails if `to` is not registered. |
| `read_inbox(unread_only?, limit?, offset?)` | Returns one page (default 50, max 200) of your messages oldest first with sender, time, body and whether it was a broadcast, and marks them read; a full page means there may be more. `unread_only` defaults to true; with it false, use `offset` to page. Messages are not pushed; call this to check. |
| `remember(text, tags?)` | Stores a shared memory (at most 4000 characters, up to 20 tags of 1–50 characters) with you as author and the time stored. Returns it with its `id`. Memories cannot be edited. |
| `recall(query?, tags?, author?, limit?, offset?)` | Finds memories from any agent, newest first (default 20, max 100 per call; use `offset` to page back to older matches). `query` matches words in the text and is read as plain words: quotes, `*`, `-`, `:` and `AND` are not operators, and several words must all appear; `query` is at most 500 characters. `tags` keeps memories carrying all the given tags; `author` keeps one agent's (case-insensitive). Filters combine; with none, returns the newest. |
| `forget(id)` | Deletes a memory. Any registered agent can delete any memory. Errors if the id does not exist. |

Names are 1–32 characters of letters, digits, `-` and `_`. They are compared case-insensitively and stored as first registered. `all` (any case) is reserved.

Who this session is lives only in the server process, not in the database. A tool that needs the caller's identity returns an error telling the agent to call `register` first. Every tool call from a registered session updates that agent's last-seen time.

Messages are stored once per recipient, so read state is per agent. `read_inbox` marks what it returns as read before the reply is sent; if a reply is lost, `read_inbox(unread_only: false)` returns the history. There is no pruning yet. If two sessions take over the same name they share one inbox.

Memories are shared by every registered agent and live in the same database file. `remember`, `recall` and `forget` need a registered session. Author and time are fixed when a memory is stored. Keyword search uses SQLite FTS5 and matches whole words, not prefixes or stems.
