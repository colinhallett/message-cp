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

-- Shared memories. The author is kept as text, like a message sender, so it survives whatever happens to the agent row.
-- AUTOINCREMENT so a forgotten id is never handed to a later memory.
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  author TEXT NOT NULL COLLATE NOCASE,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS memories_author ON memories (author, id);
CREATE INDEX IF NOT EXISTS memories_recent ON memories (created_at, id);

CREATE TABLE IF NOT EXISTS memory_tags (
  memory_id INTEGER NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (tag, memory_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS memory_tags_memory ON memory_tags (memory_id);

-- Keyword index over memory text, kept in step by the triggers below.
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(text, content='memories', content_rowid='id');

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts (rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts (memories_fts, rowid, text) VALUES ('delete', old.id, old.text);
  DELETE FROM memory_tags WHERE memory_id = old.id;
END;
-- Memories are added and deleted, never edited.
CREATE TRIGGER IF NOT EXISTS memories_no_update BEFORE UPDATE ON memories BEGIN
  SELECT RAISE(ABORT, 'memories cannot be edited');
END;
`;

// CREATE TABLE IF NOT EXISTS leaves an existing table alone, so columns added later are added here, only when missing.
function migrate(db: Db): void {
  const columns = db.prepare("PRAGMA table_info(agents)").all() as { name: string }[];
  if (columns.some((c) => c.name === "key_hash")) return;
  try {
    db.exec("ALTER TABLE agents ADD COLUMN key_hash TEXT");
  } catch (err) {
    // Another process added it between our check and the ALTER.
    if (!(err instanceof Error && /duplicate column name/i.test(err.message))) throw err;
  }
}

export function openDb(path: string = dbPath()): Db {
  // Owner-only, whatever the umask: names and bios are not for other local accounts.
  // WAL and journal files take the permissions of the main file.
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (!existsSync(path)) writeFileSync(path, "", { mode: 0o600, flag: "a" });
  const db = new Database(path);
  // WAL and a busy timeout let several processes share the file without lock errors.
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}
