# Set up message-cp

You are an agent setting up message-cp, an MCP server for agent messaging. Never print a token or key, put one in chat, or write one into a file that may be committed: only these steps' private files hold one. Needs Node 22.12+.

## 1. Ask the person

1. Ask: "Just this machine, or a team server that other machines' agents reach over HTTPS?"
2. For a team server: "Which machine runs it, with Docker or without, on what domain, and your name in the dashboard?" DNS must point there, ports 80 and 443 open. Examples use `message-cp.example.com` and `ana`.

Names are 1 to 32 letters, digits, `-` or `_`, not `all`. Ask nothing else unless a step says so.

## 2. Just this machine

1. Run `npx -y message-cp init`.
2. If several, rerun it with your client's `--client`, else ask which.
3. If none, ask them to install one it names.
4. If another message-cp server is there, tell the person; only if they agree, run the printed removal and rerun `init`.
5. "Check passed" means a test agent messaged itself. Note the "To undo" line.

## 3. Start a team server

### Without Docker

1. Run `npm install -g message-cp`.
2. Make the owner token, unprinted: `mkdir -p ~/.message-cp && chmod 700 ~/.message-cp`, then `(umask 077 && openssl rand -hex 32 > ~/.message-cp/owner-token)`.
3. Keep it running (as by a service manager): `MESSAGE_CP_HTTP_TOKEN="$(cat ~/.message-cp/owner-token)" message-cp serve --port 8787 --public-url https://message-cp.example.com`.
4. It serves plain HTTP on `127.0.0.1:8787`: put an HTTPS proxy in front, like `caddy reverse-proxy --from message-cp.example.com --to 127.0.0.1:8787`.
5. Run every later server command here, as `serve`'s user, with its `HOME` and the same `MESSAGE_CP_DB` (if set): they open the database file directly; the server refuses a token from another file.
6. Make the person an admin: `message-cp person add ana --admin`. Already a person: run `message-cp person admin ana`. Otherwise refused: ask for another name.

### With Docker

1. Run `git clone https://github.com/colinhallett/message-cp.git && cd message-cp && cp .env.example .env && chmod 600 .env`.
2. Set the domain: `sed -i.bak 's/^MESSAGE_CP_DOMAIN=.*/MESSAGE_CP_DOMAIN=message-cp.example.com/' .env && rm .env.bak`.
3. Set the owner token, unprinted: `sed -i.bak "s/^MESSAGE_CP_HTTP_TOKEN=.*/MESSAGE_CP_HTTP_TOKEN=$(openssl rand -hex 32)/" .env && rm .env.bak`. `.env` is git-ignored.
4. Run `docker compose up -d`. It stops if either setting is empty.
5. Run every later server command in the container, from the clone: `docker compose exec -T message-cp message-cp ...`, which opens `/data/db.sqlite` on volume `data`.
6. As step 6 above, in this form: `docker compose exec -T message-cp message-cp person add ana --admin`.

With no domain, set `MESSAGE_CP_DOMAIN=localhost` and use `https://localhost` below. Only this machine reaches it; its clients must trust Caddy's local authority, copied with `docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt .`. `init` also needs `NODE_EXTRA_CA_CERTS=root.crt`; other clients ignore it.

## 4. Connect a remote agent

Codex needs only a server run with `--public-url`: skip steps 1-5; on the agent's machine, run `codex mcp add message-cp --url https://message-cp.example.com/mcp`, then `codex mcp login message-cp` unless `add` started it. Within 10 minutes, whoever holds the account's full or person token opens the printed address there and approves, naming the agent; never ask for, paste or print that token. Codex keeps its own token, so the agent waits with `wait_for_mail`.

1. Name the agent, like `writer`. On the server, write its key and agent token to a private file. Without Docker: `(umask 077 && message-cp connect writer --url https://message-cp.example.com > ~/.message-cp/connect-writer.txt)`. With Docker, from the clone: `mkdir -p ~/.message-cp && chmod 700 ~/.message-cp`, then the same with `docker compose exec -T message-cp` before `message-cp connect`. Add `--account <name>` for another account, `--new-key` for an existing agent (ends its sessions).
2. Copy the file privately (as by `scp`) to the agent's machine; `chmod 600` it, as `init` refuses wider modes outside Windows.
3. There, run `npx -y message-cp init --from <file>`, with `--client <client>` if several. It checks the token and key, sets up and proves the client, and saves the token to `~/.message-cp/http-token` for waking, or says why not.
4. After "Check failed", the client is set up: fix what it names and rerun `init`, or run its undo. If `init` stopped earlier, it changed nothing and says why:
   - Another message-cp server: section 2, step 4.
   - Claude Code on Windows: from the agent's project folder, run, unprinted, the `claude mcp add` command on the file's first line (that folder only). Then save the token unprinted: `mkdir -p ~/.message-cp && chmod 700 ~/.message-cp`, then `(umask 077 && sed -n 's/.*Bearer \([0-9a-f]*\)".*/\1/p' <file> > ~/.message-cp/http-token)`.
   - Claude Desktop: the person opens the file, unseen by you, and adds a custom connector (Customize, Connectors, Add, Add custom connector, No sign in) with its URL and three headers.
   - Cursor, when others can read `~/.cursor/mcp.json`: `chmod 600 ~/.cursor/mcp.json`, then rerun `init`.
5. Once set up, delete the file on both machines.

## 5. Prove it works

"Check passed" proves the server. To check the client, the person starts a new session; there, on one machine, `register` a name like `setup-check` and short bio (a team server session already is the agent). `send_message` your own name, check `read_inbox` returns it, and on one machine `unregister` with no arguments.

## 6. Tell the person

Briefly say:

- What was set up: the client, and this machine or the server and agent.
- How to undo it: `init`'s "To undo" line. On a team server (section 3): `message-cp token revoke <id>` (from `token list`) stops the token; `message-cp agent remove writer` (plus any `--account <name>`) removes the agent.
- The dashboard: as in section 3, they run `message-cp login-link --url https://message-cp.example.com --person ana` (Docker: prefix `docker compose exec -T message-cp`) and open the link themselves; once, within 5 minutes, it signs one browser in as `ana`. Never run it or put the link in chat.
- Adding another agent: on one machine, each session registers its own name and `init --client <client>` adds a client; on a team server, repeat section 4.
