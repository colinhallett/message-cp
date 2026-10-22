import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { homeFile, setting } from "./settings.js";

export type Db = Database.Database;

/** The one database file shared by every server process on this machine. */
export function dbPath(env: NodeJS.ProcessEnv = process.env): string {
  return setting("DB", env) || homeFile("db.sqlite");
}

/** The account the migration creates: the token in MESSAGE_CP_HTTP_TOKEN, stdio and `message-cp wait` act as it. */
export const OWNER_ACCOUNT = 1;
export type AccountId = number;

// Agent names are unique within an account, so two accounts can each have a `planner`. NOCASE makes them unique
// regardless of case while keeping the first-registered spelling. The rebuild in addAccounts() creates the same table.
const agentsTable = (table: string) => `
CREATE TABLE IF NOT EXISTS ${table} (
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
  UNIQUE (account_id, name)
);`;

// Every table lives here so later changes add to one place.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at INTEGER NOT NULL
);

-- Only a token's hash is stored; the token itself is shown once, when it is created.
CREATE TABLE IF NOT EXISTS tokens (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  read_only INTEGER NOT NULL DEFAULT 0
);
${agentsTable("agents")}

-- One row per recipient, so a broadcast has its own read state for each agent. A message belongs to its recipient's account.
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  recipient_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  sender TEXT NOT NULL,
  body TEXT NOT NULL,
  broadcast INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  read_at INTEGER
);
CREATE INDEX IF NOT EXISTS messages_inbox ON messages (recipient_id, read_at, id);
CREATE INDEX IF NOT EXISTS messages_history ON messages (recipient_id, id);
-- Deleting a conversation finds its messages by recipient and sender.
CREATE INDEX IF NOT EXISTS messages_by_sender ON messages (recipient_id, sender COLLATE NOCASE);
-- read_conversation reads a pair's messages newest first, so a page stops after its rows instead of sorting the pair's history.
CREATE INDEX IF NOT EXISTS messages_by_pair ON messages (recipient_id, sender COLLATE NOCASE, created_at, id);

-- A channel belongs to one account and exists from its first post, or from the first agent joining it. Names follow the agent-name rules, unique per
-- account regardless of case, keeping the first spelling. None of these names may appear in DROP_REMOVED.
CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  name TEXT NOT NULL COLLATE NOCASE,
  created_at INTEGER NOT NULL,
  UNIQUE (account_id, name)
);

-- Append-only. The sender's row tells an agent's own posts from those of a later agent that registers the same name.
CREATE TABLE IF NOT EXISTS channel_posts (
  id INTEGER PRIMARY KEY,
  channel_id INTEGER NOT NULL REFERENCES channels(id),
  sender_id INTEGER NOT NULL REFERENCES agents(id),
  sender TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS channel_posts_by_channel ON channel_posts (channel_id, id);

-- Each agent's read position in each channel: the id of the last post it has read. Keyed on the agent's row, so an
-- agent that unregisters and a later one with its name never share it. No row means it has read nothing.
-- \`joined\` is 1 while the agent has joined the channel, so that its unread posts wake the agent.
CREATE TABLE IF NOT EXISTS channel_reads (
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  channel_id INTEGER NOT NULL REFERENCES channels(id),
  last_read_id INTEGER NOT NULL,
  joined INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, channel_id)
);

-- A post that names \`@<agent>\` records one row for each live agent of its account with that name, but the poster.
-- Keyed on the agent's row, like channel_reads, so a later agent that registers a removed agent's name never sees it.
-- \`read_at\` is set when read_inbox returns it.
CREATE TABLE IF NOT EXISTS mentions (
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  post_id INTEGER NOT NULL REFERENCES channel_posts(id),
  read_at INTEGER,
  PRIMARY KEY (agent_id, post_id)
);
CREATE INDEX IF NOT EXISTS mentions_unread ON mentions (agent_id, read_at, post_id);

-- Outgoing webhooks, managed only with \`message-cp webhook\`. \`event\` is 'channel', 'mention' or 'agent' and \`name\` the
-- channel or agent in the same account, which need not exist yet. The secret is stored as is: deliveries sign with it.
-- So is the value of the one header a webhook may carry (\`header_name\`, \`header_value\`, added in \`migrate\`), since
-- deliveries send it. \`max_per_hour\` (also added in \`migrate\`, null for none) caps its delivery requests in a fixed
-- window: \`window_started_at\` is when the first request after the last window ended was claimed, and \`window_count\`
-- how many requests have been claimed since; the window lasts 60 minutes. \`fixed_body\` (also added in \`migrate\`) is the
-- JSON body the owner set with \`webhook add --body\`, sent in place of the event body, or null to send the event body.
CREATE TABLE IF NOT EXISTS webhooks (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  url TEXT NOT NULL,
  event TEXT NOT NULL CHECK (event IN ('channel', 'mention', 'agent')),
  name TEXT NOT NULL,
  include_text INTEGER NOT NULL,
  secret TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS webhooks_by_name ON webhooks (account_id, event, name COLLATE NOCASE);

-- What a webhook is owed: one row per webhook per message or post it is for, queued in the transaction that stores the
-- message or post. Only ids are kept, so the body is built when it is sent. \`serve\` sends them: \`attempts\` is counted
-- and \`claimed_until\` set when a sender claims a row, before its request, and \`delivered_at\` set on a 2xx answer.
-- \`delivery_uuid\` (added in \`migrate\`) is what a fixed body's placeholder stands for: a random UUID set on the first
-- request sent for a webhook with one and kept for every retry, so it does not repeat even when a row's id is reused.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id INTEGER PRIMARY KEY,
  webhook_id INTEGER NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
  post_id INTEGER REFERENCES channel_posts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  delivered_at INTEGER,
  CHECK ((message_id IS NULL) <> (post_id IS NULL))
);
CREATE INDEX IF NOT EXISTS webhook_deliveries_pending ON webhook_deliveries (delivered_at, id);
CREATE INDEX IF NOT EXISTS webhook_deliveries_by_webhook ON webhook_deliveries (webhook_id);
-- \`sendPending\` reads each webhook's oldest pending rows through this, up to what it may send, not the whole queue.
CREATE INDEX IF NOT EXISTS webhook_deliveries_pending_by_webhook ON webhook_deliveries (webhook_id, delivered_at, id);
-- Deleting a message finds its queued deliveries (ON DELETE CASCADE) through this, not by scanning the table.
CREATE INDEX IF NOT EXISTS webhook_deliveries_by_message ON webhook_deliveries (message_id);

-- The HTTP sessions that have registered, so a session keeps its agent when \`serve\` restarts. Only a hash of the
-- session id is kept: the id is a bearer credential alongside the token. The agent fields are the session's \`Identity\`,
-- checked again before a restore, so a removed registration is never restored. \`last_used\` is for the idle timeout.
-- \`ended\` is set once a DELETE ends the session; nothing clears it, so no server can make the id restorable again.
CREATE TABLE IF NOT EXISTS http_sessions (
  hash TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  registered_at INTEGER NOT NULL,
  instance TEXT,
  last_used INTEGER NOT NULL,
  ended INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS http_sessions_by_last_used ON http_sessions (last_used);
`;

// CREATE TABLE IF NOT EXISTS leaves an existing table alone, so columns added later are added here, only when missing.
const hasColumn = (db: Db, column: string, table = "agents") =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);

function addColumn(db: Db, column: string, definition: string, table = "agents"): void {
  if (hasColumn(db, column, table)) return;
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (err) {
    // Another process added it between our check and the ALTER.
    if (!(err instanceof Error && /duplicate column name/i.test(err.message))) throw err;
  }
}

// Shared memories, the task board, the hive's run log and the GitHub sign-in were removed, so their tables go too.
// Dropping a table drops its indexes and triggers; the full-text index is a table of its own.
// IF EXISTS makes this a no-op once done, and harmless when several processes open the file at once.
const DROP_REMOVED = `
DROP TABLE IF EXISTS memories_fts;
DROP TABLE IF EXISTS memory_tags;
DROP TABLE IF EXISTS memories;
DROP TABLE IF EXISTS task_tags;
DROP TABLE IF EXISTS tasks;
DROP TABLE IF EXISTS hive_runs;
DROP TABLE IF EXISTS github_users;
DROP TABLE IF EXISTS oauth_clients;
DROP TABLE IF EXISTS oauth_pending;
DROP TABLE IF EXISTS oauth_codes;
DROP TABLE IF EXISTS oauth_grants;
`;

/** The copy of the database the accounts migration leaves next to it, taken just before it rebuilds `agents`. */
export const preAccountsCopy = (path: string) => `${path}.before-accounts`;

/** Flushes `path`, a file or a directory, to disk. */
function fsyncPath(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Copies the database at `path` to `preAccountsCopy(path)`, owner-only whatever the umask, replacing any copy there:
 * it runs only when the migration is about to happen, so an existing copy is stale or from a migration that never
 * committed. The copy is written under another name, flushed, renamed into place and the directory flushed, so it is
 * never seen half-written and is on disk before the rebuild can commit.
 */
function copyBeforeAccounts(path: string): void {
  const copy = preAccountsCopy(path);
  const partial = `${copy}.${randomBytes(6).toString("hex")}.partial`;
  writeFileSync(partial, "", { mode: 0o600, flag: "wx" });
  try {
    chmodSync(partial, 0o600);
    // A second connection, since VACUUM cannot run inside the caller's transaction. It reads the last commit, which
    // nobody can change while the caller holds the write lock.
    const source = new Database(path);
    try {
      source.pragma("busy_timeout = 5000");
      source.prepare("VACUUM INTO ?").run(partial);
    } finally {
      source.close();
    }
    chmodSync(partial, 0o600);
    fsyncPath(partial);
    renameSync(partial, copy);
    fsyncPath(dirname(copy));
  } catch (err) {
    rmSync(partial, { force: true });
    throw err;
  }
}

/**
 * Gives every agent an account by rebuilding `agents` with an `account_id`, all existing rows going to the owner's
 * account, so that names are unique per account. SQLite cannot change a table's UNIQUE constraint in place.
 * The check, the copy and the rebuild all happen under the write lock, so when several processes open the file at
 * once exactly one of them copies and rebuilds, and the others find the work done.
 */
function addAccounts(db: Db, path: string): void {
  if (hasColumn(db, "account_id")) return;
  // Dropping the old table must not cascade to the messages that reference it; this cannot change inside a transaction.
  const foreignKeys = db.pragma("foreign_keys", { simple: true });
  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      if (hasColumn(db, "account_id")) return;
      copyBeforeAccounts(path);
      db.exec(agentsTable("agents_by_account"));
      // `person` is left to its default: no person can exist before accounts did.
      db.prepare(
        `INSERT INTO agents_by_account (id, account_id, name, bio, registered_at, last_seen, key_hash, instance, removed_at, removed_name)
         SELECT id, ?, name, bio, registered_at, last_seen, key_hash, instance, removed_at, removed_name FROM agents`,
      ).run(OWNER_ACCOUNT);
      db.exec("DROP TABLE agents");
      db.exec("ALTER TABLE agents_by_account RENAME TO agents");
      if ((db.pragma("foreign_key_check") as unknown[]).length > 0) throw new Error("accounts migration broke a foreign key");
    }).immediate();
  } finally {
    db.pragma(`foreign_keys = ${foreignKeys ? "ON" : "OFF"}`);
  }
}

function migrate(db: Db, path: string): void {
  addColumn(db, "key_hash", "TEXT");
  // A random token per registration, so a session can tell its agent from a later one that reuses the id or name.
  addColumn(db, "instance", "TEXT");
  // A removed agent keeps its row, so the messages addressed to it stay and its id is never reused.
  addColumn(db, "removed_at", "INTEGER");
  addColumn(db, "removed_name", "TEXT");
  // 1 for a person the operator added with `person add`; every row from before it existed is an agent.
  addColumn(db, "person", "INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "joined", "INTEGER NOT NULL DEFAULT 0", "channel_reads");
  // 1 for a token that can only read (`token add --read-only`); tokens made before it existed keep full access.
  addColumn(db, "read_only", "INTEGER NOT NULL DEFAULT 0", "tokens");
  // Until when the request of the sender that last claimed the delivery may be in flight; no sender takes it before then.
  addColumn(db, "claimed_until", "INTEGER", "webhook_deliveries");
  // The one header a webhook's deliveries carry (`webhook add --header-stdin`); both null for a webhook without one.
  addColumn(db, "header_name", "TEXT", "webhooks");
  addColumn(db, "header_value", "TEXT", "webhooks");
  // A webhook's cap on delivery requests per window (`webhook add --max-per-hour`); null, so no cap, for one without.
  addColumn(db, "max_per_hour", "INTEGER", "webhooks");
  addColumn(db, "window_started_at", "INTEGER", "webhooks");
  addColumn(db, "window_count", "INTEGER NOT NULL DEFAULT 0", "webhooks");
  // The JSON body a webhook sends in place of the event body (`webhook add --body`); null, so the event body, for one without.
  addColumn(db, "fixed_body", "TEXT", "webhooks");
  addColumn(db, "delivery_uuid", "TEXT", "webhook_deliveries");
  // Set once a DELETE ends an HTTP session, so no server restores it or records it again.
  addColumn(db, "ended", "INTEGER NOT NULL DEFAULT 0", "http_sessions");
  db.exec(DROP_REMOVED);
  db.prepare("INSERT OR IGNORE INTO accounts (id, name, created_at) VALUES (?, 'owner', ?)").run(OWNER_ACCOUNT, Date.now());
  addAccounts(db, path);
  // Broadcast reads every live agent of one account in name order; this keeps it from scanning the removed rows too.
  db.exec("CREATE INDEX IF NOT EXISTS agents_live ON agents (account_id, name) WHERE removed_at IS NULL");
}

// Several processes switching a new file to WAL at once make the losers fail with SQLITE_BUSY straight away,
// without waiting for the busy timeout, so the switch is retried here.
const WAL_RETRY_LIMIT_MS = 5000;
const WAL_RETRY_MAX_DELAY_MS = 50;

function isBusy(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.startsWith("SQLITE_BUSY");
}

// openDb is synchronous, so the pause between retries blocks the thread.
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function enableWal(db: Db): void {
  const deadline = Date.now() + WAL_RETRY_LIMIT_MS;
  let delay = 1;
  for (;;) {
    try {
      db.pragma("journal_mode = WAL");
      return;
    } catch (err) {
      if (!isBusy(err) || Date.now() >= deadline) throw err;
      sleepSync(delay * (0.5 + Math.random())); // jitter keeps the losers from retrying in step
      delay = Math.min(delay * 2, WAL_RETRY_MAX_DELAY_MS);
    }
  }
}

export function openDb(path: string = dbPath()): Db {
  // Owner-only, whatever the umask: names and bios are not for other local accounts.
  // WAL and journal files take the permissions of the main file.
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (!existsSync(path)) writeFileSync(path, "", { mode: 0o600, flag: "a" });
  const db = new Database(path);
  // WAL and a busy timeout let several processes share the file without lock errors; enableWal retries the first switch.
  enableWal(db);
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA);
  migrate(db, path);
  return db;
}
