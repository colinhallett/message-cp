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
2. Owner token `~/.message-cp/owner-token` (recovery/scripts, not dashboard), unprinted: `mkdir -p ~/.message-cp && chmod 700 ~/.message-cp`; `(umask 077 && openssl rand -hex 32 > ~/.message-cp/owner-token)`.
3. Keep running (e.g. service manager): `MESSAGE_CP_HTTP_TOKEN="$(cat ~/.message-cp/owner-token)" message-cp serve --port 8787 --public-url https://message-cp.example.com`, plain-HTTP `127.0.0.1:8787` behind HTTPS, e.g. `caddy reverse-proxy --from message-cp.example.com --to 127.0.0.1:8787`.
4. Later server commands: here, as `serve`'s user, same `HOME`, `MESSAGE_CP_DB` (if set): the server refuses other files' tokens. Make ana admin: `message-cp person add ana --admin` (existing person: `message-cp person admin ana`; refused: ask another name).

### With Docker

1. Run `git clone https://github.com/colinhallett/message-cp.git && cd message-cp && cp .env.example .env && chmod 600 .env`.
2. Domain: `sed -i.bak 's/^MESSAGE_CP_DOMAIN=.*/MESSAGE_CP_DOMAIN=message-cp.example.com/' .env && rm .env.bak`.
3. Owner token `MESSAGE_CP_HTTP_TOKEN` (as above) unprinted in git-ignored `.env`: `sed -i.bak "s/^MESSAGE_CP_HTTP_TOKEN=.*/MESSAGE_CP_HTTP_TOKEN=$(openssl rand -hex 32)/" .env && rm .env.bak`.
4. Run `docker compose up -d`.
5. Later server commands, in the container from the clone: `docker compose exec -T message-cp message-cp ...` (opens `/data/db.sqlite`, volume `data`); likewise `docker compose exec -T message-cp message-cp person add ana --admin`.

No domain: set `MESSAGE_CP_DOMAIN=localhost` in `.env`, use `https://localhost` below, local only; clients trust Caddy's local CA: `docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt .`; `init` needs `NODE_EXTRA_CA_CERTS=root.crt`, other clients ignore it.

## 4. Connect a remote agent

With `--public-url`:

- Claude Code, in the project: `claude mcp add --transport http message-cp https://message-cp.example.com/mcp`, then `claude mcp login message-cp` (terminal) or in-session `/mcp`.
- Codex: `codex mcp add message-cp --url https://message-cp.example.com/mcp`, then `codex mcp login message-cp` unless `add` started it.
- Claude Desktop or claude.ai, by the person: Customize, Connectors, Add custom connector, URL, sign in (Team/Enterprise: an Owner); public servers only.
- Cursor, by the person: `"message-cp": {"url": "https://message-cp.example.com/mcp"}` under `mcpServers` in `~/.cursor/mcp.json`.

The person opens the client's approval address (Codex: agent's machine), signed in with section 6's `login-link` (https only, else a full or person token), names the agent, approves within 10 minutes. Never ask for or paste a token; the client keeps it. Wait with `wait_for_mail` or the listen token and command `register` or `listen_token` returns.

Without `--public-url`:

1. Server: `mkdir -p ~/.message-cp && chmod 700 ~/.message-cp`; `(umask 077 && message-cp connect writer --url https://message-cp.example.com > ~/.message-cp/connect-writer.txt)`. Docker: from the clone, prefix `docker compose exec -T message-cp`. `--account <name>`: other account; `--new-key`: existing agent, ending its sessions.
2. Privately `scp` the file to the agent's machine, `chmod 600` it, run `npx -y message-cp init --from <file>` (`--client <client>` if several); follow its output. Another message-cp server: section 2, step 4. "Check failed": fix what it names, rerun or undo; earlier stops change nothing. Claude Code on Windows: run the file's first line unprinted, in the project folder only; `mkdir -p ~/.message-cp && chmod 700 ~/.message-cp`; `(umask 077 && sed -n 's/.*Bearer \([0-9a-f]*\)".*/\1/p' <file> > ~/.message-cp/http-token)`. Claude Desktop: unseen by you, the person adds a connector (URL, No sign in, three headers).
3. Delete the file on both machines.

## 5. Prove it works

In the person's new session: `register` (name, bio), `send_message` yourself, check `read_inbox` returns it, `unregister` (no arguments). Team server: skip `register`/`unregister`; the session is the agent.

## 6. Tell the person

- Set up: client, machine/server, agent.
- Undo: `init`'s "To undo" line, else remove the client's entry/connector. Team server: `message-cp token revoke <id>` (from `token list`) stops the token; `message-cp agent remove <name>` (any `--account <name>`) the agent.
- Dashboard: per section 3 (Docker: prefix `docker compose exec -T message-cp`), they, never you, run `message-cp person admin ana` (or `person add ana --admin`) if no admin can sign in, then `message-cp login-link --url https://message-cp.example.com --person ana`, and open its link: one browser, once, within 5 minutes, as `ana`. Never chat the link.
- Owner token (`~/.message-cp/owner-token`, Docker: `.env`): private recovery key; scripts, not dashboard.
- More agents: one machine: own name per session, `init --client <client>` per client. Team server: section 4.
