import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
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
  dbFile = join(mkdtempSync(join(tmpdir(), "memory-cp-msg-")), "db.sqlite");
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

const messageCount = () => (db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n;

describe("registration required", () => {
  it("rejects send_message and read_inbox from an unregistered session", async () => {
    const c = await connect();
    for (const [tool, args] of [
      ["send_message", { to: "all", body: "hi" }],
      ["read_inbox", {}],
    ] as const) {
      const r = await call(c, tool, args);
      expect(r.isError).toBe(true);
      expect(r.text).toContain("Call `register` first");
    }
    expect(messageCount()).toBe(0);
  });
});

describe("direct messages", () => {
  it("delivers exactly once, and a second unread read returns nothing", async () => {
    const a = await connect("alice");
    const b = await connect("bob");
    await call(a, "send_message", { to: "BOB", body: "hello" });

    const first = await call(b, "read_inbox");
    expect(first.json).toHaveLength(1);
    expect(first.json[0]).toMatchObject({ from: "alice", body: "hello", broadcast: false });
    expect(Number.isNaN(Date.parse(first.json[0].sentAt))).toBe(false);

    expect((await call(b, "read_inbox")).json).toEqual([]);
    expect((await call(b, "read_inbox", { unread_only: false })).json).toHaveLength(1);
    expect((await call(a, "read_inbox", { unread_only: false })).json).toEqual([]);
  });

  it("fails for an unknown name, naming it, and stores nothing", async () => {
    const a = await connect("alice");
    const r = await call(a, "send_message", { to: "ghost", body: "hello" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("ghost");
    expect(messageCount()).toBe(0);
  });

  it("rejects an empty or oversized body and stores nothing", async () => {
    const a = await connect("alice");
    await connect("bob");
    expect((await call(a, "send_message", { to: "bob", body: "  \n" })).isError).toBe(true);
    const big = await call(a, "send_message", { to: "bob", body: "x".repeat(MAX_BODY_LENGTH + 1) });
    expect(big.isError).toBe(true);
    expect((await call(a, "send_message", { to: "bob", body: "x".repeat(MAX_BODY_LENGTH) })).isError).toBe(false);
    expect(messageCount()).toBe(1);
  });

  it("returns messages oldest first", async () => {
    const a = await connect("alice");
    const b = await connect("bob");
    for (const body of ["one", "two", "three"]) await call(a, "send_message", { to: "bob", body });
    expect((await call(b, "read_inbox")).json.map((m: { body: string }) => m.body)).toEqual(["one", "two", "three"]);
  });
});

describe("broadcasts", () => {
  it("reaches everyone but the sender, and not agents who register later", async () => {
    const a = await connect("alice");
    const b = await connect("bob");
    const c = await connect("carol");
    await call(a, "send_message", { to: "all", body: "news" });
    const d = await connect("dave");

    expect((await call(a, "read_inbox", { unread_only: false })).json).toEqual([]);
    for (const client of [b, c]) {
      const r = await call(client, "read_inbox");
      expect(r.json).toHaveLength(1);
      expect(r.json[0]).toMatchObject({ from: "alice", body: "news", broadcast: true });
    }
    expect((await call(d, "read_inbox", { unread_only: false })).json).toEqual([]);
  });

  it("keeps read state per recipient", async () => {
    const a = await connect("alice");
    const b = await connect("bob");
    const c = await connect("carol");
    await call(a, "send_message", { to: "all", body: "news" });
    expect((await call(b, "read_inbox")).json).toHaveLength(1);
    expect((await call(c, "read_inbox")).json).toHaveLength(1);
    expect((await call(b, "read_inbox")).json).toEqual([]);
  });

  it("treats a lone sender broadcast as delivered to nobody", async () => {
    const a = await connect("alice");
    const r = await call(a, "send_message", { to: "all", body: "anyone?" });
    expect(r.json).toEqual({ delivered: 0, recipients: [] });
    expect(messageCount()).toBe(0);
  });
});

describe("bounds", () => {
  it("counts characters, not UTF-16 code units, against the body limit", async () => {
    const a = await connect("alice");
    await connect("bob");
    const ok = await call(a, "send_message", { to: "bob", body: "😀".repeat(MAX_BODY_LENGTH) });
    expect(ok.isError).toBe(false);
    const big = await call(a, "send_message", { to: "bob", body: "😀".repeat(MAX_BODY_LENGTH + 1) });
    expect(big.isError).toBe(true);
    expect(messageCount()).toBe(1);
  });

  it("pages the inbox and leaves unread messages beyond the page unread", async () => {
    const a = await connect("alice");
    const b = await connect("bob");
    for (const body of ["1", "2", "3"]) await call(a, "send_message", { to: "bob", body });
    const first = await call(b, "read_inbox", { limit: 2 });
    expect(first.json.map((m: { body: string }) => m.body)).toEqual(["1", "2"]);
    const second = await call(b, "read_inbox", { limit: 2 });
    expect(second.json.map((m: { body: string }) => m.body)).toEqual(["3"]);
    const hist = await call(b, "read_inbox", { unread_only: false, limit: 2, offset: 2 });
    expect(hist.json.map((m: { body: string }) => m.body)).toEqual(["3"]);
  });
});

describe("concurrent connections", () => {
  it("neither loses nor duplicates messages when senders and readers overlap", async () => {
    const sender1 = await connect("s1");
    const sender2 = await connect("s2");
    const reader = await connect("reader");
    const N = 25;
    const sends = Array.from({ length: N }, (_, i) => [
      call(sender1, "send_message", { to: "reader", body: `a${i}` }),
      call(sender2, "send_message", { to: "all", body: `b${i}` }),
    ]).flat();
    const seen: string[] = [];
    const reads = Array.from({ length: N }, async () => {
      const r = await call(reader, "read_inbox");
      seen.push(...r.json.map((m: { body: string }) => m.body));
    });
    await Promise.all([...sends, ...reads]);
    seen.push(...(await call(reader, "read_inbox")).json.map((m: { body: string }) => m.body));

    const expected = Array.from({ length: N }, (_, i) => [`a${i}`, `b${i}`]).flat();
    expect([...seen].sort()).toEqual([...expected].sort());
  });
});

describe("separate server processes", () => {
  it("deliver every message once while reading and writing the same database", async () => {
    const start = async (name: string) => {
      const client = new Client({ name: "test", version: "0" });
      await client.connect(
        new StdioClientTransport({
          command: "npx",
          args: ["tsx", join(import.meta.dirname, "../src/index.ts")],
          env: { ...process.env, MEMORY_CP_DB: dbFile } as Record<string, string>,
        }),
      );
      clients.push(client);
      await call(client, "register", { name, bio: "x" });
      return client;
    };
    const [a, b] = await Promise.all([start("alice"), start("bob")]);
    const N = 20;
    const seen: string[] = [];
    const sends = Array.from({ length: N }, (_, i) =>
      call(a, "send_message", { to: i % 2 ? "all" : "bob", body: `m${i}` }),
    );
    const reads = Array.from({ length: N }, async () => {
      seen.push(...(await call(b, "read_inbox")).json.map((m: { body: string }) => m.body));
    });
    await Promise.all([...sends, ...reads]);
    seen.push(...(await call(b, "read_inbox")).json.map((m: { body: string }) => m.body));

    expect([...seen].sort()).toEqual(Array.from({ length: N }, (_, i) => `m${i}`).sort());
    expect((await call(a, "read_inbox", { unread_only: false })).json).toEqual([]);
  }, 60_000);
});
