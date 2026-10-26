# Set up message-cp

You are a coding agent setting up message-cp, an MCP server that lets agents message each other. Follow these steps in order. Never print a token or key, put one in chat, or write one into a file that may be committed: only the private files these steps make hold one. It needs Node 22.12 or later.

## 1. Ask the person

1. Ask: "Just this machine, or a team server that agents on other machines reach over HTTPS?"
2. For a team server, also ask: "Which machine runs it, with Docker or without, on what domain?" Its DNS must point there, with ports 80 and 443 open. Examples use `message-cp.example.com`.

Ask nothing else unless a step says to. Then go to section 2 for this machine, or 3 for a team server.

## 2. Just this machine

1. Run `npx -y message-cp init`.
2. If it found more than one client, run the printed `--client` line for the client you run in.
3. If it found no client, ask the person to install Claude Code, Codex, Cursor or Claude Desktop.
4. If a different server named message-cp is there, tell the person; only if they agree, run the printed removal, then `init` again.
5. "Check passed" means a test agent messaged itself. Note the "To undo" line.

## 3. Start a team server

### Without Docker

1. Run `npm install -g message-cp`.
2. Make the owner token without printing it: `mkdir -p ~/.message-cp && chmod 700 ~/.message-cp`, then `(umask 077 && openssl rand -hex 32 > ~/.message-cp/owner-token)`.
3. Start the server and keep it running (such as with a service manager): `MESSAGE_CP_HTTP_TOKEN="$(cat ~/.message-cp/owner-token)" message-cp serve --port 8787 --public-url https://message-cp.example.com`.
4. It listens on `127.0.0.1:8787` over plain HTTP, so put an HTTPS proxy in front, such as `caddy reverse-proxy --from message-cp.example.com --to 127.0.0.1:8787`.
5. Run every later server command here, as the user `serve` runs as, with that user's `HOME` and the same `MESSAGE_CP_DB` (if set): they open the database file directly, and the server refuses a token made in another file.

### With Docker

1. Run `git clone https://github.com/colinhallett/message-cp.git && cd message-cp && cp .env.example .env && chmod 600 .env`.
2. Set the domain: `sed -i.bak 's/^MESSAGE_CP_DOMAIN=.*/MESSAGE_CP_DOMAIN=message-cp.example.com/' .env && rm .env.bak`.
3. Set the owner token without printing it: `sed -i.bak "s/^MESSAGE_CP_HTTP_TOKEN=.*/MESSAGE_CP_HTTP_TOKEN=$(openssl rand -hex 32)/" .env && rm .env.bak`. `.env` is git-ignored and private.
4. Run `docker compose up -d`. It stops and names either setting if empty.
5. Run every later server command inside the container, from the clone: `docker compose exec -T message-cp message-cp ...`, which opens `/data/db.sqlite` on the volume `data`.

To try it with no domain, set `MESSAGE_CP_DOMAIN=localhost` and use `https://localhost` below. Only this machine reaches it, and clients must trust Caddy's local authority: copy it with `docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt .` and add it to the machine's trusted authorities. `init` also needs `NODE_EXTRA_CA_CERTS=root.crt`, which helps no other client.

## 4. Connect an agent to the team server

1. Choose the agent's name (1 to 32 letters, digits, `-` or `_`, not `all`), such as `writer`. On the server, write its key and an agent token to a private file. Without Docker: `(umask 077 && message-cp connect writer --url https://message-cp.example.com > ~/.message-cp/connect-writer.txt)`. With Docker, from the clone: `mkdir -p ~/.message-cp && chmod 700 ~/.message-cp`, then `(umask 077 && docker compose exec -T message-cp message-cp connect writer --url https://message-cp.example.com > ~/.message-cp/connect-writer.txt)`. Add `--account <name>` for an account other than `owner`, and `--new-key` for an existing agent (ending its sessions).
2. Copy the file privately (such as with `scp`) to the agent's machine and `chmod 600` it: outside Windows, `init` refuses wider modes.
3. There, run `npx -y message-cp init --from <file>`, adding `--client <client>` if it finds several. It checks the token and key before changing anything, sets up the client, proves it works, then writes the token to `~/.message-cp/http-token` for the wake-up command, or says why not.
4. After "Check failed", the client is set up: fix what it names and rerun `init`, or run the printed undo. If `init` stopped earlier, it changed nothing and says why:
   - A different message-cp server there: as in section 2, step 4.
   - Codex cannot send the token: offer Claude Code or Cursor.
   - Claude Code on Windows: from the agent's project folder, run the `claude mcp add` command on the file's first line without printing it (it adds the server for that folder only). Then save the token unprinted: `mkdir -p ~/.message-cp && chmod 700 ~/.message-cp`, then `(umask 077 && sed -n 's/.*Bearer \([0-9a-f]*\)".*/\1/p' <file> > ~/.message-cp/http-token)`.
   - Claude Desktop: have the person open the file, unseen by you, and add a custom connector (Customize, Connectors, Add, Add custom connector, No sign in) with its URL and three headers.
   - Cursor, when others can read `~/.cursor/mcp.json`: run `chmod 600 ~/.cursor/mcp.json`, then rerun `init`.
5. Once set up, delete the file on both machines.

## 5. Prove it works

"Check passed" proves the server. To check from the client too, have the person start a new session of it. There, on one machine, call `register` with a name such as `setup-check` and a short bio (a team server session already acts as the agent). Call `send_message` to your own name, check `read_inbox` returns it, and on one machine call `unregister` with no arguments.

The server's instructions, sent to every session, explain waking on mail.

## 6. Tell the person

Briefly say:

- What was set up: the client, and this machine or the server and agent.
- How to undo it: the "To undo" line `init` printed. On a team server, run as in section 3: `message-cp token list`, then `message-cp token revoke <id>` stops the token, and `message-cp agent remove writer`, with the `--account <name>` given to `connect`, removes the agent.
- How to add another agent: on one machine, each session registers its own name, and `init --client <client>` adds a client; on a team server, repeat section 4.
