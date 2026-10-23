import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addAccount } from "../src/accounts.js";
import { addPerson } from "../src/agents.js";
import { OWNER_ACCOUNT, openDb, type AccountId, type Db } from "../src/db.js";
import { MAX_INBOX_LIMIT, MESSAGE_STATUS_SQL, NOT_YOUR_MESSAGES } from "../src/messages.js";
import { Session, createServer } from "../src/server.js";

// The message ids `send_message` returns, and `message_status`, which says whether each was read.
let dbFile: string;
let db: Db;
let friend: AccountId;
const clients: Client[] = [];

beforeEach(() => {
  dbFile = join(mkdtempSync(join(tmpdir(), "message-cp-status-")), "db.sqlite");
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

const idOf = (body: string) => (db.prepare("SELECT id FROM messages WHERE body = ?").get(body) as { id: number }).id;
const readAtOf = (id: number) => (db.prepare("SELECT read_at FROM messages WHERE id = ?").get(id) as { read_at: number }).read_at;

/** Expects `message_status` to fail with the one refusal. */
async function refused(client: Client, ids: number[]) {
  const r = await call(client, "message_status", { ids });
  expect(r.isError).toBe(true);
  expect(r.text).toBe(NOT_YOUR_MESSAGES);
}

describe("send_message", () => {
  it("returns the id of the message it stored, with its recipient", async () => {
    const alice = await connect("alice");
    await connect("bob");
    expect(await ok(alice, "send_message", { to: "BOB", body: "hello" })).toEqual({
      delivered: 1,
      recipients: ["bob"],
      messages: [{ id: idOf("hello"), to: "bob" }],
    });
  });

  it("returns one id per recipient of a broadcast", async () => {
    const alice = await connect("alice");
    await connect("bob");
    await connect("carol");
    const sent = await ok(alice, "send_message", { to: "all", body: "hi all" });
    const rows = db.prepare("SELECT m.id, a.name AS \"to\" FROM messages m JOIN agents a ON a.id = m.recipient_id ORDER BY a.name").all();
    expect(sent).toEqual({ delivered: 2, recipients: ["bob", "carol"], messages: rows });
    expect(new Set(sent.messages.map((m: { id: number }) => m.id)).size).toBe(2);
  });
});

describe("message_status", () => {
  it("says a message is unread, then read with when, once its recipient's read_inbox returned it", async () => {
    const alice = await connect("alice");
    const bob = await connect("bob");
    const [{ id }] = (await ok(alice, "send_message", { to: "bob", body: "ping" })).messages;
    expect(await ok(alice, "message_status", { ids: [id] })).toEqual([{ id, to: "bob", read: false, readAt: null }]);
    expect((await ok(bob, "read_inbox")).map((m: { id: number }) => m.id)).toEqual([id]);
    expect(await ok(alice, "message_status", { ids: [id] })).toEqual([
      { id, to: "bob", read: true, readAt: new Date(readAtOf(id)).toISOString() },
    ]);
  });

  it("answers each id once, in the order given, for every copy of a broadcast", async () => {
    const alice = await connect("alice");
    const bob = await connect("bob");
    await connect("carol");
    const [toBob, toCarol] = (await ok(alice, "send_message", { to: "all", body: "hi all" })).messages;
    await ok(bob, "read_inbox");
    expect(await ok(alice, "message_status", { ids: [toCarol.id, toBob.id, toCarol.id] })).toEqual([
      { id: toCarol.id, to: "carol", read: false, readAt: null },
      { id: toBob.id, to: "bob", read: true, readAt: expect.any(String) },
    ]);
  });

  it("reads and marks nothing", async () => {
    const alice = await connect("alice");
    const bob = await connect("bob");
    const [{ id }] = (await ok(alice, "send_message", { to: "bob", body: "still unread" })).messages;
    await ok(alice, "message_status", { ids: [id] });
    expect((await ok(bob, "read_inbox")).map((m: { body: string }) => m.body)).toEqual(["still unread"]);
  });

  it("names a removed recipient by the name it had", async () => {
    const alice = await connect("alice");
    const bob = await connect("bob");
    const [{ id }] = (await ok(alice, "send_message", { to: "bob", body: "before you go" })).messages;
    await ok(bob, "read_inbox");
    await ok(bob, "unregister");
    expect(await ok(alice, "message_status", { ids: [id] })).toEqual([{ id, to: "bob", read: true, readAt: expect.any(String) }]);
  });

  it("keeps a message to a person unread, since a person has no read_inbox", async () => {
    addPerson(db, "owner", "colin");
    const alice = await connect("alice");
    const sent = await ok(alice, "send_message", { to: "all", body: "hi all" });
    expect(sent.messages).toEqual([{ id: expect.any(Number), to: "colin" }]);
    expect(await ok(alice, "message_status", { ids: [sent.messages[0].id] })).toEqual([
      { id: sent.messages[0].id, to: "colin", read: false, readAt: null },
    ]);
  });

  it("refuses, with the same error, any id the caller did not send", async () => {
    const alice = await connect("alice");
    const bob = await connect("bob");
    const carol = await connect("carol");
    const stranger = await connect("alice", friend);
    await connect("bob", friend);
    await ok(carol, "send_message", { to: "bob", body: "carol's" });
    await ok(stranger, "send_message", { to: "bob", body: "other account" });
    await ok(bob, "send_message", { to: "alice", body: "to alice" });
    const [{ id: own }] = (await ok(alice, "send_message", { to: "bob", body: "alice's" })).messages;

    await refused(alice, [idOf("carol's")]); // another agent's
    await refused(alice, [idOf("other account")]); // another account's, sent under the caller's name
    await refused(alice, [idOf("to alice")]); // sent to the caller, not by it
    await refused(alice, [999_999]); // unknown
    // One bad id fails the whole call, even beside the caller's own.
    await refused(alice, [own, idOf("carol's")]);
    // The caller's own works, so the refusals above are about the ids.
    expect(await ok(alice, "message_status", { ids: [own] })).toEqual([{ id: own, to: "bob", read: false, readAt: null }]);
  });

  it("refuses a message an earlier, removed agent with the caller's name sent", async () => {
    const first = await connect("alice");
    await connect("bob");
    const [{ id }] = (await ok(first, "send_message", { to: "bob", body: "from the first alice" })).messages;
    await ok(first, "unregister");
    const later = await connect("alice");
    await refused(later, [id]);
    // The first alice's session is no longer registered at all.
    expect((await call(first, "message_status", { ids: [id] })).text).toContain("Call `register` first");
  });

  it("needs register first", async () => {
    expect((await call(await connect(), "message_status", { ids: [1] })).text).toContain("Call `register` first");
  });

  it("takes 1 to MAX_INBOX_LIMIT positive integer ids", async () => {
    const alice = await connect("alice");
    for (const ids of [[], [0], [-1], [1.5], ["1"], Array.from({ length: MAX_INBOX_LIMIT + 1 }, (_, i) => i + 1)]) {
      const r = await call(alice, "message_status", { ids });
      expect(r.isError).toBe(true);
      expect(r.text).not.toBe(NOT_YOUR_MESSAGES);
    }
  });

  it("finds each message by its primary key, without scanning history", () => {
    const plan = (
      db
        .prepare(`EXPLAIN QUERY PLAN ${MESSAGE_STATUS_SQL}`)
        .all("[1]", OWNER_ACCOUNT, "alice", 0) as { detail: string }[]
    ).map((p) => p.detail);
    expect(plan.some((d) => /SEARCH m USING INTEGER PRIMARY KEY/.test(d))).toBe(true);
    expect(plan.some((d) => /SCAN m\b/.test(d))).toBe(false);
  });
});
