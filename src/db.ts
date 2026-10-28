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
  admin INTEGER NOT NULL DEFAULT 0,
  status TEXT,
  status_at INTEGER,
  UNIQUE (account_id, name)
);`;

// One row per recipient, so a broadcast has its own read state for each agent. A message belongs to its recipient's
// account. AUTOINCREMENT so an id, once handed out, never names a later message, even after the highest row is deleted:
// `in_reply_to`, `message_status` and `ask` refer to messages by id. `in_reply_to` is the id of the message a reply
// answers (\`send_message\` with \`in_reply_to\`), null for none; deleting that message sets it to null. The rebuild in
// rebuildMessages() creates the same table.
const messagesTable = (table: string) => `
CREATE TABLE IF NOT EXISTS ${table} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  sender TEXT NOT NULL,
  body TEXT NOT NULL,
  broadcast INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  read_at INTEGER,
  in_reply_to INTEGER REFERENCES messages(id) ON DELETE SET NULL
);`;

// Dropping a table drops its indexes, so rebuildMessages() creates these again.
const MESSAGES_INDEXES = `
CREATE INDEX IF NOT EXISTS messages_inbox ON messages (recipient_id, read_at, id);
CREATE INDEX IF NOT EXISTS messages_history ON messages (recipient_id, id);
-- Deleting a conversation finds its messages by recipient and sender.
CREATE INDEX IF NOT EXISTS messages_by_sender ON messages (recipient_id, sender COLLATE NOCASE);
-- read_conversation reads a pair's messages newest first, so a page stops after its rows instead of sorting the pair's history.
CREATE INDEX IF NOT EXISTS messages_by_pair ON messages (recipient_id, sender COLLATE NOCASE, created_at, id);`;

// These need `in_reply_to`, which `migrate` adds to an older table, so `migrate` creates them rather than SCHEMA.
// rebuildMessages() creates them too, in its transaction, so the rebuilt table is never committed without them.
const MESSAGES_REPLY_INDEXES = `
-- Deleting a message finds the replies to it (ON DELETE SET NULL) through this, not by scanning the table.
CREATE INDEX IF NOT EXISTS messages_by_reply ON messages (in_reply_to);
-- \`ask\` finds the replies to one question sent to the asker through this, in id order, not by walking every reply to it.
CREATE INDEX IF NOT EXISTS messages_by_question ON messages (in_reply_to, recipient_id);`;

// One-time dashboard sign-in codes from `message-cp login-link`, and invites an admin person made (src/login.ts). Only
// the code's hash is kept. `person_id` is set for a link that signs in as that person; `used_at` once it has given its
// token or, for an invite, was cancelled. AUTOINCREMENT so an invite's id, which GET and DELETE /api/invites hand out,
// never names a later invite once expired codes are deleted. A table from before it is rebuilt by rebuildLoginCodes(),
// which creates the same table; the invite columns are added to it in migrate first.
const loginCodesTable = (table: string) => `
CREATE TABLE IF NOT EXISTS ${table} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code_hash TEXT NOT NULL UNIQUE,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  person_id INTEGER REFERENCES agents(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  invite INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER,
  cancelled_at INTEGER
);`;

// Dropping a table drops its indexes, so rebuildLoginCodes() creates these again.
const LOGIN_CODES_INDEXES = `
CREATE INDEX IF NOT EXISTS login_codes_by_expiry ON login_codes (expires_at);
-- The same as mcp_authorizations_by_agent, for an agent's row, should one ever be deleted.
CREATE INDEX IF NOT EXISTS login_codes_by_person ON login_codes (person_id);`;

// The dashboard sign-ins a login link or an invite started (`redeemLoginCode` in src/login.ts), one per redeemed code.
// Only a hash of the session id is kept: the id is a bearer credential in place of its token, which `accountForToken`
// checks afresh on every request, so revoking the token or removing its person ends the session too. Tokens are never
// deleted, only revoked, so `token_id` needs no ON DELETE. `hash` is UNIQUE, which gives the lookup its index.
// AUTOINCREMENT so a sign-in's id, which GET and DELETE /api/signins hand out, never names a later sign-in once the
// highest one is ended. A table from before it is rebuilt by rebuildDashboardSessions(), which creates the same table.
const dashboardSessionsTable = (table: string) => `
CREATE TABLE IF NOT EXISTS ${table} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hash TEXT NOT NULL UNIQUE,
  token_id INTEGER NOT NULL REFERENCES tokens(id),
  created_at INTEGER NOT NULL
);`;

// Dropping a table drops its indexes, so rebuildDashboardSessions() creates this again.
const DASHBOARD_SESSIONS_INDEXES = `
-- Adding a token checks its sessions (the foreign key) through this, not by scanning the table.
CREATE INDEX IF NOT EXISTS dashboard_sessions_by_token ON dashboard_sessions (token_id);`;

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
  read_only INTEGER NOT NULL DEFAULT 0,
  agent_only INTEGER NOT NULL DEFAULT 0
);
${agentsTable("agents")}

${messagesTable("messages")}
${MESSAGES_INDEXES}
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
-- GET /api/channel-posts reads a page of posts' mentions through this, not by scanning every mention.
CREATE INDEX IF NOT EXISTS mentions_by_post ON mentions (post_id);

-- Outgoing webhooks, added only with \`message-cp webhook\`; an admin person token also lists and removes them over
-- /api/webhooks. \`event\` is 'channel', 'mention' or 'agent' and \`name\` the channel or agent in the same account,
-- which need not exist yet. The secret is stored as is: deliveries sign with it.
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
-- \`listAccountMessages\` asks whether a message has a delivered delivery through this, reading only the delivered rows'
-- index entries rather than every delivery of the message.
CREATE INDEX IF NOT EXISTS webhook_deliveries_delivered_by_message ON webhook_deliveries (message_id, delivered_at);

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

${dashboardSessionsTable("dashboard_sessions")}
${DASHBOARD_SESSIONS_INDEXES}
-- GET /api/signins finds an account's live tokens through this, then each one's sessions through the index above, rather
-- than scanning every account's sessions.
CREATE INDEX IF NOT EXISTS tokens_live_by_account ON tokens (account_id) WHERE revoked_at IS NULL;

-- MCP clients that registered themselves for \`serve --public-url\`'s authorization flow (src/oauth.ts). \`redirect_uris\` is
-- a JSON array of the URIs as the client sent them. Belongs to no account. These names are not the removed GitHub
-- sign-in's \`oauth_*\` tables, which DROP_REMOVED drops, and may not appear there.
CREATE TABLE IF NOT EXISTS mcp_clients (
  id INTEGER PRIMARY KEY,
  client_id TEXT NOT NULL UNIQUE,
  client_name TEXT,
  redirect_uris TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- One authorization request from showing its page until its code is exchanged or it expires. Only hashes are kept of the
-- request handle, the client's \`state\` and the code. \`code_hash\`, \`account_id\` and \`agent_id\` are set when a person
-- approves it, with a new \`expires_at\` for the code.
CREATE TABLE IF NOT EXISTS mcp_authorizations (
  id INTEGER PRIMARY KEY,
  request_hash TEXT NOT NULL UNIQUE,
  client_id INTEGER NOT NULL REFERENCES mcp_clients(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  resource TEXT,
  state_hash TEXT,
  expires_at INTEGER NOT NULL,
  code_hash TEXT UNIQUE,
  account_id INTEGER REFERENCES accounts(id),
  agent_id INTEGER REFERENCES agents(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS mcp_authorizations_by_expiry ON mcp_authorizations (expires_at);
-- Forgetting a client deletes its requests (ON DELETE CASCADE) through this, not by scanning the table.
CREATE INDEX IF NOT EXISTS mcp_authorizations_by_client ON mcp_authorizations (client_id);
-- The same for an agent's row, should one ever be deleted.
CREATE INDEX IF NOT EXISTS mcp_authorizations_by_agent ON mcp_authorizations (agent_id);

${loginCodesTable("login_codes")}
${LOGIN_CODES_INDEXES}
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
      // `person` and `admin` are left to their defaults: no person can exist before accounts did. `migrate` has already
      // added the status columns to the old table, so they come across too.
      db.prepare(
        `INSERT INTO agents_by_account (id, account_id, name, bio, registered_at, last_seen, key_hash, instance, removed_at, removed_name, status, status_at)
         SELECT id, ?, name, bio, registered_at, last_seen, key_hash, instance, removed_at, removed_name, status, status_at FROM agents`,
      ).run(OWNER_ACCOUNT);
      db.exec("DROP TABLE agents");
      db.exec("ALTER TABLE agents_by_account RENAME TO agents");
      if ((db.pragma("foreign_key_check") as unknown[]).length > 0) throw new Error("accounts migration broke a foreign key");
    }).immediate();
  } finally {
    db.pragma(`foreign_keys = ${foreignKeys ? "ON" : "OFF"}`);
  }
}

const messagesAutoincrement = (db: Db) =>
  /\bAUTOINCREMENT\b/i.test((db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'messages'").get() as { sql: string }).sql);

/**
 * Rebuilds a `messages` table from before AUTOINCREMENT as `messagesTable`, keeping every row and its id, so that no id
 * is handed out again once the highest message is deleted. SQLite cannot add AUTOINCREMENT to a table in place. Copying
 * the rows with their ids sets the table's sqlite_sequence entry to the highest id kept. As in addAccounts(), the check
 * and the rebuild happen under the write lock, so when several processes open the file at once exactly one rebuilds.
 */
function rebuildMessages(db: Db): void {
  if (messagesAutoincrement(db)) return;
  // Dropping the old table must not cascade to the webhook deliveries or replies that reference it.
  const foreignKeys = db.pragma("foreign_keys", { simple: true });
  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      if (messagesAutoincrement(db)) return;
      db.exec(messagesTable("messages_autoincrement"));
      db.exec(
        `INSERT INTO messages_autoincrement (id, recipient_id, sender, body, broadcast, created_at, read_at, in_reply_to)
         SELECT id, recipient_id, sender, body, broadcast, created_at, read_at, in_reply_to FROM messages ORDER BY id`,
      );
      db.exec("DROP TABLE messages");
      db.exec("ALTER TABLE messages_autoincrement RENAME TO messages");
      db.exec(MESSAGES_INDEXES);
      db.exec(MESSAGES_REPLY_INDEXES);
      if ((db.pragma("foreign_key_check") as unknown[]).length > 0) throw new Error("messages migration broke a foreign key");
    }).immediate();
  } finally {
    db.pragma(`foreign_keys = ${foreignKeys ? "ON" : "OFF"}`);
  }
}

const loginCodesAutoincrement = (db: Db) =>
  /\bAUTOINCREMENT\b/i.test((db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'login_codes'").get() as { sql: string }).sql);

/**
 * Rebuilds a `login_codes` table from before AUTOINCREMENT as `loginCodesTable`, keeping every row and its id, as
 * rebuildMessages() does for `messages`, so that no invite id is handed out again once the highest code is deleted,
 * whichever server deletes it. Under the write lock, so exactly one process rebuilds. No table refers to `login_codes`.
 */
function rebuildLoginCodes(db: Db): void {
  if (loginCodesAutoincrement(db)) return;
  db.transaction(() => {
    if (loginCodesAutoincrement(db)) return;
    db.exec(loginCodesTable("login_codes_autoincrement"));
    db.exec(
      `INSERT INTO login_codes_autoincrement (id, code_hash, account_id, person_id, expires_at, used_at, invite, created_at, cancelled_at)
       SELECT id, code_hash, account_id, person_id, expires_at, used_at, invite, created_at, cancelled_at FROM login_codes ORDER BY id`,
    );
    db.exec("DROP TABLE login_codes");
    db.exec("ALTER TABLE login_codes_autoincrement RENAME TO login_codes");
    db.exec(LOGIN_CODES_INDEXES);
  }).immediate();
}

const dashboardSessionsAutoincrement = (db: Db) =>
  /\bAUTOINCREMENT\b/i.test(
    (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'dashboard_sessions'").get() as { sql: string }).sql,
  );

/**
 * Rebuilds a `dashboard_sessions` table from before AUTOINCREMENT as `dashboardSessionsTable`, keeping every row and its
 * id, as rebuildLoginCodes() does for `login_codes`, so that no sign-in id is handed out again once the highest sign-in
 * is ended. Under the write lock, so exactly one process rebuilds. No table refers to `dashboard_sessions`.
 */
function rebuildDashboardSessions(db: Db): void {
  if (dashboardSessionsAutoincrement(db)) return;
  db.transaction(() => {
    if (dashboardSessionsAutoincrement(db)) return;
    db.exec(dashboardSessionsTable("dashboard_sessions_autoincrement"));
    db.exec(
      `INSERT INTO dashboard_sessions_autoincrement (id, hash, token_id, created_at)
       SELECT id, hash, token_id, created_at FROM dashboard_sessions ORDER BY id`,
    );
    db.exec("DROP TABLE dashboard_sessions");
    db.exec("ALTER TABLE dashboard_sessions_autoincrement RENAME TO dashboard_sessions");
    db.exec(DASHBOARD_SESSIONS_INDEXES);
  }).immediate();
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
  // 1 for a person marked admin (`person add --admin`, `person admin`); every row from before it existed is not one, so
  // a server from before it treats an admin person's token as a plain person token.
  addColumn(db, "admin", "INTEGER NOT NULL DEFAULT 0");
  // An agent's status line (`set_status`) and when it was set, in ms; null for no line. It is current for
  // STATUS_TTL_MS after `status_at`, worked out when it is read.
  addColumn(db, "status", "TEXT");
  addColumn(db, "status_at", "INTEGER");
  addColumn(db, "joined", "INTEGER NOT NULL DEFAULT 0", "channel_reads");
  // 1 for a token that can only read (`token add --read-only`); tokens made before it existed keep full access.
  addColumn(db, "read_only", "INTEGER NOT NULL DEFAULT 0", "tokens");
  // 1 for a token that cannot act as a person (`token add --agent-only`); tokens made before it existed keep their access.
  // Its row has read_only 1 as well, so a server from before this column sees it as read-only, not full.
  addColumn(db, "agent_only", "INTEGER NOT NULL DEFAULT 0", "tokens");
  // The agent an agent token acts as (`message-cp connect`), null for every other token. Its row is agent-only, so a
  // server from before this column takes it for an agent token that is not bound to one agent.
  addColumn(db, "agent_id", "INTEGER REFERENCES agents(id)", "tokens");
  // The person a person token sends and posts as (`token add --person`), null for every other token. Its row is
  // read-only, so a server from before this column takes it for a read-only token, never a full one.
  addColumn(db, "person_id", "INTEGER REFERENCES agents(id)", "tokens");
  // DELETE /api/people counts the removed person's live tokens, and through them their sign-ins, by this, not by
  // scanning the account's tokens under the write lock (removePersonBy in login.ts).
  db.exec("CREATE INDEX IF NOT EXISTS tokens_live_by_person ON tokens (person_id) WHERE revoked_at IS NULL");
  // 1 for a token the OAuth code exchange issued (exchangeCode in oauth.ts), null for every other token and for one it
  // issued before this column. With it, the client's `client_name` as stored then (null for none) and, for a client known
  // by a Client ID Metadata Document, that URL's host (null otherwise). A server from before these columns ignores them.
  addColumn(db, "oauth", "INTEGER", "tokens");
  addColumn(db, "client_name", "TEXT", "tokens");
  addColumn(db, "client_host", "TEXT", "tokens");
  // 1 for an agent token an approval issued for a client that registers its own agents (exchangeCode in oauth.ts), 0 for
  // every other token and every one from before it. Its row is agent-only, read-only and bound to no agent, so a server
  // from before this column takes it for an unbound agent token, never for anything with more access.
  addColumn(db, "registers", "INTEGER NOT NULL DEFAULT 0", "tokens");
  // When a request last used the token, in ms, as `accountForToken` in accounts.ts records it to within
  // TOKEN_USE_RESOLUTION_MS; null until a request is recorded, so for every token from before it at first. A server from
  // before it ignores it.
  addColumn(db, "last_used_at", "INTEGER", "tokens");
  // 1 for an approval of a client that registers its own agents, which stores no agent_id; 0 for every other. A server
  // from before this column refuses to exchange its code, as it finds no live agent for a null agent_id.
  addColumn(db, "registers", "INTEGER NOT NULL DEFAULT 0", "mcp_authorizations");
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
  // The id of the message a reply answers (`send_message` with `in_reply_to`), null for none. Deleting that message sets
  // it to null. Added here before rebuildMessages() copies it.
  addColumn(db, "in_reply_to", "INTEGER REFERENCES messages(id) ON DELETE SET NULL", "messages");
  // 1 for an invite an admin person made (POST /api/people and /api/invites, src/login.ts), which lasts INVITE_TTL_MS; 0
  // for a `login-link` code and every code from before it. With it, when the code was made (null for one from before)
  // and when it was cancelled (null for not), all added here before rebuildLoginCodes() copies them. Cancelling sets `used_at` as well, so a server from before these columns,
  // which reads only `person_id`, `expires_at` and `used_at`, refuses a cancelled invite as used rather than redeeming it.
  addColumn(db, "invite", "INTEGER NOT NULL DEFAULT 0", "login_codes");
  addColumn(db, "created_at", "INTEGER", "login_codes");
  addColumn(db, "cancelled_at", "INTEGER", "login_codes");
  rebuildLoginCodes(db);
  rebuildDashboardSessions(db);
  // GET /api/invites pages an account's unused invites newest first, and storeCode counts its invites, through this.
  db.exec("CREATE INDEX IF NOT EXISTS login_codes_invites ON login_codes (account_id, used_at, id) WHERE invite = 1");
  // storeCode counts the unused `login-link` codes through this, not by scanning invites.
  db.exec("CREATE INDEX IF NOT EXISTS login_codes_unused_links ON login_codes (used_at) WHERE invite = 0 AND used_at IS NULL");
  rebuildMessages(db);
  db.exec(MESSAGES_REPLY_INDEXES);
  db.exec(DROP_REMOVED);
  db.prepare("INSERT OR IGNORE INTO accounts (id, name, created_at) VALUES (?, 'owner', ?)").run(OWNER_ACCOUNT, Date.now());
  addAccounts(db, path);
  // Until when an agent counts as waiting for mail (`markWaiting` in agents.ts, renewed while a wait is held), in ms; null
  // for never. Added after addAccounts(), whose rebuild of `agents` does not carry it. A delivery queued for an agent's
  // message or mention while it is marked records the agent's id in `held_for`; `sendPending` sends it only once the mark
  // has ended, and drops it instead if the agent has read the message or mention by then.
  addColumn(db, "waiting_until", "INTEGER");
  addColumn(db, "held_for", "INTEGER", "webhook_deliveries");
  // The registering token (`tokens.registers`) whose session registered the agent, null for every other agent and every
  // one from before it. That token may act again as the agent; nothing else follows from it. Added after addAccounts(),
  // like waiting_until.
  addColumn(db, "token_id", "INTEGER REFERENCES tokens(id)");
  // The foreign key's check when a token row is added or changed finds its agents through this, not by scanning agents.
  db.exec("CREATE INDEX IF NOT EXISTS agents_by_token ON agents (token_id)");
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
