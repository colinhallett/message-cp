import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addAccount } from "../src/accounts.js";
import { identityOf, registerAgent, removeAgent } from "../src/agents.js";
import { listChannels, post, readChannel } from "../src/channels.js";
import { OWNER_ACCOUNT, openDb, type AccountId, type Db } from "../src/db.js";
import { MAX_BODY_LENGTH, unreadSummary } from "../src/messages.js";
import { Session, createServer } from "../src/server.js";

let dbFile: string;
let db: Db;
let friend: AccountId;
const clients: Client[] = [];

beforeEach(() => {
  dbFile = join(mkdtempSync(join(tmpdir(), "message-cp-channels-")), "db.sqlite");
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

/** A session of `account`, registered as `name` unless it is undefined (with `key` when taking an agent over). */
async function connect(name?: string, account: AccountId = OWNER_ACCOUNT, key?: string) {
  const server = createServer(openDb(dbFile), new Session(account));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  clients.push(client);
  let issued: string | undefined;
  if (name) {
    const r = await call(client, "register", { name, bio: "x", ...(key ? { key } : {}) });
    expect(r.isError).toBe(false);
    issued = r.json.key;
  }
  return { client, key: issued ?? key };
}

const ok = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
  const r = await call(client, name, args);
  expect(r.isError, r.text).toBe(false);
  return r.json;
};
const bodies = (page: { posts: { body: string }[] }) => page.posts.map((p) => p.body);
const unreadIn = async (client: Client, channel: string) =>
  ((await ok(client, "list_channels")) as { name: string; unread: number }[]).find((c) => c.name.toLowerCase() === channel.toLowerCase())
    ?.unread;

describe("post", () => {
  it("creates the channel on its first post, keeping the first spelling, and records sender and time", async () => {
    const { client } = await connect("alice");
    const first = await ok(client, "post", { channel: "Dev", body: "hello" });
    expect(first.channel).toBe("Dev");
    const second = await ok(client, "post", { channel: "dev", body: "again" });
    expect(second.channel).toBe("Dev");
    const page = await ok(client, "read_channel", { channel: "DEV", unread_only: false });
    expect(page.posts.map((p: { from: string; body: string }) => [p.from, p.body])).toEqual([
      ["alice", "hello"],
      ["alice", "again"],
    ]);
    expect(Date.parse(page.posts[0].sentAt)).not.toBeNaN();
  });

  it("requires register first", async () => {
    const { client } = await connect();
    for (const [tool, args] of [
      ["post", { channel: "dev", body: "hi" }],
      ["read_channel", { channel: "dev" }],
      ["list_channels", {}],
      ["join_channel", { channel: "dev" }],
      ["leave_channel", { channel: "dev" }],
    ] as const) {
      const r = await call(client, tool, args);
      expect(r.isError).toBe(true);
      expect(r.text).toContain("Call `register` first");
    }
  });

  it("checks the channel name and body like agent names and messages, with no meaning for 'all'", async () => {
    const { client } = await connect("alice");
    for (const channel of ["", "a b", "x".repeat(33), "dev!"]) {
      expect((await call(client, "post", { channel, body: "hi" })).text).toContain("Invalid channel name");
    }
    expect((await call(client, "post", { channel: "dev", body: "  \n" })).text).toContain("empty");
    expect((await call(client, "post", { channel: "dev", body: "x".repeat(MAX_BODY_LENGTH + 1) })).text).toContain("too long");
    expect((await call(client, "post", { channel: "dev", body: "😀".repeat(MAX_BODY_LENGTH) })).isError).toBe(false);
    await ok(client, "post", { channel: "all", body: "just a channel" });
    const { client: bob } = await connect("bob");
    expect(await unreadIn(bob, "all")).toBe(1);
    expect((await ok(bob, "read_inbox")).length).toBe(0);
  });

  it("does not write to anyone's inbox", async () => {
    const { client } = await connect("alice");
    await connect("bob");
    await ok(client, "post", { channel: "dev", body: "hi" });
    expect((db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n).toBe(0);
  });
});

describe("read_channel", () => {
  it("gives an agent that registers later the whole history, then only what is new", async () => {
    const { client: alice } = await connect("alice");
    await ok(alice, "post", { channel: "dev", body: "one" });
    await ok(alice, "post", { channel: "dev", body: "two" });
    const { client: carol } = await connect("carol");
    expect(bodies(await ok(carol, "read_channel", { channel: "dev" }))).toEqual(["one", "two"]);
    expect(bodies(await ok(carol, "read_channel", { channel: "dev" }))).toEqual([]);
    await ok(alice, "post", { channel: "dev", body: "three" });
    expect(bodies(await ok(carol, "read_channel", { channel: "dev" }))).toEqual(["three"]);
  });

  it("pages unread posts and moves the read position only past what it returned", async () => {
    const { client: alice } = await connect("alice");
    for (const n of [1, 2, 3, 4, 5]) await ok(alice, "post", { channel: "dev", body: `p${n}` });
    const { client: bob } = await connect("bob");
    expect(bodies(await ok(bob, "read_channel", { channel: "dev", limit: 2 }))).toEqual(["p1", "p2"]);
    expect(await unreadIn(bob, "dev")).toBe(3);
    expect(bodies(await ok(bob, "read_channel", { channel: "dev", limit: 2 }))).toEqual(["p3", "p4"]);
    expect(bodies(await ok(bob, "read_channel", { channel: "dev", limit: 2 }))).toEqual(["p5"]);
  });

  it("pages through history with offset without moving the read position", async () => {
    const { client: alice } = await connect("alice");
    for (const n of [1, 2, 3]) await ok(alice, "post", { channel: "dev", body: `p${n}` });
    const { client: bob } = await connect("bob");
    expect(bodies(await ok(bob, "read_channel", { channel: "dev", unread_only: false, limit: 2, offset: 1 }))).toEqual(["p2", "p3"]);
    expect(await unreadIn(bob, "dev")).toBe(3);
    expect((await call(bob, "read_channel", { channel: "dev", offset: 1 })).text).toContain("unread_only false");
    expect((await call(bob, "read_channel", { channel: "dev", offset: 0 })).text).toContain("unread_only false");
  });

  it("names a channel that does not exist", async () => {
    const { client } = await connect("alice");
    const r = await call(client, "read_channel", { channel: "nowhere" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("No channel named 'nowhere'");
  });

  it("keeps a read position per agent", async () => {
    const { client: alice } = await connect("alice");
    const { client: bob } = await connect("bob");
    const { client: carol } = await connect("carol");
    await ok(alice, "post", { channel: "dev", body: "hi" });
    await ok(bob, "read_channel", { channel: "dev" });
    expect(await unreadIn(bob, "dev")).toBe(0);
    expect(await unreadIn(carol, "dev")).toBe(1);
  });

  it("gives a new agent with a removed agent's name a fresh read position, and a takeover with the key the same one", async () => {
    const { client: alice } = await connect("alice");
    await ok(alice, "post", { channel: "dev", body: "one" });
    const bob = await connect("bob");
    await ok(bob.client, "read_channel", { channel: "dev" });
    // Another session that takes bob over with his key is bob.
    const again = await connect("bob", OWNER_ACCOUNT, bob.key);
    expect(await unreadIn(again.client, "dev")).toBe(0);
    await ok(again.client, "unregister");
    const newBob = await connect("bob");
    expect(await unreadIn(newBob.client, "dev")).toBe(1);
    expect(bodies(await ok(newBob.client, "read_channel", { channel: "dev" }))).toEqual(["one"]);
  });
});

describe("own posts", () => {
  it("are never unread for their poster, and posting when caught up keeps the channel read", async () => {
    const { client: alice } = await connect("alice");
    const { client: bob } = await connect("bob");
    await ok(alice, "post", { channel: "dev", body: "a1" });
    expect(await unreadIn(alice, "dev")).toBe(0);
    expect(bodies(await ok(alice, "read_channel", { channel: "dev" }))).toEqual([]);
    await ok(bob, "post", { channel: "dev", body: "b1" });
    expect(await unreadIn(alice, "dev")).toBe(1);
    // Alice has not read b1, so her post does not move her past it; it still never counts as unread.
    await ok(alice, "post", { channel: "dev", body: "a2" });
    expect(await unreadIn(alice, "dev")).toBe(1);
    expect(bodies(await ok(alice, "read_channel", { channel: "dev" }))).toEqual(["b1", "a2"]);
    expect(await unreadIn(alice, "dev")).toBe(0);
  });

  it("of an earlier agent with the same name are unread for a new one", async () => {
    const { client: alice } = await connect("alice");
    await ok(alice, "post", { channel: "dev", body: "old" });
    await ok(alice, "unregister");
    const { client: newAlice } = await connect("alice");
    expect(await unreadIn(newAlice, "dev")).toBe(1);
  });
});

describe("list_channels", () => {
  it("lists channels by name with post count, last post time and unread count, one page at a time", async () => {
    const { client: alice } = await connect("alice");
    const { client: bob } = await connect("bob");
    await ok(alice, "post", { channel: "zeta", body: "z" });
    await ok(alice, "post", { channel: "alpha", body: "a1" });
    const last = await ok(alice, "post", { channel: "alpha", body: "a2" });
    const list = await ok(bob, "list_channels");
    expect(list).toEqual([
      { name: "alpha", posts: 2, lastPostAt: last.sentAt, unread: 2, joined: false },
      { name: "zeta", posts: 1, lastPostAt: expect.any(String), unread: 1, joined: false },
    ]);
    expect((await ok(bob, "list_channels", { limit: 1, offset: 1 })).map((c: { name: string }) => c.name)).toEqual(["zeta"]);
  });
});

describe("join_channel and leave_channel", () => {
  const joined = async (client: Client) =>
    ((await ok(client, "list_channels")) as { name: string; joined: boolean }[]).filter((c) => c.joined).map((c) => c.name);
  const summary = (name: string, account: AccountId = OWNER_ACCOUNT) => unreadSummary(db, account, name);

  it("joins at the latest post a channel never read, so its history is not unread for waking but can still be paged", async () => {
    const { client: alice } = await connect("alice");
    await ok(alice, "post", { channel: "dev", body: "old1" });
    await ok(alice, "post", { channel: "dev", body: "old2" });
    const { client: bob } = await connect("bob");
    expect(await ok(bob, "join_channel", { channel: "DEV" })).toEqual({ channel: "dev", joined: true });
    expect(await joined(bob)).toEqual(["dev"]);
    expect(summary("bob")).toMatchObject({ posts: 0, channels: [] });
    expect(bodies(await ok(bob, "read_channel", { channel: "dev" }))).toEqual([]);
    expect(bodies(await ok(bob, "read_channel", { channel: "dev", unread_only: false }))).toEqual(["old1", "old2"]);
    await ok(alice, "post", { channel: "dev", body: "new" });
    expect(summary("bob")).toMatchObject({ posts: 1, channels: ["dev"] });
    expect(bodies(await ok(bob, "read_channel", { channel: "dev" }))).toEqual(["new"]);
    expect(summary("bob")).toMatchObject({ posts: 0, channels: [] });
  });

  it("re-joining keeps the read position, and leaving never moves it", async () => {
    const { client: alice } = await connect("alice");
    const { client: bob } = await connect("bob");
    await ok(alice, "post", { channel: "dev", body: "one" });
    await ok(bob, "read_channel", { channel: "dev" });
    await ok(alice, "post", { channel: "dev", body: "two" });
    expect(await ok(bob, "leave_channel", { channel: "dev" })).toEqual({ channel: "dev", joined: false });
    expect(await unreadIn(bob, "dev")).toBe(1);
    await ok(alice, "post", { channel: "dev", body: "three" });
    await ok(bob, "join_channel", { channel: "dev" });
    expect(await unreadIn(bob, "dev")).toBe(2);
    expect(summary("bob")).toMatchObject({ posts: 2, channels: ["dev"] });
    await ok(bob, "join_channel", { channel: "dev" });
    expect(bodies(await ok(bob, "read_channel", { channel: "dev" }))).toEqual(["two", "three"]);
  });

  it("only a joined channel wakes: posting does not join, leaving stops it, and own posts never count", async () => {
    const { client: alice } = await connect("alice");
    const { client: bob } = await connect("bob");
    await ok(alice, "post", { channel: "dev", body: "a1" });
    await ok(bob, "post", { channel: "dev", body: "b1" });
    expect(await joined(alice)).toEqual([]);
    expect(await joined(bob)).toEqual([]);
    expect(summary("alice")).toMatchObject({ posts: 0 });
    // Her first post gave alice a read position at a1, so joining keeps it and b1 is unread.
    await ok(alice, "join_channel", { channel: "dev" });
    expect(summary("alice")).toMatchObject({ posts: 1, channels: ["dev"] });
    await ok(alice, "read_channel", { channel: "dev" });
    await ok(alice, "post", { channel: "dev", body: "a2" });
    expect(summary("alice")).toMatchObject({ posts: 0 });
    await ok(bob, "post", { channel: "dev", body: "b2" });
    expect(summary("alice")).toMatchObject({ posts: 1, channels: ["dev"] });
    expect(summary("bob")).toMatchObject({ posts: 0 });
    await ok(alice, "leave_channel", { channel: "dev" });
    expect(summary("alice")).toMatchObject({ posts: 0, channels: [] });
  });

  it("creates a channel nobody has posted to, whose first post is then unread", async () => {
    const { client: alice } = await connect("alice");
    const { client: bob } = await connect("bob");
    expect(await ok(bob, "join_channel", { channel: "deploys" })).toEqual({ channel: "deploys", joined: true });
    expect(await ok(alice, "list_channels")).toEqual([{ name: "deploys", posts: 0, lastPostAt: null, unread: 0, joined: false }]);
    await ok(alice, "post", { channel: "DEPLOYS", body: "first" });
    expect(summary("bob")).toMatchObject({ posts: 1, channels: ["deploys"] });
  });

  it("checks the channel name, and leave names a channel that does not exist", async () => {
    const { client } = await connect("alice");
    expect((await call(client, "join_channel", { channel: "a b" })).text).toContain("Invalid channel name");
    expect((await call(client, "leave_channel", { channel: "nowhere" })).text).toContain("No channel named 'nowhere'");
    await ok(client, "post", { channel: "dev", body: "hi" });
    expect(await ok(client, "leave_channel", { channel: "dev" })).toEqual({ channel: "dev", joined: false });
  });

  it("belongs to the registration: a new agent with a removed agent's name has joined nothing", async () => {
    const { client: alice } = await connect("alice");
    const bob = await connect("bob");
    await ok(bob.client, "join_channel", { channel: "dev" });
    const again = await connect("bob", OWNER_ACCOUNT, bob.key);
    expect(await joined(again.client)).toEqual(["dev"]);
    await ok(again.client, "unregister");
    const { client: newBob } = await connect("bob");
    await ok(alice, "post", { channel: "dev", body: "hi" });
    expect(await joined(newBob)).toEqual([]);
    expect(summary("bob")).toMatchObject({ posts: 0 });
  });
});

describe("two accounts", () => {
  it("join_channel: joining a name another account uses neither wakes on nor changes that account's channel", async () => {
    const { client: owner } = await connect("alice");
    const { client: theirs } = await connect("alice", friend);
    const { client: theirBob } = await connect("bob", friend);
    await ok(theirs, "post", { channel: "dev", body: "friend before" });
    await ok(owner, "join_channel", { channel: "dev" });
    await ok(theirs, "post", { channel: "dev", body: "friend after" });
    expect(unreadSummary(db, OWNER_ACCOUNT, "alice")).toMatchObject({ posts: 0, channels: [] });
    expect(bodies(await ok(owner, "read_channel", { channel: "dev", unread_only: false }))).toEqual([]);
    await ok(theirBob, "join_channel", { channel: "dev" });
    await ok(owner, "post", { channel: "dev", body: "owner post" });
    expect(unreadSummary(db, friend, "bob")).toMatchObject({ posts: 0, channels: [] });
    expect(await unreadIn(theirBob, "dev")).toBe(0);
    await ok(theirs, "post", { channel: "dev", body: "friend again" });
    expect(unreadSummary(db, friend, "bob")).toMatchObject({ posts: 1, channels: ["dev"] });
  });

  it("post: the same channel name in another account is a separate channel", async () => {
    const { client: owner } = await connect("alice");
    const { client: theirs } = await connect("alice", friend);
    const mine = await ok(owner, "post", { channel: "dev", body: "owner post" });
    const other = await ok(theirs, "post", { channel: "DEV", body: "friend post" });
    expect(other.channel).toBe("DEV");
    expect(mine.channel).toBe("dev");
    expect(bodies(await ok(owner, "read_channel", { channel: "dev", unread_only: false }))).toEqual(["owner post"]);
    expect(bodies(await ok(theirs, "read_channel", { channel: "dev", unread_only: false }))).toEqual(["friend post"]);
  });

  it("read_channel: another account's channel does not exist, and reading it changes nothing there", async () => {
    const { client: owner } = await connect("alice");
    const { client: bob } = await connect("bob");
    const { client: theirs } = await connect("alice", friend);
    await ok(owner, "post", { channel: "secret", body: "owner only" });
    const r = await call(theirs, "read_channel", { channel: "secret", unread_only: false });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("No channel named 'secret'");
    expect((await call(theirs, "read_channel", { channel: "secret" })).isError).toBe(true);
    expect(await unreadIn(bob, "secret")).toBe(1);
  });

  it("list_channels: lists and counts only the caller's account", async () => {
    const { client: owner } = await connect("alice");
    const { client: theirs } = await connect("bob", friend);
    await ok(owner, "post", { channel: "dev", body: "o1" });
    await ok(owner, "post", { channel: "ops", body: "o2" });
    await ok(theirs, "post", { channel: "dev", body: "f1" });
    expect(await ok(theirs, "list_channels")).toEqual([{ name: "dev", posts: 1, lastPostAt: expect.any(String), unread: 0, joined: false }]);
    expect((await ok(owner, "list_channels")).map((c: { name: string; posts: number }) => [c.name, c.posts])).toEqual([
      ["dev", 1],
      ["ops", 1],
    ]);
  });
});

describe("a registration removed by another process", () => {
  it("can no longer post, read or list once its row is removed after the session last checked", () => {
    registerAgent(db, OWNER_ACCOUNT, "alice", "x");
    const alice = { ...identityOf(db, OWNER_ACCOUNT, "alice")!, name: "alice" };
    post(db, OWNER_ACCOUNT, alice, "dev", "before");
    removeAgent(db, OWNER_ACCOUNT, "alice", undefined, alice);
    expect(() => post(db, OWNER_ACCOUNT, alice, "dev", "after")).toThrow("not registered");
    expect(() => readChannel(db, OWNER_ACCOUNT, alice, "dev")).toThrow("not registered");
    expect(() => readChannel(db, OWNER_ACCOUNT, alice, "dev", false)).toThrow("not registered");
    expect(() => listChannels(db, OWNER_ACCOUNT, alice)).toThrow("not registered");
    expect((db.prepare("SELECT COUNT(*) AS n FROM channel_posts").get() as { n: number }).n).toBe(1);
  });
});

describe("the database", () => {
  it("keeps channels, posts and read positions when opened again", async () => {
    const { client: alice } = await connect("alice");
    const { client: bob } = await connect("bob");
    await ok(alice, "post", { channel: "dev", body: "kept" });
    await ok(bob, "read_channel", { channel: "dev" });
    openDb(dbFile).close();
    expect(bodies(await ok(bob, "read_channel", { channel: "dev", unread_only: false }))).toEqual(["kept"]);
    expect(await unreadIn(bob, "dev")).toBe(0);
  });
});
