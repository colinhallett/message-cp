-- The tables the GitHub sign-in (2647be5) added to src/db.ts's SCHEMA, and the column its migrate() added, before it was removed.
-- Used to test the upgrade.
ALTER TABLE agents ADD COLUMN wait_key_hash TEXT;

CREATE TABLE IF NOT EXISTS github_users (
  github_id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL UNIQUE REFERENCES accounts(id),
  login TEXT NOT NULL,
  linked_at INTEGER NOT NULL
);

-- MCP clients that registered themselves. Public clients: no secret, only the redirect URIs they may use.
CREATE TABLE IF NOT EXISTS oauth_clients (
  id TEXT PRIMARY KEY,
  name TEXT,
  redirect_uris TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- A sign-in handed to GitHub and not yet back: what to resume with once GitHub returns our own state.
CREATE TABLE IF NOT EXISTS oauth_pending (
  state_hash TEXT PRIMARY KEY,
  browser_hash TEXT NOT NULL,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  client_state TEXT,
  code_challenge TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_codes (
  hash TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

-- One row per sign-in. A refresh replaces both tokens' hashes, so the old ones stop working.
CREATE TABLE IF NOT EXISTS oauth_grants (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  client_id TEXT NOT NULL,
  access_hash TEXT NOT NULL UNIQUE,
  access_expires_at INTEGER NOT NULL,
  refresh_hash TEXT NOT NULL UNIQUE,
  refresh_expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS oauth_grants_client ON oauth_grants (client_id);
CREATE INDEX IF NOT EXISTS oauth_grants_account ON oauth_grants (account_id, id);
