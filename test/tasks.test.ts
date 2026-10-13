import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db.js";
import { MAX_BODY_LENGTH } from "../src/messages.js";
import { createServer } from "../src/server.js";

let dbFile: string;
let db: Db;
const clients: Client[] = [];

beforeEach(() => {
  dbFile = join(mkdtempSync(join(tmpdir(), "memory-cp-task-")), "db.sqlite");
  db = openDb(dbFile);
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  db.close();
});

async function connect(name?: string): Promise<Client> {
  const server = createServer(openDb(dbFile));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  clients.push(client);
  if (name) await call(client, "register", { name, bio: "x" });
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  const text = res.content[0].text;
  return { isError: !!res.isError, text, json: res.isError ? undefined : JSON.parse(text) };
}

const row = (id: number) => db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Record<string, unknown>;
const messageCount = () => (db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n;

async function post(c: Client, title = "t", extra: Record<string, unknown> = {}) {
  return (await call(c, "post_task", { title, details: "d", ...extra })).json.id as number;
}

describe("registration required", () => {
  it("rejects every task tool from an unregistered session", async () => {
    const c = await connect();
    for (const [tool, args] of [
      ["post_task", { title: "t", details: "d" }],
      ["list_tasks", {}],
      ["get_task", { id: 1 }],
      ["claim_task", { id: 1 }],
      ["release_task", { id: 1 }],
      ["complete_task", { id: 1, result: "r" }],
    ] as const) {
      const r = await call(c, tool, args);
      expect(r.isError).toBe(true);
      expect(r.text).toContain("Call `register` first");
    }
    expect(db.prepare("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({ n: 0 });
  });
});

describe("state rules", () => {
  it("allows only open→claimed, claimed→open and claimed→done, and names the state otherwise", async () => {
    const a = await connect("alice");
    const b = await connect("bob");
    const id = await post(a);
    expect((await call(a, "post_task", { title: "x", details: "y", tags: ["z"] })).json).toMatchObject({ status: "open", poster: "alice", tags: ["z"] });

    // open: cannot be released or completed
    for (const r of [await call(b, "release_task", { id }), await call(b, "complete_task", { id, result: "r" })]) {
      expect(r.isError).toBe(true);
      expect(r.text).toContain("open");
    }
    expect(row(id)).toMatchObject({ status: "open", assignee: null });

    expect((await call(b, "claim_task", { id })).json).toMatchObject({ status: "claimed", assignee: "bob" });
    // claimed: cannot be claimed again, by anyone, and the error names the holder
    for (const c of [a, b]) {
      const r = await call(c, "claim_task", { id });
      expect(r.isError).toBe(true);
      expect(r.text).toContain("claimed by bob");
    }
    expect((await call(b, "release_task", { id })).json).toMatchObject({ status: "open", assignee: null });
    await call(a, "claim_task", { id });
    expect((await call(a, "complete_task", { id, result: "ok" })).json).toMatchObject({ status: "done", result: "ok" });

    // done: nothing moves it
    for (const r of [
      await call(b, "claim_task", { id }),
      await call(a, "release_task", { id }),
      await call(a, "complete_task", { id, result: "again" }),
    ]) {
      expect(r.isError).toBe(true);
      expect(r.text).toContain("done by alice");
    }
    expect(row(id)).toMatchObject({ status: "done", assignee: "alice", result: "ok" });
    expect((await call(a, "claim_task", { id: 999 })).text).toContain("No task with id 999");
  });

  it("lets only the claimer release or complete", async () => {
    const a = await connect("alice");
    const b = await connect("bob");
    const c = await connect("carol");
    const id = await post(a);
    await call(b, "claim_task", { id });
    for (const r of [
      await call(c, "release_task", { id }),
      await call(a, "release_task", { id }),
      await call(c, "complete_task", { id, result: "mine" }),
      await call(a, "complete_task", { id, result: "mine" }),
    ]) {
      expect(r.isError).toBe(true);
      expect(r.text).toContain("claimed by bob");
    }
    expect(row(id)).toMatchObject({ status: "claimed", assignee: "bob", result: null });
    expect(messageCount()).toBe(0);
  });
});

describe("completion message", () => {
  it("sends one message from the claimer to the poster, and none if they are the same", async () => {
    const a = await connect("alice");
    const b = await connect("bob");
    const id = await post(a, "Fix it");
    await call(b, "claim_task", { id });
    await call(b, "complete_task", { id, result: "fixed" });
    const inbox = (await call(a, "read_inbox")).json;
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ from: "bob", body: `Task ${id} done: Fix it\n\nfixed`, broadcast: false });

    const own = await post(a);
    await call(a, "claim_task", { id: own });
    await call(a, "complete_task", { id: own, result: "self" });
    expect(messageCount()).toBe(1);
  });

  it("shortens a 4000-character result so the message fits, and keeps the full result on the task", async () => {
    const a = await connect("alice");
    const b = await connect("bob");
    const id = await post(a, "Big");
    await call(b, "claim_task", { id });
    const result = "x".repeat(4000);
    expect((await call(b, "complete_task", { id, result })).isError).toBe(false);
    const msg = (await call(a, "read_inbox")).json[0].body as string;
    expect([...msg].length).toBeLessThanOrEqual(MAX_BODY_LENGTH);
    expect(msg.endsWith(`… (full result: get_task(${id}))`)).toBe(true);
    expect((await call(a, "get_task", { id })).json.result).toBe(result);
    expect((await call(b, "complete_task", { id, result: "x".repeat(4001) })).isError).toBe(true);
  });

  it("does not shorten a result that fits exactly", async () => {
    const a = await connect("alice");
    const b = await connect("bob");
    const id = await post(a, "T");
    await call(b, "claim_task", { id });
    const head = `Task ${id} done: T\n\n`;
    const result = "é".repeat(MAX_BODY_LENGTH - head.length);
    await call(b, "complete_task", { id, result });
    expect((await call(a, "read_inbox")).json[0].body).toBe(head + result);
  });

  it("rolls the state change back when the message cannot be sent", async () => {
    const a = await connect("alice");
    const b = await connect("bob");
    const id = await post(a);
    await call(b, "claim_task", { id });
    db.exec("CREATE TRIGGER boom BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'boom'); END");
    expect((await call(b, "complete_task", { id, result: "r" })).isError).toBe(true);
    db.exec("DROP TRIGGER boom");
    expect(row(id)).toMatchObject({ status: "claimed", assignee: "bob", result: null });
    expect(messageCount()).toBe(0);
  });
});

describe("posting and listing", () => {
  it("validates title, details, result and tags", async () => {
    const a = await connect("alice");
    expect((await call(a, "post_task", { title: " ", details: "d" })).isError).toBe(true);
    expect((await call(a, "post_task", { title: "x".repeat(201), details: "d" })).isError).toBe(true);
    expect((await call(a, "post_task", { title: "x".repeat(200), details: "x".repeat(4001) })).isError).toBe(true);
    expect((await call(a, "post_task", { title: "t", details: "d", tags: ["x".repeat(51)] })).isError).toBe(true);
    expect((await call(a, "post_task", { title: "😀".repeat(200), details: "😀".repeat(4000) })).isError).toBe(false);
    expect(db.prepare("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({ n: 1 });
  });

  it("filters by status, tags (all) and assignee case-insensitively, oldest first, with paging", async () => {
    const a = await connect("alice");
    const b = await connect("Bob");
    const t1 = await post(a, "one", { tags: ["x", "y"] });
    const t2 = await post(a, "two", { tags: ["x"] });
    const t3 = await post(a, "three");
    await call(b, "claim_task", { id: t2 });
    const ids = async (args: Record<string, unknown>) =>
      (await call(a, "list_tasks", args)).json.map((t: { id: number }) => t.id);

    expect(await ids({})).toEqual([t1, t2, t3]);
    expect(await ids({ status: "open" })).toEqual([t1, t3]);
    expect(await ids({ status: "claimed" })).toEqual([t2]);
    expect(await ids({ tags: ["x"] })).toEqual([t1, t2]);
    expect(await ids({ tags: ["x", "y"] })).toEqual([t1]);
    expect(await ids({ assignee: "BOB" })).toEqual([t2]);
    expect(await ids({ assignee: "bob", tags: ["y"] })).toEqual([]);
    expect(await ids({ limit: 2 })).toEqual([t1, t2]);
    expect(await ids({ limit: 2, offset: 2 })).toEqual([t3]);
    expect((await call(a, "list_tasks", { limit: 201 })).isError).toBe(true);
    expect((await call(a, "get_task", { id: t1 })).json).toMatchObject({ title: "one", tags: ["x", "y"] });
  });
});

describe("existing databases", () => {
  it("gains the task tables when opened without them, leaving other data alone", () => {
    const file = join(mkdtempSync(join(tmpdir(), "memory-cp-old-")), "db.sqlite");
    const old = new Database(file);
    old.exec(`CREATE TABLE agents (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, bio TEXT NOT NULL,
      registered_at INTEGER NOT NULL, last_seen INTEGER NOT NULL);
      INSERT INTO agents (name, bio, registered_at, last_seen) VALUES ('old', 'b', 1, 1);`);
    old.close();
    const upgraded = openDb(file);
    expect(upgraded.prepare("SELECT name FROM agents").all()).toEqual([{ name: "old" }]);
    expect(upgraded.prepare("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({ n: 0 });
    expect(upgraded.prepare("SELECT COUNT(*) AS n FROM task_tags").get()).toEqual({ n: 0 });
    upgraded.close();
  });
});

describe("separate server processes", () => {
  const start = async (name: string) => {
    const client = new Client({ name: "test", version: "0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ["--import", "tsx", join(import.meta.dirname, "../src/index.ts")],
        env: { ...process.env, MEMORY_CP_DB: dbFile } as Record<string, string>,
      }),
    );
    clients.push(client);
    await call(client, "register", { name, bio: "x" });
    return client;
  };

  it("lets exactly one of several racing claimers win, every time, and reports the result to the poster", async () => {
    const [poster, ...racers] = await Promise.all(["poster", "r1", "r2", "r3"].map(start));
    let last = { id: 0, winner: "" };
    for (let round = 0; round < 25; round++) {
      const id = await post(poster, `round ${round}`);
      const results = await Promise.all(racers.map((c) => call(c, "claim_task", { id })));
      const winners = results.flatMap((r, i) => (r.isError ? [] : [`r${i + 1}`]));
      expect(winners).toHaveLength(1);
      for (const r of results.filter((r) => r.isError)) expect(r.text).toContain(`claimed by ${winners[0]}`);
      expect(row(id)).toMatchObject({ status: "claimed", assignee: winners[0] });
      last = { id, winner: winners[0] };
    }
    const winner = racers[Number(last.winner.slice(1)) - 1];
    const loser = racers.find((c) => c !== winner)!;
    expect((await call(loser, "complete_task", { id: last.id, result: "no" })).isError).toBe(true);
    expect((await call(winner, "complete_task", { id: last.id, result: "yes" })).json.status).toBe("done");
    const inbox = (await call(poster, "read_inbox")).json;
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ from: last.winner, body: `Task ${last.id} done: round 24\n\nyes` });
    expect((await call(poster, "list_tasks", { status: "done" })).json).toMatchObject([{ id: last.id, result: "yes" }]);
  }, 120_000);
});
