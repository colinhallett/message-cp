import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
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
`;

export function openDb(path: string = dbPath()): Db {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  // WAL and a busy timeout let several processes share the file without lock errors.
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA);
  return db;
}
