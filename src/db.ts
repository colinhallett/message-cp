import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type Db = Database.Database;

/** The one database file shared by every server process on this machine. */
export function dbPath(): string {
  return process.env.MEMORY_CP_DB || join(homedir(), ".memory-cp", "db.sqlite");
}

/** The account the migration creates: the token in MEMORY_CP_HTTP_TOKEN, stdio and `memory-cp wait` act as it. */
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
  revoked_at INTEGER
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

-- Sign-in with GitHub (src/oauth.ts). An account is tied to the GitHub user id, never the login, which can change hands.
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
`;

// CREATE TABLE IF NOT EXISTS leaves an existing table alone, so columns added later are added here, only when missing.
const hasColumn = (db: Db, column: string) =>
  (db.prepare("PRAGMA table_info(agents)").all() as { name: string }[]).some((c) => c.name === column);

function addColumn(db: Db, column: string, definition: string): void {
  if (hasColumn(db, column)) return;
  try {
    db.exec(`ALTER TABLE agents ADD COLUMN ${column} ${definition}`);
  } catch (err) {
    // Another process added it between our check and the ALTER.
    if (!(err instanceof Error && /duplicate column name/i.test(err.message))) throw err;
  }
}

// Shared memories, the task board and the hive's run log were removed, so their tables go too.
// Dropping a table drops its indexes and triggers; the full-text index is a table of its own.
// IF EXISTS makes this a no-op once done, and harmless when several processes open the file at once.
const DROP_REMOVED = `
DROP TABLE IF EXISTS memories_fts;
DROP TABLE IF EXISTS memory_tags;
DROP TABLE IF EXISTS memories;
DROP TABLE IF EXISTS task_tags;
DROP TABLE IF EXISTS tasks;
DROP TABLE IF EXISTS hive_runs;
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
  db.exec(DROP_REMOVED);
  db.prepare("INSERT OR IGNORE INTO accounts (id, name, created_at) VALUES (?, 'owner', ?)").run(OWNER_ACCOUNT, Date.now());
  addAccounts(db, path);
  // The key hash again, only when `register` generated the key; /wait takes a key without a token only then.
  addColumn(db, "wait_key_hash", "TEXT");
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
