import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { openDb } from "../src/db.js";

const OPEN_DB = join(import.meta.dirname, "fixtures", "open-db.ts");
const SCHEMA_BEFORE_REMOVAL = join(import.meta.dirname, "fixtures", "schema-before-removal.sql");

/** Starts `count` real processes that open `file` at the same instant; resolves to each one's exit code and stderr. */
function openTogether(file: string, count: number) {
  const startAt = String(Date.now() + 4000);
  return Promise.all(
    Array.from({ length: count }, () =>
      new Promise<{ code: number | null; stderr: string }>((resolve) => {
        const child = spawn(process.execPath, ["--import", "tsx", OPEN_DB], {
          env: { ...process.env, MEMORY_CP_DB: file, START_AT: startAt },
        });
        let stderr = "";
        child.stderr.on("data", (d) => (stderr += d));
        child.on("error", (err) => resolve({ code: null, stderr: `spawn failed: ${err.message}` }));
        child.on("exit", (code) => resolve({ code, stderr }));
      }),
    ),
  );
}

describe("openDb", () => {
  it("lets many processes open the same new file at once", async () => {
    for (let round = 0; round < 3; round++) {
      const file = join(mkdtempSync(join(tmpdir(), "memory-cp-")), "db.sqlite");
      const results = await openTogether(file, 40);
      expect(results.filter((r) => r.code !== 0).map((r) => r.stderr)).toEqual([]);

      const db = new Database(file, { readonly: true });
      expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
      db.close();
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  }, 60_000);

  describe("on a database from before memories, tasks and the hive were removed", () => {
    const REMOVED = ["memories", "memories_fts", "memory_tags", "tasks", "task_tags", "hive_runs"];

    /** A file in the old schema with rows in every table, including a read and an unread message. */
    function oldDatabase(): string {
      const file = join(mkdtempSync(join(tmpdir(), "memory-cp-")), "db.sqlite");
      const db = new Database(file);
      db.exec(readFileSync(SCHEMA_BEFORE_REMOVAL, "utf8"));
      db.exec(`
        INSERT INTO agents (id, name, bio, registered_at, last_seen, key_hash, instance) VALUES
          (1, 'alice', 'a', 10, 20, 'hash-a', 'inst-a'),
          (2, 'Bob', 'b', 11, 21, NULL, NULL);
        INSERT INTO messages (id, recipient_id, sender, body, broadcast, created_at, read_at) VALUES
          (1, 2, 'alice', 'hello', 0, 30, NULL),
          (2, 1, 'Bob', 'everyone', 1, 31, 40);
        INSERT INTO memories (author, text, created_at) VALUES ('alice', 'shared knowledge', 50);
        INSERT INTO memory_tags (memory_id, tag) VALUES (1, 'x');
        INSERT INTO tasks (title, details, status, poster, assignee, created_at, claimed_at) VALUES ('t', 'd', 'claimed', 'Bob', 'alice', 60, 61);
        INSERT INTO task_tags (task_id, tag) VALUES (1, 'x');
        INSERT INTO hive_runs (agent, message_ids, started_at) VALUES ('alice', '[2]', 70);
      `);
      db.close();
      return file;
    }

    const snapshot = (db: Database.Database) => ({
      // The columns the old schema had; later releases add columns of their own.
      agents: db.prepare("SELECT id, name, bio, registered_at, last_seen, key_hash, instance FROM agents ORDER BY id").all(),
      messages: db.prepare("SELECT * FROM messages ORDER BY id").all(),
    });

    it("drops the removed tables, their index and triggers, and keeps every agent and message", () => {
      const file = oldDatabase();
      const before = new Database(file, { readonly: true });
      const kept = snapshot(before);
      const otherObjects = before
        .prepare("SELECT type, name FROM sqlite_master WHERE tbl_name IN ('agents', 'messages') ORDER BY name")
        .all();
      before.close();

      openDb(file).close();
      const db = openDb(file); // a second open is harmless
      expect(snapshot(db)).toEqual(kept);
      const left = db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'memor%' OR name LIKE '%task%' OR name LIKE 'hive%'").all();
      expect(left).toEqual([]);
      expect(db.prepare("SELECT type, name FROM sqlite_master WHERE tbl_name IN ('agents', 'messages') ORDER BY name").all()).toEqual(
        [...otherObjects, { type: "index", name: "agents_live" }].sort((a, b) => (a.name < b.name ? -1 : 1)),
      );
      db.close();
    });

    it("adds the columns for removed agents, empty, and changes no existing row", () => {
      const db = openDb(oldDatabase());
      expect(db.prepare("SELECT removed_at, removed_name FROM agents ORDER BY id").all()).toEqual([
        { removed_at: null, removed_name: null },
        { removed_at: null, removed_name: null },
      ]);
      db.close();
    });

    it("lets a broadcast read only the live agents", () => {
      const db = openDb(oldDatabase());
      const plan = db
        .prepare("EXPLAIN QUERY PLAN SELECT id, name FROM agents WHERE name <> ? AND removed_at IS NULL ORDER BY name")
        .all("x") as { detail: string }[];
      expect(plan.map((p) => p.detail).join("\n")).toMatch(/USING INDEX agents_live/);
      db.close();
    });

    it("is upgraded once when many processes open it at once", async () => {
      const file = oldDatabase();
      const before = new Database(file, { readonly: true });
      const kept = snapshot(before);
      before.close();

      const results = await openTogether(file, 20);
      expect(results.filter((r) => r.code !== 0).map((r) => r.stderr)).toEqual([]);

      const db = new Database(file, { readonly: true });
      expect(snapshot(db)).toEqual(kept);
      for (const table of REMOVED) {
        expect(db.prepare("SELECT name FROM sqlite_master WHERE name = ?").get(table)).toBeUndefined();
      }
      db.close();
    }, 60_000);
  });
});
