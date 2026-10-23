import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addAccount } from "../src/accounts.js";
import { OWNER_ACCOUNT, openDb, type AccountId, type Db } from "../src/db.js";
import { MAX_SEARCH_LENGTH, unreadSummary } from "../src/messages.js";
import { Session, createServer } from "../src/server.js";

let dbFile: string;
let db: Db;
let friend: AccountId;
const clients: Client[] = [];

beforeEach(() => {
  dbFile = join(mkdtempSync(join(tmpdir(), "message-cp-search-")), "db.sqlite");
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

// A message and a post share no sequence, so search orders them by time: keep them apart where order matters.
const tick = () => new Promise((r) => setTimeout(r, 5));
const bodies = (results: { body: string }[]) => results.map((r) => r.body);

describe("search", () => {
  it("finds received messages and the account's posts by substring, newest first, saying what each is", async () => {
    const alice = await connect("alice");
    const bob = await connect("bob");
    await ok(alice, "send_message", { to: "bob", body: "the Deploy is done" });
    await tick();
    await ok(alice, "send_message", { to: "all", body: "deploy again tomorrow" });
    await tick();
    const posted = await ok(alice, "post", { channel: "ops", body: "DEPLOY log attached" });
    await tick();
    await ok(alice, "send_message", { to: "bob", body: "unrelated" });

    const found = await ok(bob, "search", { text: "deploy" });
    expect(found).toEqual([
      { kind: "post", channel: "ops", id: posted.id, from: "alice", sentAt: posted.sentAt, body: "DEPLOY log attached" },
      { kind: "message", id: expect.any(Number), inReplyTo: null, from: "alice", sentAt: expect.any(String), body: "deploy again tomorrow", broadcast: true },
      { kind: "message", id: expect.any(Number), inReplyTo: null, from: "alice", sentAt: expect.any(String), body: "the Deploy is done", broadcast: false },
    ]);
    // The sender searches what it received, not what it sent; posts are anyone's in the account.
    expect(bodies(await ok(alice, "search", { text: "deploy" }))).toEqual(["DEPLOY log attached"]);
  });

  it("matches %, _ and \\ literally", async () => {
    const alice = await connect("alice");
    const bob = await connect("bob");
    for (const body of ["100% sure", "100 sure", "a_b", "axb", "c:\\tmp", "c:tmp"]) {
      await ok(alice, "send_message", { to: "bob", body });
    }
    expect(bodies(await ok(bob, "search", { text: "0%" }))).toEqual(["100% sure"]);
    expect(bodies(await ok(bob, "search", { text: "a_b" }))).toEqual(["a_b"]);
    expect(bodies(await ok(bob, "search", { text: ":\\t" }))).toEqual(["c:\\tmp"]);
  });

  it("needs 1 to 200 characters of text, a valid channel name and valid dates", async () => {
    const bob = await connect("bob");
    for (const args of [
      { text: "" },
      { text: "x".repeat(MAX_SEARCH_LENGTH + 1) },
      { text: "x", channel: "no spaces" },
      { text: "x", channel: "" },
      { text: "x", since: "yesterday" },
      { text: "x", until: "2026-02-30" },
      { text: "x", since: "2026-13-01" },
      { text: "x", until: "2026-10-20T25:00:00Z" },
      { text: "x", since: "20261020" },
      { text: "x", since: "0001-02-29" },
    ]) {
      const r = await call(bob, "search", args);
      expect(r.isError, JSON.stringify(args)).toBe(true);
    }
    expect(await ok(bob, "search", { text: "😀".repeat(MAX_SEARCH_LENGTH) })).toEqual([]);
    expect(await ok(bob, "search", { text: "x", since: "2026-10-20", until: "2026-10-20T12:00:00.5+02:00" })).toEqual([]);
    expect(await ok(bob, "search", { text: "x", since: "0000-02-29" })).toEqual([]);
  });

  it("requires register first", async () => {
    const r = await call(await connect(), "search", { text: "x" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Call `register` first");
  });

  it("filters by channel (posts only), sender in any case and time range", async () => {
    const alice = await connect("alice");
    const carol = await connect("carol");
    const bob = await connect("bob");
    await ok(alice, "send_message", { to: "bob", body: "note one" });
    await ok(alice, "post", { channel: "ops", body: "note two" });
    await ok(carol, "post", { channel: "Dev", body: "note three" });
    await ok(carol, "send_message", { to: "bob", body: "note four" });

    expect(bodies(await ok(bob, "search", { text: "note", channel: "OPS" }))).toEqual(["note two"]);
    expect((await ok(bob, "search", { text: "note", channel: "dev" }))[0].channel).toBe("Dev");
    expect(await ok(bob, "search", { text: "note", channel: "nothere" })).toEqual([]);
    expect(bodies(await ok(bob, "search", { text: "note", from: "ALICE" })).sort()).toEqual(["note one", "note two"]);
    expect(bodies(await ok(bob, "search", { text: "note", from: "alice", channel: "ops" }))).toEqual(["note two"]);
    expect(await ok(bob, "search", { text: "note", from: "carol", channel: "ops" })).toEqual([]);

    db.prepare("UPDATE messages SET created_at = ? WHERE body = 'note one'").run(Date.parse("2026-01-01T00:00:00Z"));
    db.prepare("UPDATE channel_posts SET created_at = ? WHERE body = 'note two'").run(Date.parse("2026-02-01T00:00:00Z"));
    expect(bodies(await ok(bob, "search", { text: "note", until: "2026-02-01" }))).toEqual(["note one"]);
    // An offset moves the bound: 01:00+01:00 is midnight UTC, and a time with no offset is UTC.
    expect(bodies(await ok(bob, "search", { text: "note", until: "2026-02-01T01:00:00+01:00" }))).toEqual(["note one"]);
    expect(bodies(await ok(bob, "search", { text: "note", until: "2026-02-01T00:00:00.001" })).sort()).toEqual(["note one", "note two"]);
    expect(bodies(await ok(bob, "search", { text: "note", since: "2026-01-01T00:00:00Z", until: "2026-03-01" }))).toEqual([
      "note two",
      "note one",
    ]);
    expect(bodies(await ok(bob, "search", { text: "note", since: "2026-01-01T00:00:00.001Z", until: "2026-03-01" }))).toEqual([
      "note two",
    ]);
  });

  it("pages with limit and offset, 50 by default", async () => {
    const alice = await connect("alice");
    const bob = await connect("bob");
    for (let i = 0; i < 55; i++) await ok(alice, "send_message", { to: "bob", body: `m${i}` });
    expect((await ok(bob, "search", { text: "m" })).length).toBe(50);
    expect(bodies(await ok(bob, "search", { text: "m", limit: 2 }))).toEqual(["m54", "m53"]);
    expect(bodies(await ok(bob, "search", { text: "m", limit: 2, offset: 53 }))).toEqual(["m1", "m0"]);
    expect((await call(bob, "search", { text: "m", limit: 201 })).isError).toBe(true);
  });

  it("marks nothing read and moves no channel read position", async () => {
    const alice = await connect("alice");
    const bob = await connect("bob");
    await ok(bob, "join_channel", { channel: "ops" });
    await ok(alice, "send_message", { to: "bob", body: "hello" });
    await ok(alice, "post", { channel: "ops", body: "hello @bob" });
    const before = unreadSummary(db, OWNER_ACCOUNT, "bob");
    expect((await ok(bob, "search", { text: "hello" })).length).toBe(2);
    expect(unreadSummary(db, OWNER_ACCOUNT, "bob")).toEqual(before);
    expect(before).toMatchObject({ count: 1, posts: 1, mentions: 1 });
    expect((await ok(bob, "read_inbox")).length).toBe(2);
    expect((await ok(bob, "read_channel", { channel: "ops" })).posts.length).toBe(1);
  });

  it("never finds another account's messages or posts, even under the same names", async () => {
    const alice = await connect("alice");
    const bob = await connect("bob");
    const fAlice = await connect("alice", friend);
    const fBob = await connect("bob", friend);
    await ok(fAlice, "send_message", { to: "bob", body: "secret one" });
    await ok(fAlice, "post", { channel: "ops", body: "secret two" });
    await ok(alice, "send_message", { to: "bob", body: "secret mine" });
    await tick();
    await ok(alice, "post", { channel: "ops", body: "secret post" });

    expect(bodies(await ok(bob, "search", { text: "secret" }))).toEqual(["secret post", "secret mine"]);
    expect(bodies(await ok(bob, "search", { text: "secret", channel: "ops" }))).toEqual(["secret post"]);
    expect(bodies(await ok(alice, "search", { text: "secret", from: "alice" }))).toEqual(["secret post"]);
    expect(bodies(await ok(fBob, "search", { text: "secret" })).sort()).toEqual(["secret one", "secret two"]);
    expect(bodies(await ok(fBob, "search", { text: "secret", channel: "ops" }))).toEqual(["secret two"]);
  });

  it("does not give a later agent with a removed agent's name the removed agent's messages", async () => {
    const alice = await connect("alice");
    const bob = await connect("bob");
    await ok(alice, "send_message", { to: "bob", body: "for the first bob" });
    await ok(bob, "unregister");
    const bob2 = await connect("bob");
    await ok(alice, "send_message", { to: "bob", body: "for the second bob" });
    expect(bodies(await ok(bob2, "search", { text: "bob" }))).toEqual(["for the second bob"]);
    // The removed registration's session is unregistered, so it cannot search either.
    expect((await call(bob, "search", { text: "bob" })).isError).toBe(true);
  });
});
