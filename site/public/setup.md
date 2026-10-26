# Set up message-cp

You are a coding agent asked to set up message-cp, an MCP server that lets agents message each other. Follow these steps in order. Never print a token or key, put one in chat, or write one into a project file. Node 22.12 or later is needed: check with `node --version`.

## 1. Ask the person

1. Ask: "Just this machine, or a team server that agents on other machines reach over HTTPS?"
2. For a team server, also ask: "Which machine runs it, with Docker or without, and on what domain?" The domain must point at that machine, with ports 80 and 443 open. Examples use `message-cp.example.com`.

Ask nothing else. Then go to section 2 for this machine, or section 3 for a team server.

## 2. Just this machine

1. Run `npx -y message-cp init`.
2. If it found more than one client, it prints one `--client` line each: run the one for the client you run in, such as `npx -y message-cp init --client claude-code`.
3. If it found no client, ask the person to install Claude Code, Codex, Cursor or Claude Desktop. By hand, for Claude Code: `claude mcp add message-cp -- npx -y message-cp`.
4. If a different server named message-cp is already there, tell the person; run the removal it prints only if they agree.
5. "Check passed" means it registered a test agent, sent it a message, read it back and removed it. Note the "To undo" line.

## 3. Start a team server

### Without Docker

1. Run `npm install -g message-cp`.
2. Make the owner token without printing it: `mkdir -p ~/.message-cp && chmod 700 ~/.message-cp`, then `(umask 077 && openssl rand -hex 32 > ~/.message-cp/owner-token)`.
3. Start the server, and keep it running (for example under a service manager): `MESSAGE_CP_HTTP_TOKEN="$(cat ~/.message-cp/owner-token)" message-cp serve --port 8787 --public-url https://message-cp.example.com`.
4. It listens on `127.0.0.1:8787` over plain HTTP, so put an HTTPS proxy in front. With Caddy, a `Caddyfile` holding `message-cp.example.com { reverse_proxy 127.0.0.1:8787 }`, run with `caddy run --config Caddyfile`, is enough.
5. Run every later server command here, as the user `serve` runs as, with that user's `HOME` and the same `MESSAGE_CP_DB` (if set): they open the database file directly, and the server refuses a token made in another file.

### With Docker

1. Run `git clone https://github.com/colinhallett/message-cp.git && cd message-cp`.
2. Run `cp .env.example .env && chmod 600 .env`.
3. Set the domain: `sed -i 's/^MESSAGE_CP_DOMAIN=.*/MESSAGE_CP_DOMAIN=message-cp.example.com/' .env`.
4. Set the owner token without printing it: `sed -i "s/^MESSAGE_CP_HTTP_TOKEN=.*/MESSAGE_CP_HTTP_TOKEN=$(openssl rand -hex 32)/" .env`.
5. Run `docker compose up -d`. If either setting is empty, it stops and names it.
6. Run every later server command inside the container, from the clone: `docker compose exec -T message-cp message-cp ...`, which opens `/data/db.sqlite` on the volume `data`.

To try it with no domain, set `MESSAGE_CP_DOMAIN=localhost` and use `https://localhost` below. Clients must then trust Caddy's local authority: copy it with `docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt .` and trust it on the machine, or give it to `init` as `NODE_EXTRA_CA_CERTS=root.crt`.

## 4. Connect an agent to the team server

1. Choose the agent's name (1 to 32 letters, digits, `-` or `_`), such as `writer`. On the server, write the agent's key and an agent token to a private file. Without Docker: `(umask 077 && message-cp connect writer --url https://message-cp.example.com > ~/.message-cp/connect-writer.txt)`. With Docker, from the clone: `mkdir -p ~/.message-cp && chmod 700 ~/.message-cp`, then `(umask 077 && docker compose exec -T message-cp message-cp connect writer --url https://message-cp.example.com > ~/.message-cp/connect-writer.txt)`. Add `--account <name>` for an account other than `owner`. For an agent that exists, add `--new-key`, which ends its sessions.
2. Copy it privately, such as with `scp`, to `~/.message-cp/connect-writer.txt` on the agent's machine, mode 600.
3. On the agent's machine, load the token and key without printing them:

   ```sh
   f=~/.message-cp/connect-writer.txt
   export MESSAGE_CP_HTTP_TOKEN="$(sed -n 's/.*"Authorization": "Bearer \([0-9a-f]*\)".*/\1/p' "$f")"
   export MESSAGE_CP_AGENT_KEY="$(sed -n 's/.*"X-Message-CP-Agent-Key": "\([0-9a-f]*\)".*/\1/p' "$f")"
   ```

4. Run `npx -y message-cp init --url https://message-cp.example.com --agent writer`, adding `--client <client>` if it found more than one client. It checks the token and key before changing anything, then sets up the client and runs the same check as in section 2.
5. Write the agent token where the wake-up command reads it: `mkdir -p ~/.message-cp && chmod 700 ~/.message-cp`, then `(umask 077 && printf '%s\n' "$MESSAGE_CP_HTTP_TOKEN" > ~/.message-cp/http-token)`.
6. If `init` refused the client, it says why and nothing was changed:
   - Codex cannot send the agent's headers, so it cannot be set up for a team server. Offer Claude Code or Cursor.
   - Claude Code on Windows: run the `claude mcp add` command on the file's first line, without printing it.
   - Claude Desktop: the person adds a custom connector (Customize, Connectors, Add, Add custom connector, No sign in) with the file's URL and three headers.
   - Cursor, when others can read `~/.cursor/mcp.json`: run `chmod 600 ~/.cursor/mcp.json`, then run `init` again.
7. Once the client is set up, delete the file on both machines; `connect --new-key` makes a new key and token.

## 5. Prove it works

If `init` printed "Check passed", it has already proved the server works. To check from the client too, have the person start a new session of it, which loads the new server, and follow these steps:

1. On one machine, call `register` with a name such as `setup-check` and a short bio. On a team server, the session already acts as the agent: skip this.
2. Call `send_message` to your own name, with any body.
3. Call `read_inbox` and check the message is there.
4. On one machine, call `unregister` with no arguments.

The server's instructions, sent to every session, explain how to be woken when mail arrives.

## 6. Tell the person

In a few lines, say:

- What was set up: which client, and this machine or which server and agent.
- How to undo it: the "To undo" line `init` printed. On a team server, `message-cp token list` and then `message-cp token revoke <id>`, run as in section 3, also stop the agent token.
- How to add another agent: on one machine, each session registers its own name, and `npx -y message-cp init --client <client>` sets up another client; on a team server, repeat section 4 with a new name.
