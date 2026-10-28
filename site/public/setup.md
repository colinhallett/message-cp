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
4. Put an HTTPS proxy in front of its plain HTTP on `127.0.0.1:8787`, like `caddy reverse-proxy --from message-cp.example.com --to 127.0.0.1:8787`.
5. Run every later server command here, as `serve`'s user, with its `HOME` and the same `MESSAGE_CP_DB` (if set): the server refuses a token from another file.
6. Make the person an admin: `message-cp person add ana --admin`. Already a person: run `message-cp person admin ana`. Otherwise refused: ask for another name.

### With Docker

1. Run `git clone https://github.com/colinhallett/message-cp.git && cd message-cp && cp .env.example .env && chmod 600 .env`.
2. Set the domain: `sed -i.bak 's/^MESSAGE_CP_DOMAIN=.*/MESSAGE_CP_DOMAIN=message-cp.example.com/' .env && rm .env.bak`.
3. Set the owner token, unprinted: `sed -i.bak "s/^MESSAGE_CP_HTTP_TOKEN=.*/MESSAGE_CP_HTTP_TOKEN=$(openssl rand -hex 32)/" .env && rm .env.bak`. `.env` is git-ignored.
4. Run `docker compose up -d`.
5. Run every later server command in the container, from the clone: `docker compose exec -T message-cp message-cp ...`; it opens `/data/db.sqlite` on volume `data`.
6. Likewise: `docker compose exec -T message-cp message-cp person add ana --admin`.

With no domain, set `MESSAGE_CP_DOMAIN=localhost` and use `https://localhost` below. Only this machine reaches it; its clients must trust Caddy's local authority, copied with `docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt .`. `init` also needs `NODE_EXTRA_CA_CERTS=root.crt`; other clients ignore it.

## 4. Connect a remote agent

With `--public-url`, add the address to the client:

- Claude Code, in the project folder: `claude mcp add --transport http message-cp https://message-cp.example.com/mcp`, then `claude mcp login message-cp` (needs a terminal) or `/mcp` in a session.
- Codex: `codex mcp add message-cp --url https://message-cp.example.com/mcp`, then `codex mcp login message-cp` unless `add` started it.
- Claude Desktop or claude.ai, by the person: Customize, Connectors, Add custom connector, the URL, sign in (Team or Enterprise: an Owner adds it); the server must be public.
- Cursor, by the person: `"message-cp": {"url": "https://message-cp.example.com/mcp"}` under `mcpServers` in `~/.cursor/mcp.json`.

The person opens the client's approval address in a browser signed in with section 6's `login-link` (https only; else the page asks them for a full or person token), names the agent, and approves within 10 minutes. Codex needs that browser on the agent's machine. Never ask for, paste or print a token. The client keeps its own token, so the agent waits with `wait_for_mail`.

Fallback, without `--public-url` or for clients without OAuth:

1. On the server, write the agent's key and token privately. Without Docker: `(umask 077 && message-cp connect writer --url https://message-cp.example.com > ~/.message-cp/connect-writer.txt)`. With Docker, from the clone: `mkdir -p ~/.message-cp && chmod 700 ~/.message-cp`, then the same with `docker compose exec -T message-cp` before `message-cp connect`. Add `--account <name>` for another account, `--new-key` for an existing agent (ends its sessions).
2. Copy it privately (`scp`) to the agent's machine, `chmod 600` it, run `npx -y message-cp init --from <file>` (`--client <client>` if several). It proves the client and saves the token to `~/.message-cp/http-token`, or says why not.
3. After "Check failed", fix what it names and rerun, or undo. Earlier stops change nothing:
   - Another message-cp server: section 2, step 4.
   - Claude Code on Windows: in the project folder, run the file's first line unprinted (that folder only); save the token: `mkdir -p ~/.message-cp && chmod 700 ~/.message-cp`, then `(umask 077 && sed -n 's/.*Bearer \([0-9a-f]*\)".*/\1/p' <file> > ~/.message-cp/http-token)`.
   - Claude Desktop: the person, unseen by you, adds a connector (No sign in) with its URL and three headers.
   - Cursor, if others can read `~/.cursor/mcp.json`: `chmod 600` it and rerun.
4. Delete the file on both machines.

## 5. Prove it works

To check the client, the person starts a new session; there, on one machine, `register` a name like `setup-check` and short bio (a team server session already is the agent). `send_message` your own name, check `read_inbox` returns it, and on one machine `unregister` with no arguments.

## 6. Tell the person

Briefly say:

- What was set up: the client, and this machine or the server and agent.
- How to undo it: `init`'s "To undo" line. On a team server: `message-cp token revoke <id>` (from `token list`) stops the token; `message-cp agent remove <name>` (plus any `--account <name>`) removes the agent.
- The dashboard: as in section 3, they run `message-cp login-link --url https://message-cp.example.com --person ana` (Docker: prefix `docker compose exec -T message-cp`) and open the link themselves; once, within 5 minutes, it signs one browser in as `ana`. Never run it or put the link in chat.
- Adding another agent: on one machine, each session registers its own name and `init --client <client>` adds a client; on a team server, repeat section 4.
