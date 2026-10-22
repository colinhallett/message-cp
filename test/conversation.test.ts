import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addAccount } from "../src/accounts.js";
import { addPerson, registerAgent, registerWithIdentity } from "../src/agents.js";
import { OWNER_ACCOUNT, openDb, type AccountId, type Db } from "../src/db.js";
import { readConversation, sendAsPerson, sendMessage, unreadSummary } from "../src/messages.js";
import { Session, createServer } from "../src/server.js";

let dbFile: string;
let db: Db;
let friend: AccountId;
const clients: Client[] = [];

beforeEach(() => {
  dbFile = join(mkdtempSync(join(tmpdir(), "message-cp-conversation-")), "db.sqlite");
  db = openDb(dbFile);
  addAccount(db, "friend");
  friend = (db.prepare("SELECT id FROM accounts WHERE name = 'friend'").get() as { id: number }).id;
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  db.close();
});

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  const text = res.content[0].text;
  return { isError: !!res.isError, text, json: res.isError ? undefined : JSON.parse(text) };
}

const ok = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
  const r = await call(client, name, args);
  expect(r.isError, r.text).toBe(false);
  return r.json;
};

/** A session of `account`, registered as `name` if given. */
async function connect(name?: string, account: AccountId = OWNER_ACCOUNT) {
  const server = createServer(openDb(dbFile), new Session(account));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  clients.push(client);
  if (name) await ok(client, "register", { name, bio: "x" });
  return client;
}

// Messages of the same millisecond are ordered by id, but keep them apart where the test reads their times.
const tick = () => new Promise((r) => setTimeout(r, 5));
const bodies = (results: { body: string }[]) => results.map((r) => r.body);

describe("read_conversation", () => {
  it("returns both sides of the conversation with one agent, newest first, and nothing else", async () => {
    const alice = await connect("alice");
    const bob = await connect("bob");
    const carol = await connect("carol");
    await ok(alice, "send_message", { to: "bob", body: "a1" });
    await tick();
    await ok(bob, "send_message", { to: "alice", body: "b1" });
    await tick();
    await ok(alice, "send_message", { to: "all", body: "a-all" });
    await ok(carol, "send_message", { to: "alice", body: "c1" });
    await ok(carol, "send_message", { to: "bob", body: "c2" });
    await ok(alice, "post", { channel: "ops", body: "@bob a post" });

    const page = await ok(alice, "read_conversation", { name: "BOB" });
    expect(page).toEqual([
      { from: "alice", to: "bob", sentAt: expect.any(String), body: "a-all", broadcast: true },
      { from: "bob", to: "alice", sentAt: expect.any(String), body: "b1", broadcast: false },
      { from: "alice", to: "bob", sentAt: expect.any(String), body: "a1", broadcast: false },
    ]);
    expect(Date.parse(page[0].sentAt)).toBeGreaterThan(Date.parse(page[1].sentAt));
    expect(bodies(await ok(bob, "read_conversation", { name: "alice" }))).toEqual(["a-all", "b1", "a1"]);
  });

  it("includes a person of the account, either way", async () => {
    addPerson(db, "owner", "colin");
    const alice = await connect("alice");
    await ok(alice, "send_message", { to: "colin", body: "to colin" });
    sendAsPerson(db, OWNER_ACCOUNT, "colin", "alice", "from colin");
    expect(await ok(alice, "read_conversation", { name: "Colin" })).toEqual([
      { from: "colin", to: "alice", sentAt: expect.any(String), body: "from colin", broadcast: false },
      { from: "alice", to: "colin", sentAt: expect.any(String), body: "to colin", broadcast: false },
    ]);
  });

  it("shows a message the caller sent itself once", async () => {
    const alice = await connect("alice");
    await ok(alice, "send_message", { to: "alice", body: "note to self" });
    expect(await ok(alice, "read_conversation", { name: "ALICE" })).toEqual([
      { from: "alice", to: "alice", sentAt: expect.any(String), body: "note to self", broadcast: false },
    ]);
  });

  it("pages with limit and offset, 50 by default, at most 200", async () => {
    const alice = await connect("alice");
    const bob = await connect("bob");
    for (let i = 0; i < 55; i++) await ok(i % 2 ? bob : alice, "send_message", { to: i % 2 ? "alice" : "bob", body: `m${i}` });
    expect((await ok(alice, "read_conversation", { name: "bob" })).length).toBe(50);
    expect(bodies(await ok(alice, "read_conversation", { name: "bob", limit: 2 }))).toEqual(["m54", "m53"]);
    expect(bodies(await ok(alice, "read_conversation", { name: "bob", limit: 2, offset: 53 }))).toEqual(["m1", "m0"]);
    expect((await call(alice, "read_conversation", { name: "bob", limit: 201 })).isError).toBe(true);
    expect((await call(alice, "read_conversation", { name: "bob", offset: -1 })).isError).toBe(true);
  });

  it("requires register first", async () => {
    await connect("bob");
    const r = await call(await connect(), "read_conversation", { name: "bob" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Call `register` first");
  });

  it("gives send_message's error for an unknown or removed name", async () => {
    const alice = await connect("alice");
    const bob = await connect("bob");
    await ok(alice, "send_message", { to: "bob", body: "x" });
    await ok(bob, "unregister");
    for (const name of ["bob", "nobody"]) {
      const r = await call(alice, "read_conversation", { name });
      expect(r).toMatchObject({ isError: true, text: `No agent named '${name}'.` });
      expect((await call(alice, "send_message", { to: name, body: "x" })).text).toBe(r.text);
    }
  });

  it("marks nothing read and changes no unread count, the other's lastSeen or /wait answer", async () => {
    const alice = await connect("alice");
    const bob = await connect("bob");
    await ok(alice, "send_message", { to: "bob", body: "hello" });
    await ok(bob, "send_message", { to: "alice", body: "hi" });
    const before = { alice: unreadSummary(db, OWNER_ACCOUNT, "alice"), bob: unreadSummary(db, OWNER_ACCOUNT, "bob") };
    const bobSeen = (await ok(alice, "get_agent", { name: "bob" })).lastSeen;
    const reads = db.prepare("SELECT id, read_at FROM messages ORDER BY id");
    const rows = reads.all();
    await tick();
    expect((await ok(alice, "read_conversation", { name: "bob" })).length).toBe(2);
    expect(reads.all()).toEqual(rows);
    expect(unreadSummary(db, OWNER_ACCOUNT, "alice")).toEqual(before.alice);
    expect(unreadSummary(db, OWNER_ACCOUNT, "bob")).toEqual(before.bob);
    expect(before.alice).toMatchObject({ count: 1, senders: ["bob"] });
    expect((await ok(alice, "get_agent", { name: "bob" })).lastSeen).toBe(bobSeen);
    expect(bodies(await ok(alice, "read_inbox"))).toEqual(["hi"]);
    expect(bodies(await ok(bob, "read_inbox"))).toEqual(["hello"]);
  });

  it("never returns another account's agents or messages, even under the same names", async () => {
    const alice = await connect("alice");
    const bob = await connect("bob");
    const fAlice = await connect("alice", friend);
    const fBob = await connect("bob", friend);
    await connect("carol", friend);
    await ok(fAlice, "send_message", { to: "bob", body: "friend a" });
    await ok(fBob, "send_message", { to: "alice", body: "friend b" });
    await ok(alice, "send_message", { to: "bob", body: "mine" });

    expect(bodies(await ok(alice, "read_conversation", { name: "bob" }))).toEqual(["mine"]);
    expect(bodies(await ok(bob, "read_conversation", { name: "alice" }))).toEqual(["mine"]);
    expect(bodies(await ok(fAlice, "read_conversation", { name: "bob" }))).toEqual(["friend b", "friend a"]);
    expect((await call(alice, "read_conversation", { name: "carol" })).text).toBe("No agent named 'carol'.");
  });

  it("does not give a later agent with a removed agent's name what the removed one sent or received", async () => {
    const alice = await connect("alice");
    const bob = await connect("bob");
    await ok(alice, "send_message", { to: "bob", body: "to the first bob" });
    await ok(bob, "send_message", { to: "alice", body: "from the first bob" });
    await ok(bob, "unregister");
    await tick();
    const bob2 = await connect("bob");
    expect(await ok(bob2, "read_conversation", { name: "alice" })).toEqual([]);
    await ok(alice, "send_message", { to: "bob", body: "to the second bob" });
    await ok(bob2, "send_message", { to: "alice", body: "from the second bob" });
    expect(bodies(await ok(bob2, "read_conversation", { name: "alice" }))).toEqual(["from the second bob", "to the second bob"]);
    // alice still has what the first bob sent her: it is her own mail.
    expect(bodies(await ok(alice, "read_conversation", { name: "bob" }))).toEqual([
      "from the second bob",
      "to the second bob",
      "from the first bob",
    ]);
    // The removed registration's session is unregistered, so it cannot read either.
    expect((await call(bob, "read_conversation", { name: "alice" })).isError).toBe(true);
  });

  it("returns nothing for a registration that is no longer live", () => {
    registerAgent(db, OWNER_ACCOUNT, "bob", "x");
    const { identity } = registerWithIdentity(db, OWNER_ACCOUNT, "alice", "x");
    sendMessage(db, OWNER_ACCOUNT, "bob", "alice", "hi");
    db.prepare("UPDATE agents SET instance = 'other' WHERE id = ?").run(identity.id);
    expect(readConversation(db, OWNER_ACCOUNT, { ...identity, name: "alice" }, "bob")).toEqual([]);
  });

  it("keeps what an agent sent when its name is taken over with its key", async () => {
    const alice = await connect("alice");
    const bob = await connect();
    const { key } = await ok(bob, "register", { name: "bob", bio: "x" });
    await ok(bob, "send_message", { to: "alice", body: "before" });
    await ok(alice, "send_message", { to: "bob", body: "reply" });
    const again = await connect();
    await ok(again, "register", { name: "bob", bio: "y", key });
    expect(bodies(await ok(again, "read_conversation", { name: "alice" }))).toEqual(["reply", "before"]);
  });

  it("logs nothing", async () => {
    const alice = await connect("alice");
    await connect("bob");
    await ok(alice, "send_message", { to: "bob", body: "secret" });
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m));
    const stderr = vi.spyOn(process.stderr, "write");
    const stdout = vi.spyOn(process.stdout, "write");
    await ok(alice, "read_conversation", { name: "bob" });
    for (const spy of [...spies, stderr, stdout]) expect(spy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("reads each direction through messages_by_sender, without scanning other history", () => {
    registerAgent(db, OWNER_ACCOUNT, "bob", "x");
    const { identity } = registerWithIdentity(db, OWNER_ACCOUNT, "alice", "x");
    // Catch the page statement readConversation runs and the values it binds, so the plan is of the real query.
    let page: { sql: string; args: unknown[] } | undefined;
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      const stmt = prepare(sql);
      if (!sql.includes("UNION ALL")) return stmt;
      const all = stmt.all.bind(stmt);
      return Object.assign(stmt, { all: (...args: unknown[]) => ((page = { sql, args }), all(...args)) });
    });
    readConversation(db, OWNER_ACCOUNT, { ...identity, name: "alice" }, "bob");
    vi.restoreAllMocks();
    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${page!.sql}`).all(...page!.args) as { detail: string }[])
      .map((p) => p.detail)
      .join("\n");
    expect(plan.match(/SEARCH messages USING INDEX messages_by_sender \(recipient_id=\? AND sender=\?\)/g)).toHaveLength(2);
    expect(plan).not.toMatch(/SCAN (messages|agents)/);
  });
});
