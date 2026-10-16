import Database from "better-sqlite3";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type Db = Database.Database;

/** The one database file shared by every server process on this machine. */
export function dbPath(): string {
  return process.env.MEMORY_CP_DB || join(homedir(), ".memory-cp", "db.sqlite");
}

// Every table lives here so later changes add to one place.
// NOCASE makes names unique regardless of case while keeping the first-registered spelling.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  bio TEXT NOT NULL,
  registered_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);

-- One row per recipient, so a broadcast has its own read state for each agent.
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
`;

// CREATE TABLE IF NOT EXISTS leaves an existing table alone, so columns added later are added here, only when missing.
function addColumn(db: Db, column: string, definition: string): void {
  const columns = db.prepare("PRAGMA table_info(agents)").all() as { name: string }[];
  if (columns.some((c) => c.name === column)) return;
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

function migrate(db: Db): void {
  addColumn(db, "key_hash", "TEXT");
  // A random token per registration, so a session can tell its agent from a later one that reuses the id or name.
  addColumn(db, "instance", "TEXT");
  // A removed agent keeps its row, so the messages addressed to it stay and its id is never reused.
  addColumn(db, "removed_at", "INTEGER");
  addColumn(db, "removed_name", "TEXT");
  db.exec(DROP_REMOVED);
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
  migrate(db);
  return db;
}
