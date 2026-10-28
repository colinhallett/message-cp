# Set up message-cp

You are an agent setting up message-cp, an MCP messaging server. Never print a token or key, put one in chat, or write one into a file that may be committed: only these steps' private files hold one. Needs Node 22.12+.

## 1. Ask the person

1. Ask: "Just this machine, or a team server other machines' agents reach over HTTPS?"
2. For a team server: "Which machine, with Docker or not, on what domain, and your dashboard name?" DNS must point there, ports 80 and 443 open. Examples: `message-cp.example.com`, `ana`.

Names: 1 to 32 letters, digits, `-` or `_`, not `all`. Ask nothing else unless a step says so.

## 2. Just this machine

1. Run `npx -y message-cp init`.
2. Several: rerun with your client's `--client`, else ask which.
3. None: ask them to install one it names.
4. Another message-cp server there: tell the person; only if they agree, run the printed removal, rerun.
5. "Check passed": a test agent messaged itself. Note the "To undo" line.

## 3. Start a team server

### Without Docker

1. Run `npm install -g message-cp`.
2. Make the owner token (recovery and scripts, not the dashboard) in `~/.message-cp/owner-token`, unprinted: `mkdir -p ~/.message-cp && chmod 700 ~/.message-cp`, then `(umask 077 && openssl rand -hex 32 > ~/.message-cp/owner-token)`.
3. Keep it running (as by a service manager): `MESSAGE_CP_HTTP_TOKEN="$(cat ~/.message-cp/owner-token)" message-cp serve --port 8787 --public-url https://message-cp.example.com`.
4. Front its plain HTTP on `127.0.0.1:8787` with an HTTPS proxy, like `caddy reverse-proxy --from message-cp.example.com --to 127.0.0.1:8787`.
5. Run later server commands here, as `serve`'s user, with its `HOME` and the same `MESSAGE_CP_DB` (if set): the server refuses another file's tokens.
6. Make the person an admin: `message-cp person add ana --admin`; already a person, `message-cp person admin ana`; refused, ask another name.

### With Docker

1. Run `git clone https://github.com/colinhallett/message-cp.git && cd message-cp && cp .env.example .env && chmod 600 .env`.
2. Set the domain: `sed -i.bak 's/^MESSAGE_CP_DOMAIN=.*/MESSAGE_CP_DOMAIN=message-cp.example.com/' .env && rm .env.bak`.
3. Set the owner token (recovery and scripts, not the dashboard) as `MESSAGE_CP_HTTP_TOKEN` in `.env`, unprinted: `sed -i.bak "s/^MESSAGE_CP_HTTP_TOKEN=.*/MESSAGE_CP_HTTP_TOKEN=$(openssl rand -hex 32)/" .env && rm .env.bak`. `.env` is git-ignored.
4. Run `docker compose up -d`.
5. Run later server commands in the container, from the clone: `docker compose exec -T message-cp message-cp ...`; it opens `/data/db.sqlite` on volume `data`.
6. Likewise: `docker compose exec -T message-cp message-cp person add ana --admin`.

With no domain, set `MESSAGE_CP_DOMAIN=localhost` and use `https://localhost` below. Only this machine reaches it; clients must trust Caddy's local authority, from `docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt .`. `init` also needs `NODE_EXTRA_CA_CERTS=root.crt`; other clients ignore it.

## 4. Connect a remote agent

With `--public-url`:

- Claude Code, in the project: `claude mcp add --transport http message-cp https://message-cp.example.com/mcp`, then `claude mcp login message-cp` (terminal) or in-session `/mcp`.
- Codex: `codex mcp add message-cp --url https://message-cp.example.com/mcp`, then `codex mcp login message-cp` unless `add` started it.
- Claude Desktop or claude.ai, by the person: Customize, Connectors, Add custom connector, URL, sign in (Team/Enterprise: an Owner); public servers only.
- Cursor, by the person: `"message-cp": {"url": "https://message-cp.example.com/mcp"}` under `mcpServers` in `~/.cursor/mcp.json`.

The person opens the client's approval address in a browser signed in with section 6's `login-link` (https only, else it asks for a full or person token; Codex: agent's machine), names the agent, approves within 10 minutes. Never ask for or paste a token: the client keeps it; wait with `wait_for_mail`.

Fallback, no `--public-url`/OAuth:

1. Server: `mkdir -p ~/.message-cp && chmod 700 ~/.message-cp`; `(umask 077 && message-cp connect writer --url https://message-cp.example.com > ~/.message-cp/connect-writer.txt)`. Docker: from the clone, prefix `message-cp connect` with `docker compose exec -T message-cp`. `--account <name>`: other account; `--new-key`: existing agent, ending its sessions.
2. Privately `scp` the file to the agent's machine, `chmod 600` it, run `npx -y message-cp init --from <file>` (`--client <client>` if several); follow its output. Another message-cp server: section 2, step 4. "Check failed": fix what it names, rerun or undo; earlier stops change nothing. Claude Code on Windows: run the file's first line unprinted, in the project folder only; `mkdir -p ~/.message-cp && chmod 700 ~/.message-cp`; `(umask 077 && sed -n 's/.*Bearer \([0-9a-f]*\)".*/\1/p' <file> > ~/.message-cp/http-token)`. Claude Desktop: unseen by you, the person adds a connector (URL, No sign in, three headers).
3. Delete the file on both machines.

## 5. Prove it works

The person starts a new session; there, on one machine, `register` a name and bio (a team server session already is the agent). `send_message` your own name, check `read_inbox` returns it, and on one machine `unregister` without arguments.

## 6. Tell the person

- What's set up: client, machine or server, agent.
- Undoing: `init`'s "To undo" line, else remove the client's entry or connector. On a team server, `message-cp token revoke <id>` (from `token list`) stops the token; `message-cp agent remove <name>` (plus any `--account <name>`) removes the agent.
- The dashboard: as in section 3, they run `message-cp login-link --url https://message-cp.example.com --person ana` (Docker: prefix `docker compose exec -T message-cp`) and open the link themselves; once, within 5 minutes, it signs one browser in as `ana`. Never run it or put the link in chat. If no admin can sign in, they first run `message-cp person admin ana` (or `person add ana --admin`) likewise.
- The owner token: recovery key, for scripts, not the dashboard; they keep it private (`~/.message-cp/owner-token`, Docker: `.env`).
- Another agent: on one machine, each session registers its own name; `init --client <client>` adds a client; team server: section 4.
