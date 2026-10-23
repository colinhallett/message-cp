import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addAccount } from "../src/accounts.js";
import { addPerson, purgeAgent, removePerson } from "../src/agents.js";
import { OWNER_ACCOUNT, openDb, type AccountId, type Db } from "../src/db.js";
import { deleteConversation, sendAsPerson } from "../src/messages.js";
import { Session, createServer } from "../src/server.js";

// `send_message` with `in_reply_to`, and the `id` and `inReplyTo` the reading tools return for each direct message.
let dbFile: string;
let db: Db;
let friend: AccountId;
const clients: Client[] = [];

beforeEach(() => {
  dbFile = join(mkdtempSync(join(tmpdir(), "message-cp-replies-")), "db.sqlite");
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

const messages = () => db.prepare("SELECT * FROM messages ORDER BY id").all();
const idOf = (body: string) => (db.prepare("SELECT id FROM messages WHERE body = ?").get(body) as { id: number }).id;

/** Expects `send_message` with `in_reply_to` to fail with the one refusal, storing nothing. */
async function refused(client: Client, to: string, inReplyTo: number) {
  const before = messages();
  const r = await call(client, "send_message", { to, body: "reply", in_reply_to: inReplyTo });
  expect(r.isError).toBe(true);
  expect(r.text).toContain(`No message ${inReplyTo} was sent to you.`);
  expect(messages()).toEqual(before);
}

describe("in_reply_to", () => {
  it("is stored on the reply and returned with each message's own id by read_inbox, read_conversation and search", async () => {
    const alice = await connect("alice");
    const bob = await connect("bob");
    await ok(alice, "send_message", { to: "bob", body: "question one" });
    await ok(alice, "send_message", { to: "bob", body: "question two" });
    const inbox = await ok(bob, "read_inbox");
    expect(inbox).toEqual([
      { id: idOf("question one"), inReplyTo: null, from: "alice", sentAt: expect.any(String), body: "question one", broadcast: false },
      { id: idOf("question two"), inReplyTo: null, from: "alice", sentAt: expect.any(String), body: "question two", broadcast: false },
    ]);

    // Answer the second first: the ids say which question each reply answers.
    expect(await ok(bob, "send_message", { to: "alice", body: "answer two", in_reply_to: inbox[1].id })).toEqual({
      delivered: 1,
      recipients: ["alice"],
    });
    await ok(bob, "send_message", { to: "alice", body: "answer one", in_reply_to: inbox[0].id });
    expect(await ok(alice, "read_inbox")).toEqual([
      { id: idOf("answer two"), inReplyTo: inbox[1].id, from: "bob", sentAt: expect.any(String), body: "answer two", broadcast: false },
      { id: idOf("answer one"), inReplyTo: inbox[0].id, from: "bob", sentAt: expect.any(String), body: "answer one", broadcast: false },
    ]);
    const conversation = await ok(alice, "read_conversation", { name: "bob" });
    expect(conversation.map((m: { body: string; inReplyTo: number | null }) => [m.body, m.inReplyTo])).toEqual([
      ["answer one", inbox[0].id],
      ["answer two", inbox[1].id],
      ["question two", null],
      ["question one", null],
    ]);
    expect(conversation.map((m: { id: number }) => m.id)).toEqual(["answer one", "answer two", "question two", "question one"].map(idOf));
    expect(await ok(alice, "search", { text: "answer two" })).toEqual([
      { kind: "message", id: idOf("answer two"), inReplyTo: inbox[1].id, from: "bob", sentAt: expect.any(String), body: "answer two", broadcast: false },
    ]);
  });

  it("is recorded on every copy of a broadcast reply", async () => {
    const alice = await connect("alice");
    const bob = await connect("bob");
    await connect("carol");
    await ok(alice, "send_message", { to: "bob", body: "anyone?" });
    const [question] = await ok(bob, "read_inbox");
    expect(await ok(bob, "send_message", { to: "all", body: "yes, all", in_reply_to: question.id })).toEqual({
      delivered: 2,
      recipients: ["alice", "carol"],
    });
    expect(db.prepare("SELECT in_reply_to FROM messages WHERE body = 'yes, all'").pluck().all()).toEqual([question.id, question.id]);
  });

  it("refuses, storing nothing, an id that is not a message sent to the caller", async () => {
    const alice = await connect("alice");
    const bob = await connect("bob");
    await connect("carol");
    const stranger = await connect("alice", friend);
    await ok(alice, "send_message", { to: "bob", body: "to bob" });
    await ok(alice, "send_message", { to: "carol", body: "to carol" });
    await ok(stranger, "send_message", { to: "alice", body: "other account" });
    // Posts have ids of their own; the fourth is past every message's, so it can only be taken as a post's.
    for (const body of ["one", "two", "three"]) await ok(alice, "post", { channel: "ops", body });
    const post = await ok(alice, "post", { channel: "ops", body: "@bob a post" });
    expect((await ok(bob, "read_inbox")).map((m: { id: number }) => m.id)).toEqual([idOf("to bob"), post.id]);

    await refused(bob, "alice", 999); // unknown
    await refused(alice, "bob", idOf("other account") + 1000); // past the end
    await refused(bob, "alice", idOf("to carol")); // sent to another agent
    await refused(alice, "bob", idOf("to bob")); // sent by the caller
    await refused(alice, "alice", idOf("other account")); // another account's, to an agent with the caller's name
    await refused(bob, "alice", post.id); // a mention's, the post's id
    // The same refusal whether or not the id exists.
    const unknown = await call(bob, "send_message", { to: "alice", body: "x", in_reply_to: 999 });
    const other = await call(bob, "send_message", { to: "alice", body: "x", in_reply_to: idOf("to carol") });
    expect(unknown.text.replace("999", "N")).toBe(other.text.replace(String(idOf("to carol")), "N"));
    // The caller's own mail works, so the refusals above are about the id.
    await ok(bob, "send_message", { to: "alice", body: "fine", in_reply_to: idOf("to bob") });
  });

  it("refuses a message sent to a removed agent that had the caller's name", async () => {
    const alice = await connect("alice");
    const bob = await connect("bob");
    await ok(alice, "send_message", { to: "bob", body: "to the first bob" });
    const first = idOf("to the first bob");
    await ok(bob, "unregister");
    const later = await connect("bob");
    await refused(later, "alice", first);
    // The first bob's session is no longer registered at all.
    expect((await call(bob, "send_message", { to: "alice", body: "x", in_reply_to: first })).isError).toBe(true);
  });

  it("is rejected by the tool when it is not a positive integer", async () => {
    const alice = await connect("alice");
    await connect("bob");
    for (const bad of [0, -1, 1.5, "1"]) {
      const before = messages();
      expect((await call(alice, "send_message", { to: "bob", body: "x", in_reply_to: bad })).isError).toBe(true);
      expect(messages()).toEqual(before);
    }
  });

  it("is null for a message a person sends", async () => {
    addPerson(db, "owner", "colin");
    const alice = await connect("alice");
    sendAsPerson(db, OWNER_ACCOUNT, "colin", "alice", "from colin");
    expect(await ok(alice, "read_inbox")).toEqual([expect.objectContaining({ body: "from colin", inReplyTo: null })]);
  });

  describe("when the message it names is deleted, the reply stays and answers nothing", () => {
    /** Bob and the person dana each ask alice something; alice passes each question on to carol, as a reply to it. */
    async function relayed() {
      addPerson(db, "owner", "dana");
      const alice = await connect("alice");
      const bob = await connect("bob");
      await connect("carol");
      await ok(bob, "send_message", { to: "alice", body: "q bob" });
      sendAsPerson(db, OWNER_ACCOUNT, "dana", "alice", "q dana");
      await ok(alice, "send_message", { to: "carol", body: "relay bob", in_reply_to: idOf("q bob") });
      await ok(alice, "send_message", { to: "carol", body: "relay dana", in_reply_to: idOf("q dana") });
    }
    const replyTo = (body: string) =>
      (db.prepare("SELECT in_reply_to FROM messages WHERE body = ?").get(body) as { in_reply_to: number | null }).in_reply_to;

    it("by DELETE /api/conversation", async () => {
      await relayed();
      const dana = idOf("q dana");
      expect(deleteConversation(db, OWNER_ACCOUNT, "alice", "bob")).toBe(1);
      expect(replyTo("relay bob")).toBeNull();
      expect(replyTo("relay dana")).toBe(dana);
    });

    it("by `message-cp agent remove`", async () => {
      await relayed();
      const dana = idOf("q dana");
      expect(purgeAgent(db, "owner", "bob")).toMatchObject({ messages: 1 });
      expect(replyTo("relay bob")).toBeNull();
      expect(replyTo("relay dana")).toBe(dana);
    });

    it("by `message-cp person remove`", async () => {
      await relayed();
      const bob = idOf("q bob");
      expect(removePerson(db, "owner", "dana")).toMatchObject({ messages: 1 });
      expect(replyTo("relay dana")).toBeNull();
      expect(replyTo("relay bob")).toBe(bob);
    });

    it("reads as inReplyTo: null in read_inbox, read_conversation and search", async () => {
      const alice = await connect("alice");
      const bob = await connect("bob");
      await ok(alice, "send_message", { to: "bob", body: "question" });
      await ok(bob, "send_message", { to: "alice", body: "answer", in_reply_to: idOf("question") });
      db.prepare("DELETE FROM messages WHERE body = 'question'").run();
      await ok(bob, "send_message", { to: "alice", body: "newer" });
      const answer = expect.objectContaining({ body: "answer", inReplyTo: null });
      expect(await ok(alice, "read_inbox")).toEqual([answer, expect.objectContaining({ body: "newer", inReplyTo: null })]);
      expect(await ok(alice, "read_conversation", { name: "bob" })).toEqual([expect.objectContaining({ body: "newer" }), answer]);
      expect(await ok(alice, "search", { text: "answer" })).toEqual([answer]);
    });
  });

  it("checks the caller and finds the replies to a deleted message through indexes, without scanning messages", () => {
    const plan = (sql: string) =>
      (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]).map((p) => p.detail).join("\n");
    expect(plan("DELETE FROM messages WHERE id = 1")).toMatch(/SEARCH messages USING COVERING INDEX messages_by_reply \(in_reply_to=\?\)/);
    const check = plan(
      `SELECT 1 FROM messages WHERE id = 1 AND recipient_id = (SELECT id FROM agents WHERE account_id = 1 AND id = 1
         AND registered_at = 1 AND instance IS 'x' AND removed_at IS NULL)`,
    );
    expect(check).toMatch(/SEARCH messages USING INTEGER PRIMARY KEY \(rowid=\?\)/);
    expect(check).toMatch(/SEARCH agents USING INTEGER PRIMARY KEY \(rowid=\?\)/);
    expect(check).not.toMatch(/SCAN/);
  });
});
