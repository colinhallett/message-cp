-- The schema openDb made as of 92b7c9b, before messages.id was AUTOINCREMENT: dumped from sqlite_master of a new
-- database. Used to test the upgrade that rebuilds messages.
CREATE TABLE accounts (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at INTEGER NOT NULL
);
CREATE TABLE tokens (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  read_only INTEGER NOT NULL DEFAULT 0,
  agent_only INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE agents (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  name TEXT NOT NULL COLLATE NOCASE,
  bio TEXT NOT NULL,
  registered_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  key_hash TEXT,
  instance TEXT,
  removed_at INTEGER,
  removed_name TEXT,
  person INTEGER NOT NULL DEFAULT 0,
  status TEXT,
  status_at INTEGER,
  UNIQUE (account_id, name)
);
CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  recipient_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  sender TEXT NOT NULL,
  body TEXT NOT NULL,
  broadcast INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  read_at INTEGER
, in_reply_to INTEGER REFERENCES messages(id) ON DELETE SET NULL);
CREATE INDEX messages_inbox ON messages (recipient_id, read_at, id);
CREATE INDEX messages_history ON messages (recipient_id, id);
CREATE INDEX messages_by_sender ON messages (recipient_id, sender COLLATE NOCASE);
CREATE INDEX messages_by_pair ON messages (recipient_id, sender COLLATE NOCASE, created_at, id);
CREATE TABLE channels (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  name TEXT NOT NULL COLLATE NOCASE,
  created_at INTEGER NOT NULL,
  UNIQUE (account_id, name)
);
CREATE TABLE channel_posts (
  id INTEGER PRIMARY KEY,
  channel_id INTEGER NOT NULL REFERENCES channels(id),
  sender_id INTEGER NOT NULL REFERENCES agents(id),
  sender TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX channel_posts_by_channel ON channel_posts (channel_id, id);
CREATE TABLE channel_reads (
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  channel_id INTEGER NOT NULL REFERENCES channels(id),
  last_read_id INTEGER NOT NULL,
  joined INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, channel_id)
);
CREATE TABLE mentions (
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  post_id INTEGER NOT NULL REFERENCES channel_posts(id),
  read_at INTEGER,
  PRIMARY KEY (agent_id, post_id)
);
CREATE INDEX mentions_unread ON mentions (agent_id, read_at, post_id);
CREATE INDEX mentions_by_post ON mentions (post_id);
CREATE TABLE webhooks (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  url TEXT NOT NULL,
  event TEXT NOT NULL CHECK (event IN ('channel', 'mention', 'agent')),
  name TEXT NOT NULL,
  include_text INTEGER NOT NULL,
  secret TEXT NOT NULL,
  created_at INTEGER NOT NULL
, header_name TEXT, header_value TEXT, max_per_hour INTEGER, window_started_at INTEGER, window_count INTEGER NOT NULL DEFAULT 0, fixed_body TEXT);
CREATE INDEX webhooks_by_name ON webhooks (account_id, event, name COLLATE NOCASE);
CREATE TABLE webhook_deliveries (
  id INTEGER PRIMARY KEY,
  webhook_id INTEGER NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
  post_id INTEGER REFERENCES channel_posts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  delivered_at INTEGER, claimed_until INTEGER, delivery_uuid TEXT,
  CHECK ((message_id IS NULL) <> (post_id IS NULL))
);
CREATE INDEX webhook_deliveries_pending ON webhook_deliveries (delivered_at, id);
CREATE INDEX webhook_deliveries_by_webhook ON webhook_deliveries (webhook_id);
CREATE INDEX webhook_deliveries_pending_by_webhook ON webhook_deliveries (webhook_id, delivered_at, id);
CREATE INDEX webhook_deliveries_by_message ON webhook_deliveries (message_id);
CREATE INDEX webhook_deliveries_delivered_by_message ON webhook_deliveries (message_id, delivered_at);
CREATE TABLE http_sessions (
  hash TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  registered_at INTEGER NOT NULL,
  instance TEXT,
  last_used INTEGER NOT NULL,
  ended INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX http_sessions_by_last_used ON http_sessions (last_used);
CREATE INDEX messages_by_reply ON messages (in_reply_to);
CREATE INDEX messages_by_question ON messages (in_reply_to, recipient_id);
CREATE INDEX agents_live ON agents (account_id, name) WHERE removed_at IS NULL;
