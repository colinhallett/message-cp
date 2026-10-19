

# Agent Rules <!-- tessl-managed -->

@.tessl/RULES.md follow the [instructions](.tessl/RULES.md)

## Design constraints

message-cp is a small server for a few people's agents, reached over stdio on its own machine or over HTTPS, with a handful to a few dozen agents per account. Agents and messages belong to accounts, and nothing may cross between accounts: a finding that one account can see or affect another account's data is always blocking. Other scale, paging or permission concerns are weighed against that scale:

- Broadcast (`send_message` to `all`) reaches every registered agent in the sender's account; do not cap recipients.
- Paged tools (`list_agents`, `read_inbox`) use `limit` plus `offset`; keyset/cursor paging is out of scope unless a ticket asks for it.
- `openDb` creates a missing directory 0700 and database file 0600; it does not change permissions on existing user-created or configured locations.
- Small, contained bounds (an input-length cap, an index for an existing query) are welcome. A change to a documented contract, the config schema or all paging tools belongs in a follow-up issue: decline in the thread with the reason instead of pushing it.
- A token or credential carried with a URL must never cross the network in the clear or be printed, so a URL taken from a flag, environment variable or file is parsed with `new URL()`, never checked or built with string operations. Require `https:`, and allow `http:` only for a literal loopback address (`127.x.x.x` or `[::1]`, not the name `localhost`, which a resolver may send elsewhere); refuse a URL with a username, password, query or fragment; build endpoint URLs from the parsed URL (`new URL(path, base)`), not by appending to the string. A shell script that takes a URL matches the whole documented shape with one anchored allow-list regex, not a prefix check plus excluded characters. Code that accepts a URL must have tests for the bypasses `http://localhost@evil/`, `https://@/`, `https://h/?x=/o/` and `https://h/#/o/`. Follow the `liveUrl` check in `scripts/e2e.mjs` for parsing and refusing only: its return value and the endpoint URLs built from it are still strings.

## Setup

From a fresh checkout, install, build and test with:

```sh
npm ci --ignore-scripts
npm run build
npm test
```

`better-sqlite3` ships prebuilt binaries under `node_modules/better-sqlite3/prebuilds/` for Linux (glibc and musl), macOS and Windows on x64 and arm64, so skipping its install script loses nothing. Plain `npm ci` compiles it and fails where there is no `make` or C++ compiler. If plain `npm ci` has already failed that way, use the commands above instead: do not install a compiler, shim `better-sqlite3` over `node:sqlite`, run the tests in a container, or skip them. The [README quick start](README.md#quick-start) gives the same install for people.
