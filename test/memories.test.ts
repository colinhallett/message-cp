import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db.js";
import { createServer } from "../src/server.js";

let dbFile: string;
let db: Db;
const clients: Client[] = [];

beforeEach(() => {
  dbFile = join(mkdtempSync(join(tmpdir(), "memory-cp-mem-")), "db.sqlite");
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
  const res = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: { text: string }[];
  };
  const text = res.content[0].text;
  return { isError: !!res.isError, text, json: res.isError ? undefined : JSON.parse(text) };
}

const memoryCount = () => (db.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number }).n;
const ids = (r: { json: { id: number }[] }) => r.json.map((m) => m.id);

describe("registration required", () => {
  it("rejects remember, recall and forget from an unregistered session", async () => {
    const c = await connect();
    for (const [tool, args] of [
      ["remember", { text: "hi" }],
      ["recall", {}],
      ["forget", { id: 1 }],
    ] as const) {
      const r = await call(c, tool, args);
      expect(r.isError).toBe(true);
      expect(r.text).toContain("Call `register` first");
    }
    expect(memoryCount()).toBe(0);
  });
});

describe("shared memories", () => {
  it("lets agent B find A's memory by keyword, tag and author, and either agent delete it", async () => {
    const a = await connect("alice");
    const b = await connect("bob");
    const stored = await call(a, "remember", { text: "The deploy key lives in vault", tags: ["ops", "secrets"] });
    const id = stored.json.id;

    expect(ids(await call(b, "recall", { query: "deploy" }))).toEqual([id]);
    expect(ids(await call(b, "recall", { tags: ["ops"] }))).toEqual([id]);
    expect(ids(await call(b, "recall", { author: "ALICE" }))).toEqual([id]);

    expect((await call(b, "forget", { id })).json).toEqual({ forgotten: id });
    for (const args of [{ query: "deploy" }, { tags: ["ops"] }, { author: "alice" }, {}]) {
      expect((await call(a, "recall", args)).json).toEqual([]);
    }
    expect(memoryCount()).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM memory_tags").get()).toEqual({ n: 0 });

    const second = await call(b, "remember", { text: "another note" });
    await call(a, "forget", { id: second.json.id });
    expect(memoryCount()).toBe(0);
  });

  it("records the author and time, and refuses edits", async () => {
    const a = await connect("alice");
    const before = Date.now();
    const m = (await call(a, "remember", { text: "note", tags: ["b", "a", "a"] })).json;
    expect(m.author).toBe("alice");
    expect(m.tags).toEqual(["a", "b"]);
    expect(Date.parse(m.storedAt)).toBeGreaterThanOrEqual(before);

    const row = db.prepare("SELECT author, created_at FROM memories WHERE id = ?").get(m.id);
    expect(row).toEqual({ author: "alice", created_at: Date.parse(m.storedAt) });
    expect(() => db.prepare("UPDATE memories SET author = 'mallory' WHERE id = ?").run(m.id)).toThrow(/cannot be edited/);
    expect(() => db.prepare("UPDATE memories SET text = 'x' WHERE id = ?").run(m.id)).toThrow(/cannot be edited/);

    const { tools } = await a.listTools();
    expect(tools.map((t) => t.name).filter((n) => /update|edit/.test(n))).toEqual([]);
  });
});

describe("recall keyword", () => {
  it("treats the query as plain words", async () => {
    const a = await connect("alice");
    const hyphen = (await call(a, "remember", { text: "see foo-bar for details" })).json.id;
    const quoted = (await call(a, "remember", { text: 'she said "hello" there' })).json.id;
    const star = (await call(a, "remember", { text: "wild * card AND friends" })).json.id;
    const colon = (await call(a, "remember", { text: "key: value pair" })).json.id;

    const q = async (query: string) => {
      const r = await call(a, "recall", { query });
      expect(r.isError).toBe(false);
      return ids(r);
    };
    expect(await q("foo-bar")).toEqual([hyphen]);
    expect(await q('"hello"')).toEqual([quoted]);
    expect(await q('hel"lo')).toEqual([]);
    expect(await q("*")).toEqual([]);
    expect(await q("wild *")).toEqual([star]);
    expect(await q("AND")).toEqual([star]);
    expect(await q("key:")).toEqual([colon]);
    expect(await q("NOT OR NEAR ( ) ^ -")).toEqual([]);
    expect(await q("   ")).toEqual([colon, star, quoted, hyphen]);
  });

  it("keeps the index in step with deletes", async () => {
    const a = await connect("alice");
    const id = (await call(a, "remember", { text: "ephemeral thing" })).json.id;
    await call(a, "forget", { id });
    expect(ids(await call(a, "recall", { query: "ephemeral" }))).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM memories_fts WHERE memories_fts MATCH 'ephemeral'").get()).toEqual({ n: 0 });
  });
});

describe("recall filters", () => {
  it("combines them, requiring all tags", async () => {
    const a = await connect("alice");
    const b = await connect("bob");
    const one = (await call(a, "remember", { text: "cats are great", tags: ["pets", "x"] })).json.id;
    const two = (await call(b, "remember", { text: "cats are loud", tags: ["pets"] })).json.id;
    const three = (await call(a, "remember", { text: "dogs are great", tags: ["pets", "x"] })).json.id;

    expect(ids(await call(a, "recall", { tags: ["pets"] }))).toEqual([three, two, one]);
    expect(ids(await call(a, "recall", { tags: ["pets", "x"] }))).toEqual([three, one]);
    expect(ids(await call(a, "recall", { tags: ["pets", "x", "nope"] }))).toEqual([]);
    expect(ids(await call(a, "recall", { tags: ["pets"], author: "bob" }))).toEqual([two]);
    expect(ids(await call(a, "recall", { query: "cats", tags: ["pets", "x"] }))).toEqual([one]);
    expect(ids(await call(a, "recall", { query: "cats", author: "alice", tags: ["pets"] }))).toEqual([one]);
    expect(ids(await call(a, "recall", { author: "nobody" }))).toEqual([]);
  });

  it("returns newest first, defaults to 20 and caps at 100", async () => {
    const a = await connect("alice");
    const insert = db.prepare("INSERT INTO memories (author, text, created_at) VALUES ('alice', ?, ?)");
    for (let i = 1; i <= 120; i++) insert.run(`m${i}`, i);

    const def = (await call(a, "recall")).json;
    expect(def).toHaveLength(20);
    expect(def[0].text).toBe("m120");
    expect(def[19].text).toBe("m101");
    expect((await call(a, "recall", { limit: 100 })).json).toHaveLength(100);
    expect((await call(a, "recall", { limit: 5 })).json.map((m: { text: string }) => m.text)).toEqual([
      "m120", "m119", "m118", "m117", "m116",
    ]);
    expect((await call(a, "recall", { limit: 101 })).isError).toBe(true);
  });
});

describe("remember validation", () => {
  it("rejects empty and over-long text and bad tags without storing", async () => {
    const a = await connect("alice");
    expect((await call(a, "remember", { text: "  " })).isError).toBe(true);
    expect((await call(a, "remember", { text: "x".repeat(4001) })).isError).toBe(true);
    expect((await call(a, "remember", { text: "ok", tags: [""] })).isError).toBe(true);
    expect((await call(a, "remember", { text: "ok", tags: ["t".repeat(51)] })).isError).toBe(true);
    expect(memoryCount()).toBe(0);
    expect((await call(a, "remember", { text: "x".repeat(4000) })).isError).toBe(false);
  });
});

describe("forget", () => {
  it("never reuses a forgotten id, so a stale forget cannot delete a newer memory", async () => {
    const a = await connect("alice");
    const b = await connect("bob");
    await call(a, "remember", { text: "first" });
    const second = (await call(a, "remember", { text: "second" })).json.id;
    await call(a, "forget", { id: second });
    const third = (await call(b, "remember", { text: "third" })).json.id;
    expect(third).toBeGreaterThan(second);
    expect((await call(a, "forget", { id: second })).isError).toBe(true);
    expect(ids(await call(a, "recall", { query: "third" }))).toEqual([third]);
  });

  it("treats an empty author as a filter that matches nobody", async () => {
    const a = await connect("alice");
    await call(a, "remember", { text: "hello" });
    expect((await call(a, "recall", { author: "" })).json).toEqual([]);
  });

  it("errors on a missing id and changes nothing", async () => {
    const a = await connect("alice");
    await call(a, "remember", { text: "keep me", tags: ["t"] });
    const r = await call(a, "forget", { id: 999 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("No memory with id 999");
    expect(memoryCount()).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM memory_tags").get()).toEqual({ n: 1 });
    expect((await call(a, "recall", { query: "keep" })).json).toHaveLength(1);
  });
});
