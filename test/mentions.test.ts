import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addAccount } from "../src/accounts.js";
import { mentionedNames } from "../src/channels.js";
import { OWNER_ACCOUNT, openDb, type AccountId, type Db } from "../src/db.js";
import { startHttp, type HttpServer } from "../src/http.js";
import { unreadSummary } from "../src/messages.js";
import { Session, createServer } from "../src/server.js";
import { formatUnread } from "../src/wait.js";

const root = join(import.meta.dirname, "..");
const tsx = join(root, "node_modules", ".bin", "tsx");

let dbFile: string;
let db: Db;
let friend: AccountId;
const clients: Client[] = [];

beforeEach(() => {
  dbFile = join(mkdtempSync(join(tmpdir(), "message-cp-mentions-")), "db.sqlite");
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

/** A session of `account` registered as `name`. */
async function connect(name: string, account: AccountId = OWNER_ACCOUNT) {
  const server = createServer(openDb(dbFile), new Session(account));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  clients.push(client);
  await ok(client, "register", { name, bio: "x" });
  return client;
}

// A message and a post share no sequence, so read_inbox orders them by time: keep them apart in tests that check order.
const tick = () => new Promise((r) => setTimeout(r, 5));
const summary = (name: string, account: AccountId = OWNER_ACCOUNT) => unreadSummary(db, account, name)!;
const mentionCount = () => (db.prepare("SELECT COUNT(*) AS n FROM mentions").get() as { n: number }).n;

describe("mentionedNames", () => {
  it("finds each distinct @name once, in any case, but not @all, inside a word or cut from a longer name", () => {
    expect(mentionedNames("@bob and @Bob, (@carol) @dave-2: hi")).toEqual(["bob", "carol", "dave-2"]);
    expect(mentionedNames("@all @ALL a@bob bob@ x@y.z @")).toEqual([]);
    expect(mentionedNames(`@${"a".repeat(33)}`)).toEqual([]);
  });
});

describe("post with @mentions", () => {
  it("records one mention per distinct live agent of the account named, whether or not it has joined", async () => {
    const alice = await connect("alice");
    await connect("Bob");
    await connect("carol");
    const posted = await ok(alice, "post", { channel: "dev", body: "@bob @BOB @carol @nobody @all @alice look" });
    expect(
      db.prepare("SELECT a.name, m.post_id FROM mentions m JOIN agents a ON a.id = m.agent_id ORDER BY a.name").all(),
    ).toEqual([
      { name: "Bob", post_id: posted.id },
      { name: "carol", post_id: posted.id },
    ]);
  });

  it("never records a mention for an agent of another account with the same name", async () => {
    const alice = await connect("alice");
    await connect("bob", friend);
    await ok(alice, "post", { channel: "dev", body: "@bob are you there" });
    expect(mentionCount()).toBe(0);
    expect(summary("bob", friend)).toMatchObject({ mentions: 0, mentionChannels: [] });
    expect(await ok(clients[1], "read_inbox")).toEqual([]);
  });

  it("belongs to the registration: a new agent with a removed agent's name does not get its mentions", async () => {
    const alice = await connect("alice");
    const bob = await connect("bob");
    await ok(alice, "post", { channel: "dev", body: "@bob first" });
    await ok(bob, "unregister");
    const newBob = await connect("bob");
    expect(summary("bob")).toMatchObject({ mentions: 0 });
    expect(await ok(newBob, "read_inbox", { unread_only: false })).toEqual([]);
  });
});

describe("read_inbox with mentions", () => {
  it("returns unread mentions alongside messages, oldest first, marks them read and leaves the channel unread", async () => {
    const alice = await connect("alice");
    const bob = await connect("bob");
    await ok(bob, "join_channel", { channel: "dev" });
    await ok(alice, "send_message", { to: "bob", body: "direct one" });
    await tick();
    const posted = await ok(alice, "post", { channel: "DEV", body: "hey @bob" });
    await tick();
    await ok(alice, "send_message", { to: "all", body: "to everyone" });
    const inbox = await ok(bob, "read_inbox");
    expect(inbox).toEqual([
      { from: "alice", sentAt: expect.any(String), body: "direct one", broadcast: false },
      { channel: "dev", id: posted.id, from: "alice", sentAt: posted.sentAt, body: "hey @bob" },
      { from: "alice", sentAt: expect.any(String), body: "to everyone", broadcast: true },
    ]);
    expect(Object.keys(inbox[0]).sort()).toEqual(["body", "broadcast", "from", "sentAt"]);
    expect(await ok(bob, "read_inbox")).toEqual([]);
    expect(summary("bob")).toMatchObject({ count: 0, mentions: 0, posts: 1, channels: ["dev"] });
  });

  it("shares the limit between messages and mentions, and pages through both with offset when unread_only is false", async () => {
    const alice = await connect("alice");
    const bob = await connect("bob");
    await ok(alice, "send_message", { to: "bob", body: "m1" });
    await tick();
    await ok(alice, "post", { channel: "dev", body: "@bob p1" });
    await tick();
    await ok(alice, "send_message", { to: "bob", body: "m2" });
    await tick();
    await ok(alice, "post", { channel: "ops", body: "@bob p2" });
    const body = (items: { body: string }[]) => items.map((i) => i.body);
    expect(body(await ok(bob, "read_inbox", { limit: 3 }))).toEqual(["m1", "@bob p1", "m2"]);
    expect(summary("bob")).toMatchObject({ count: 0, mentions: 1, mentionChannels: ["ops"] });
    expect(body(await ok(bob, "read_inbox", { limit: 3 }))).toEqual(["@bob p2"]);
    expect(body(await ok(bob, "read_inbox", { unread_only: false, limit: 2 }))).toEqual(["m1", "@bob p1"]);
    expect(body(await ok(bob, "read_inbox", { unread_only: false, limit: 2, offset: 2 }))).toEqual(["m2", "@bob p2"]);
    expect(body(await ok(bob, "read_inbox", { unread_only: false, offset: 4 }))).toEqual([]);
  });
});

describe("waking on mentions", () => {
  it("counts unread mentions and their channels in order, and adds them to the wait line only when there are any", async () => {
    const alice = await connect("alice");
    await connect("bob");
    await ok(alice, "send_message", { to: "bob", body: "secret" });
    expect(formatUnread(summary("bob"))).toBe("1 unread message from alice");
    await ok(alice, "post", { channel: "ops", body: "@bob secret one" });
    await ok(alice, "post", { channel: "dev", body: "@bob secret two" });
    await ok(alice, "post", { channel: "ops", body: "@bob secret three" });
    expect(summary("bob")).toMatchObject({ posts: 0, mentions: 3, mentionChannels: ["ops", "dev"] });
    expect(formatUnread(summary("bob"))).toBe("1 unread message from alice; 3 unread mentions in #ops, #dev");
    expect(formatUnread({ count: 0, senders: [], posts: 0, channels: [], mentions: 1, mentionChannels: ["dev"] })).toBe(
      "1 unread mention in #dev",
    );
  });

  describe("over HTTP", () => {
    let http: HttpServer;
    beforeEach(async () => {
      http = await startHttp(db, { token: "t0ken", port: 0, waitHoldMs: 1500 });
    });
    afterEach(() => http.close());
    const wait = (agent: string) =>
      fetch(`http://127.0.0.1:${http.port}/wait?agent=${agent}`, { headers: { Authorization: "Bearer t0ken" } });

    it("GET /wait fires on a mention in a channel the agent has not joined, never with the body, and holds once it is read", async () => {
      const alice = await connect("alice");
      const bob = await connect("bob");
      await connect("bob", friend);
      const pending = wait("bob");
      await new Promise((r) => setTimeout(r, 300));
      await ok(alice, "post", { channel: "dev", body: "@bob secret body" });
      const res = await pending;
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("1 unread mention in #dev\n");
      await ok(bob, "read_inbox");
      expect((await wait("bob")).status).toBe(204);
    });
  });

  it("message-cp wait fires on a mention in a channel the agent has not joined", async () => {
    const alice = await connect("alice");
    await connect("bob");
    await ok(alice, "post", { channel: "dev", body: "@bob secret body" });
    const child = spawn(tsx, [join(root, "src/cli.ts"), "wait", "bob"], { env: { ...process.env, MESSAGE_CP_DB: dbFile } });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    expect(await new Promise((r) => child.on("close", r))).toBe(0);
    expect(out).toBe("1 unread mention in #dev\n");
  }, 20_000);
});

describe("the database", () => {
  it("creates the mentions table when it opens a database from before mentions", async () => {
    db.exec("DROP TABLE mentions");
    openDb(dbFile).close();
    const alice = await connect("alice");
    await connect("bob");
    await ok(alice, "post", { channel: "dev", body: "@bob" });
    expect(mentionCount()).toBe(1);
  });
});
