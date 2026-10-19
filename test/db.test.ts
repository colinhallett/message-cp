import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { OWNER_ACCOUNT, openDb, preAccountsCopy } from "../src/db.js";
import { addAccount, addToken } from "../src/accounts.js";
import { getAgent, registerAgent } from "../src/agents.js";
import { readInbox, sendMessage } from "../src/messages.js";

const OPEN_DB = join(import.meta.dirname, "fixtures", "open-db.ts");
const SCHEMA_BEFORE_REMOVAL = join(import.meta.dirname, "fixtures", "schema-before-removal.sql");
const SCHEMA_SIGN_IN = join(import.meta.dirname, "fixtures", "schema-sign-in.sql");

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

  it("makes no copy for a new database", () => {
    const file = join(mkdtempSync(join(tmpdir(), "memory-cp-")), "db.sqlite");
    openDb(file).close();
    expect(existsSync(preAccountsCopy(file))).toBe(false);
  });

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
        .prepare("EXPLAIN QUERY PLAN SELECT id, name FROM agents WHERE account_id = ? AND name <> ? AND removed_at IS NULL ORDER BY name")
        .all(OWNER_ACCOUNT, "x") as { detail: string }[];
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
      expect(db.prepare("SELECT DISTINCT account_id FROM agents").pluck().all()).toEqual([OWNER_ACCOUNT]);
      db.close();
      // One copy, and no half-written one left behind by a process that lost the race.
      const dir = join(file, "..");
      expect(readdirSync(dir).filter((f) => f.includes("before-accounts"))).toEqual(["db.sqlite.before-accounts"]);
      expect(statSync(preAccountsCopy(file)).mode & 0o777).toBe(0o600);
    }, 60_000);

    it("gives every agent and message to the owner's account, and copies the file first, owner-only", () => {
      const file = oldDatabase();
      const before = new Database(file, { readonly: true });
      const kept = snapshot(before);
      before.close();
      const umask = process.umask(0o022);
      let db;
      try {
        db = openDb(file);
      } finally {
        process.umask(umask);
      }
      expect(snapshot(db)).toEqual(kept);
      expect(db.prepare("SELECT DISTINCT account_id FROM agents").pluck().all()).toEqual([OWNER_ACCOUNT]);
      expect(getAgent(db, OWNER_ACCOUNT, "bob")?.bio).toBe("b");
      expect(readInbox(db, OWNER_ACCOUNT, "Bob").map((m) => m.body)).toEqual(["hello"]);
      // alice's key still protects her.
      expect(() => registerAgent(db, OWNER_ACCOUNT, "alice", "x", "wrong")).toThrow(/has a key/);
      db.close();

      const copy = preAccountsCopy(file);
      expect(statSync(copy).mode & 0o777).toBe(0o600);
      const saved = new Database(copy, { readonly: true });
      expect(snapshot(saved)).toEqual(kept);
      saved.close();
    });

    it("copies only once: a later open leaves the copy as it was", () => {
      const file = oldDatabase();
      openDb(file).close();
      const first = statSync(preAccountsCopy(file)).mtimeMs;
      const db = openDb(file);
      registerAgent(db, OWNER_ACCOUNT, "carol", "c");
      db.close();
      openDb(file).close();
      expect(statSync(preAccountsCopy(file)).mtimeMs).toBe(first);
    });

    it("replaces a copy left from a migration that never committed", () => {
      const file = oldDatabase();
      writeFileSync(preAccountsCopy(file), "stale");
      openDb(file).close();
      const saved = new Database(preAccountsCopy(file), { readonly: true });
      expect(saved.prepare("SELECT name FROM agents ORDER BY name").pluck().all()).toEqual(["alice", "Bob"]);
      saved.close();
    });

    it("leaves a release from before accounts unable to register, rather than registering across accounts", () => {
      const db = openDb(oldDatabase());
      // What an earlier release runs: its ON CONFLICT(name) matches no unique constraint any more.
      expect(() =>
        db
          .prepare(
            "INSERT INTO agents (name, bio, registered_at, last_seen) VALUES ('x', '', 0, 0) ON CONFLICT(name) DO UPDATE SET bio = 'y'",
          )
          .run(),
      ).toThrow(/ON CONFLICT clause does not match/);
      db.close();
    });
  });

  describe("on a database the GitHub sign-in opened", () => {
    const SIGN_IN = ["github_users", "oauth_clients", "oauth_pending", "oauth_codes", "oauth_grants"];
    const placeholders = SIGN_IN.map(() => "?").join(", ");

    /** A current file with two accounts, then the sign-in's tables and column, with a row in each. */
    function signInDatabase(): string {
      const file = join(mkdtempSync(join(tmpdir(), "memory-cp-")), "db.sqlite");
      const db = openDb(file);
      addAccount(db, "other");
      const other = db.prepare("SELECT id FROM accounts WHERE name = 'other'").pluck().get() as number;
      addToken(db, "owner");
      registerAgent(db, OWNER_ACCOUNT, "alice", "a");
      registerAgent(db, OWNER_ACCOUNT, "bob", "b");
      registerAgent(db, other, "alice", "other a");
      sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "hello");
      db.exec(readFileSync(SCHEMA_SIGN_IN, "utf8"));
      db.exec(`
        UPDATE agents SET wait_key_hash = 'wait-hash' WHERE name = 'alice' AND account_id = ${OWNER_ACCOUNT};
        INSERT INTO github_users (github_id, account_id, login, linked_at) VALUES (7, ${other}, 'octocat', 1);
        INSERT INTO oauth_clients (id, name, redirect_uris, created_at) VALUES ('c', 'client', '[]', 1);
        INSERT INTO oauth_pending (state_hash, browser_hash, client_id, redirect_uri, code_challenge, expires_at) VALUES ('s', 'b', 'c', 'r', 'x', 1);
        INSERT INTO oauth_codes (hash, account_id, client_id, redirect_uri, code_challenge, expires_at) VALUES ('h', ${other}, 'c', 'r', 'x', 1);
        INSERT INTO oauth_grants (account_id, client_id, access_hash, access_expires_at, refresh_hash, refresh_expires_at, created_at)
          VALUES (${other}, 'c', 'a', 1, 'r', 1, 1);
      `);
      db.close();
      return file;
    }

    const everythingElse = (db: Database.Database) => ({
      schema: db
        .prepare(`SELECT type, name, sql FROM sqlite_master WHERE tbl_name NOT IN (${placeholders}) ORDER BY name`)
        .all(...SIGN_IN),
      accounts: db.prepare("SELECT * FROM accounts ORDER BY id").all(),
      tokens: db.prepare("SELECT * FROM tokens ORDER BY id").all(),
      agents: db.prepare("SELECT * FROM agents ORDER BY id").all(),
      messages: db.prepare("SELECT * FROM messages ORDER BY id").all(),
    });

    it("drops the sign-in's tables and indexes, and leaves everything else, wait_key_hash included, as it was", () => {
      const file = signInDatabase();
      const before = new Database(file, { readonly: true });
      const kept = everythingElse(before);
      before.close();

      openDb(file).close();
      const db = openDb(file); // a second open is harmless
      // Dropping the tables drops their indexes, oauth_grants_client and oauth_grants_account.
      expect(db.prepare(`SELECT name FROM sqlite_master WHERE tbl_name IN (${placeholders})`).all(...SIGN_IN)).toEqual([]);
      expect(everythingElse(db)).toEqual(kept);
      expect(db.prepare("SELECT wait_key_hash FROM agents WHERE wait_key_hash IS NOT NULL").pluck().all()).toEqual(["wait-hash"]);
      db.close();
    });
  });
});
