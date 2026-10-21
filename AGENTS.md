

# Agent Rules <!-- tessl-managed -->

@.tessl/RULES.md follow the [instructions](.tessl/RULES.md)

## Design constraints

message-cp is a small server for a few people's agents, reached over stdio on its own machine or over HTTPS, with a handful to a few dozen agents per account. Agents and messages belong to accounts, and nothing may cross between accounts: a finding that one account can see or affect another account's data is always blocking. Other scale, paging or permission concerns are weighed against that scale:

- Broadcast (`send_message` to `all`) reaches every registered agent in the sender's account; do not cap recipients.
- Paged tools (`list_agents`, `read_inbox`) use `limit` plus `offset`; keyset/cursor paging is out of scope unless a ticket asks for it.
- `openDb` creates a missing directory 0700 and database file 0600; it does not change permissions on existing user-created or configured locations.
- Small, contained bounds (an input-length cap, an index for an existing query) are welcome. A change to a documented contract, the config schema or all paging tools belongs in a follow-up issue: decline in the thread with the reason instead of pushing it.
- A new or changed request path in `src/http.ts` that buffers a body (`readBody`), holds a response open (like `/wait`) or waits on outbound work counts against a cap that is checked before the body is read or the hold begins, and gives its slot back in a `finally`. Follow `initializing` for sessionless `/mcp` POSTs (checked against `maxSessions` before `serve` calls `readBody`) and `waiting` for `/wait`. A `/mcp` POST that carries an `Mcp-Session-Id` is not capped yet: do not copy it. Past the cap, answer 503, with `Connection: close` when a body is left unread and `Retry-After` for a hold that can be retried. Answer what can be answered at once (401, 403, 404, mail or posts already unread) before the cap, so the cap limits only held work, as `wait` does. Add any new cap to the README "Limits" section. At this scale the caps are the bound: do not move SQLite work off the request thread.
- A token or credential carried with a URL must never cross the network in the clear or be printed, so a URL taken from a flag, environment variable or file is parsed with `new URL()`, never checked or built with string operations. Require `https:`, and allow `http:` only for a literal loopback address (`127.x.x.x` or `[::1]`, not the name `localhost`, which a resolver may send elsewhere); refuse a URL with a username, password, query or fragment; build endpoint URLs from the parsed URL (`new URL(path, base)`), not by appending to the string. A shell script that takes a URL matches the whole documented shape with one anchored allow-list regex, not a prefix check plus excluded characters. Code that accepts a URL must have tests for the bypasses `http://localhost@evil/`, `https://@/`, `https://h/?x=/o/` and `https://h/#/o/`. Follow the `liveUrl` check in `scripts/e2e.mjs` for parsing and refusing only: its return value and the endpoint URLs built from it are still strings.
- Every sentence you add or change in `README.md`, or in a tool or parameter `description` in `src/server.ts`, states only what the code in the branch does after your diff, no more and no less: limits and cadences, accepted formats, which endpoint the dashboard calls, what a read-only token can see, and when the dashboard does something. Before opening the PR, list each such claim next to the line of code that makes it true, and cut or narrow any claim you cannot point to. Ask the fresh-eyes reviewer to make the same claim-by-claim check.

## Setup

From a fresh checkout, install, build and test with:

```sh
npm ci --ignore-scripts
npm run build
npm test
```

`better-sqlite3` ships prebuilt binaries under `node_modules/better-sqlite3/prebuilds/` for Linux (glibc and musl), macOS and Windows on x64 and arm64, so skipping its install script loses nothing. Plain `npm ci` compiles it and fails where there is no `make` or C++ compiler. If plain `npm ci` has already failed that way, use the commands above instead: do not install a compiler, shim `better-sqlite3` over `node:sqlite`, run the tests in a container, or skip them. The [README quick start](README.md#quick-start) gives the same install for people.

### Running the server by hand

Start it with `node dist/cli.js serve --port <port> > /tmp/serve.log 2>&1 & echo $! > /tmp/serve.pid` and stop it with `kill "$(cat /tmp/serve.pid)"`. Never use `pkill -f` or `pgrep -f` with a pattern from your own command line, because it matches and kills your own shell (exit 144). Keep the stop command in a tool call of its own.
