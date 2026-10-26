import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addAccount, listAccounts } from "../src/accounts.js";
import { PurgeError, addPerson, getAgent, purgeAgent, registerAgent, removeAgent } from "../src/agents.js";
import { addWebhook } from "../src/webhooks.js";
import { OWNER_ACCOUNT, openDb, type AccountId, type Db } from "../src/db.js";
import { Session, createServer } from "../src/server.js";

// `message-cp agent remove`: an agent, live or unregistered, goes with its direct messages and its mentions.
let dbFile: string;
let db: Db;
let friend: AccountId;
const clients: Client[] = [];

beforeEach(() => {
  dbFile = join(mkdtempSync(join(tmpdir(), "message-cp-agent-remove-")), "db.sqlite");
  db = openDb(dbFile);
  addAccount(db, "friend");
  friend = listAccounts(db).find((a) => a.name === "friend")!.id;
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  db.close();
});

/** A real server and client joined in-process, acting as `account`, with its own connection to the file. */
async function connect(account: AccountId = OWNER_ACCOUNT): Promise<Client> {
  const server = createServer(openDb(dbFile), new Session(account));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  clients.push(client);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  const text = res.content[0].text;
  return { isError: !!res.isError, text, json: res.isError ? undefined : JSON.parse(text) };
}

/** A session of `account` registered as `name`. */
async function agent(name: string, account: AccountId = OWNER_ACCOUNT) {
  const client = await connect(account);
  const res = await call(client, "register", { name, bio: "x" });
  expect(res.isError).toBe(false);
  return { client, key: res.json.key as string };
}

const rows = (sql: string, ...p: unknown[]) => db.prepare(sql).all(...p);
const bodies = (account: AccountId) =>
  rows("SELECT m.body FROM messages m JOIN agents a ON a.id = m.recipient_id WHERE a.account_id = ? ORDER BY m.id", account).map(
    (r) => (r as { body: string }).body,
  );
const mentionsOf = (account: AccountId) =>
  rows("SELECT m.agent_id FROM mentions m JOIN agents a ON a.id = m.agent_id WHERE a.account_id = ? ORDER BY m.post_id", account);

/**
 * alice, bob and carol in `account`: a message each way between alice and bob, a broadcast from each of them (to the
 * other and carol), a mention of each, and a channel alice joined.
 */
async function conversation(account: AccountId = OWNER_ACCOUNT, tag = "") {
  const alice = await agent("alice", account);
  const bob = await agent("bob", account);
  await agent("carol", account);
  await call(alice.client, "join_channel", { channel: "general" });
  await call(bob.client, "send_message", { to: "alice", body: `${tag}to alice` });
  await call(alice.client, "send_message", { to: "bob", body: `${tag}to bob` });
  await call(alice.client, "send_message", { to: "all", body: `${tag}alice to all` });
  await call(bob.client, "send_message", { to: "all", body: `${tag}bob to all` });
  await call(bob.client, "post", { channel: "general", body: `${tag}@alice look` });
  await call(alice.client, "post", { channel: "general", body: `${tag}@bob look` });
  return { alice, bob };
}

describe("purgeAgent", () => {
  it("removes a live agent, the messages to and from it and its mentions, and frees its name", async () => {
    const { alice, bob } = await conversation();
    const posts = rows("SELECT * FROM channel_posts ORDER BY id");
    const reads = rows("SELECT * FROM channel_reads ORDER BY agent_id");
    const channels = rows("SELECT * FROM channels");
    const id = (db.prepare("SELECT id FROM agents WHERE name = 'alice'").get() as { id: number }).id;

    expect(purgeAgent(db, "owner", "ALICE")).toEqual({ name: "alice", account: "owner", messages: 5, mentions: 1 });
    expect(bodies(OWNER_ACCOUNT)).toEqual(["bob to all"]);
    expect(mentionsOf(OWNER_ACCOUNT)).toHaveLength(1);
    expect(db.prepare("SELECT name, removed_name FROM agents WHERE id = ?").get(id)).toEqual({ name: `removed:${id}`, removed_name: "alice" });
    // Channels, posts and read positions stay.
    expect(rows("SELECT * FROM channel_posts ORDER BY id")).toEqual(posts);
    expect(rows("SELECT * FROM channel_reads ORDER BY agent_id")).toEqual(reads);
    expect(rows("SELECT * FROM channels")).toEqual(channels);

    // bob's inbox has only his own mention left of what alice was part of.
    expect((await call(bob.client, "read_inbox", { unread_only: false })).json.map((m: { body: string }) => m.body)).toEqual(["@bob look"]);
    // The session still acting as alice is unregistered.
    expect((await call(alice.client, "read_inbox")).text).toMatch(/Call `register` first/);

    // The name registers again with no key, as a new agent with nothing from before.
    const again = await agent("alice");
    expect((await call(again.client, "read_inbox", { unread_only: false })).json).toEqual([]);
    expect(rows("SELECT * FROM channel_reads WHERE agent_id = (SELECT id FROM agents WHERE name = 'alice')")).toEqual([]);
    expect((await call(again.client, "list_channels")).json).toMatchObject([{ name: "general", joined: false }]);
  });

  it("removes an agent that has only unregistered rows left, and a live one with them", async () => {
    const first = await agent("alice");
    const bob = await agent("bob");
    await call(bob.client, "send_message", { to: "alice", body: "to the first" });
    await call(first.client, "send_message", { to: "bob", body: "from the first" });
    await call(first.client, "unregister");
    const second = await agent("Alice");
    await call(bob.client, "send_message", { to: "alice", body: "to the second" });
    await call(bob.client, "post", { channel: "general", body: "@alice hi" });
    await call(second.client, "unregister");
    expect(getAgent(db, OWNER_ACCOUNT, "alice")).toBeUndefined();

    // Only removed rows: both are cleared.
    expect(purgeAgent(db, "owner", "alice")).toEqual({ name: "Alice", account: "owner", messages: 3, mentions: 1 });
    expect(bodies(OWNER_ACCOUNT)).toEqual([]);
    expect(mentionsOf(OWNER_ACCOUNT)).toEqual([]);
    // The removed rows stay, so running it again finds nothing more to remove.
    expect(purgeAgent(db, "owner", "alice")).toEqual({ name: "Alice", account: "owner", messages: 0, mentions: 0 });

    // A live agent and an older removed row of the same name, at once.
    const third = await agent("alice");
    await call(bob.client, "send_message", { to: "alice", body: "to the third" });
    await call(third.client, "unregister");
    const fourth = await agent("alice");
    await call(bob.client, "send_message", { to: "alice", body: "to the fourth" });
    await call(fourth.client, "send_message", { to: "bob", body: "from the fourth" });
    expect(purgeAgent(db, "owner", "alice")).toEqual({ name: "alice", account: "owner", messages: 3, mentions: 0 });
    expect(bodies(OWNER_ACCOUNT)).toEqual([]);
    expect(getAgent(db, OWNER_ACCOUNT, "alice")).toBeUndefined();
  });

  it("leaves another account's agent of the same name, its messages and its mentions untouched", async () => {
    await conversation(OWNER_ACCOUNT, "owner ");
    const friendPair = await conversation(friend, "friend ");
    const friendMessages = rows("SELECT m.* FROM messages m JOIN agents a ON a.id = m.recipient_id WHERE a.account_id = ? ORDER BY m.id", friend);
    const friendMentions = mentionsOf(friend);
    const friendAgents = rows("SELECT * FROM agents WHERE account_id = ? ORDER BY id", friend);

    expect(purgeAgent(db, "owner", "alice")).toMatchObject({ messages: 5, mentions: 1 });
    expect(rows("SELECT m.* FROM messages m JOIN agents a ON a.id = m.recipient_id WHERE a.account_id = ? ORDER BY m.id", friend)).toEqual(
      friendMessages,
    );
    expect(friendMessages).toHaveLength(6);
    expect(mentionsOf(friend)).toEqual(friendMentions);
    expect(friendMentions).toHaveLength(2);
    expect(rows("SELECT * FROM agents WHERE account_id = ? ORDER BY id", friend)).toEqual(friendAgents);

    // The other account's alice, once unregistered with her messages and mention kept, is untouched too.
    await call(friendPair.alice.client, "unregister");
    const friendBefore = ["messages", "mentions", "agents"].map((t) => rows(`SELECT * FROM ${t} ORDER BY rowid`));
    expect(purgeAgent(db, "owner", "alice")).toMatchObject({ messages: 0, mentions: 0 });
    expect(["messages", "mentions", "agents"].map((t) => rows(`SELECT * FROM ${t} ORDER BY rowid`))).toEqual(friendBefore);

    // And the other way round.
    expect(purgeAgent(db, "friend", "alice")).toMatchObject({ account: "friend", messages: 5, mentions: 1 });
    expect(bodies(OWNER_ACCOUNT)).toEqual(["owner bob to all"]);
  });

  it("deletes the webhook deliveries queued for the deleted messages, and keeps the others", async () => {
    addWebhook(db, "owner", "https://example.com/", "agent:alice", true);
    addWebhook(db, "owner", "https://example.com/", "agent:bob", true);
    addWebhook(db, "owner", "https://example.com/", "agent:carol", true);
    addWebhook(db, "owner", "https://example.com/", "#general", true);
    await conversation();
    type Delivery = { message_id: number | null; post_id: number | null };
    const before = rows("SELECT * FROM webhook_deliveries ORDER BY id") as Delivery[];
    purgeAgent(db, "owner", "alice");
    const left = new Set(rows("SELECT id FROM messages").map((r) => (r as { id: number }).id));
    const kept = before.filter((d) => d.post_id !== null || left.has(d.message_id!));
    expect(kept.some((d) => d.message_id !== null)).toBe(true);
    expect(kept.length).toBeLessThan(before.length);
    expect(rows("SELECT * FROM webhook_deliveries ORDER BY id")).toEqual(kept);
  });

  it("refuses a person, an unknown name and an unknown account, and changes nothing", async () => {
    await conversation();
    addPerson(db, "owner", "colin");
    registerAgent(db, friend, "dana", "x");
    const snapshot = () => ["agents", "messages", "mentions", "channel_posts", "channel_reads"].map((t) => rows(`SELECT * FROM ${t}`));
    const before = snapshot();
    expect(() => purgeAgent(db, "owner", "Colin")).toThrow("The name 'colin' belongs to a person, not an agent.");
    expect(() => purgeAgent(db, "owner", "nobody")).toThrow("No agent named 'nobody' in account 'owner'.");
    // Another account's agent is not one of this account's.
    expect(() => purgeAgent(db, "owner", "dana")).toThrow("No agent named 'dana' in account 'owner'.");
    expect(() => purgeAgent(db, "nobody", "alice")).toThrow("No account named 'nobody'.");
    expect(() => purgeAgent(db, "nobody", "alice")).toThrow(PurgeError);
    expect(snapshot()).toEqual(before);
  });

  it("removes a name with more removed rows than SQLite allows bound variables in one statement", async () => {
    const bob = await agent("bob");
    const alice = await agent("alice");
    await call(alice.client, "send_message", { to: "bob", body: "from the last" });
    await call(bob.client, "send_message", { to: "alice", body: "to the last" });
    await call(alice.client, "unregister");
    // Earlier registrations, as `unregister` leaves them, past this build's limit of 32766.
    const insert = db.prepare(
      "INSERT INTO agents (account_id, name, bio, registered_at, last_seen, removed_at, removed_name) VALUES (?, ?, '', 0, 0, 0, 'alice')",
    );
    db.transaction(() => {
      for (let i = 0; i < 33000; i++) insert.run(OWNER_ACCOUNT, `old:${i}`);
    })();
    expect(purgeAgent(db, "owner", "alice")).toMatchObject({ messages: 2, mentions: 0 });
    expect(bodies(OWNER_ACCOUNT)).toEqual([]);
  });

  it("refuses a person who has the name of an older removed agent, keeping the person's messages", async () => {
    const alice = await agent("alice");
    const bob = await agent("bob");
    await call(alice.client, "send_message", { to: "bob", body: "from the agent" });
    removeAgent(db, OWNER_ACCOUNT, "alice", alice.key);
    addPerson(db, "owner", "alice");
    await call(bob.client, "send_message", { to: "alice", body: "to the person" });
    const before = rows("SELECT * FROM messages ORDER BY id");
    expect(() => purgeAgent(db, "owner", "alice")).toThrow("belongs to a person");
    expect(rows("SELECT * FROM messages ORDER BY id")).toEqual(before);
  });
});

describe("message-cp agent remove", () => {
  const root = resolve(import.meta.dirname, "..");
  const cli = (...args: string[]) =>
    spawnSync(join(root, "node_modules/.bin/tsx"), [join(root, "src/cli.ts"), ...args], {
      env: { ...process.env, MESSAGE_CP_DB: dbFile },
      encoding: "utf8",
    });

  it("removes the owner's agent by default, or --account's, saying what it removed and printing no body or key", async () => {
    const owner = await conversation(OWNER_ACCOUNT, "secret-owner ");
    await conversation(friend, "secret-friend ");
    const res = cli("agent", "remove", "Alice");
    expect(res.status).toBe(0);
    expect(res.stdout).toBe("");
    expect(res.stderr).toBe(
      "message-cp: removed agent 'alice' of account 'owner', with 5 direct message(s) and 1 mention(s). The name is free.\n",
    );
    expect(bodies(OWNER_ACCOUNT)).toEqual(["secret-owner bob to all"]);
    expect(bodies(friend)).toHaveLength(6);

    const other = cli("agent", "remove", "bob", "--account", "friend");
    expect(other.status).toBe(0);
    expect(other.stdout).toBe("");
    expect(other.stderr).toContain("removed agent 'bob' of account 'friend', with 5 direct message(s) and 1 mention(s)");
    expect(bodies(friend)).toEqual(["secret-friend alice to all"]);
    for (const out of [res, other]) {
      expect(out.stderr).not.toContain("secret");
      expect(out.stderr).not.toContain(owner.alice.key);
      expect(out.stderr).not.toMatch(/[0-9a-f]{32}/);
    }
  }, 60_000);

  it("fails with exit 1 and a reason for a person, an unknown name or an unknown account", () => {
    addPerson(db, "owner", "colin");
    registerAgent(db, OWNER_ACCOUNT, "alice", "x");
    for (const [args, message] of [
      [["agent", "remove", "colin"], "The name 'colin' belongs to a person, not an agent."],
      [["agent", "remove", "nobody"], "No agent named 'nobody' in account 'owner'."],
      [["agent", "remove", "alice", "--account", "friend"], "No agent named 'alice' in account 'friend'."],
      [["agent", "remove", "alice", "--account", "nobody"], "No account named 'nobody'."],
    ] as const) {
      const res = cli(...args);
      expect(res.status).toBe(1);
      expect(res.stdout).toBe("");
      expect(res.stderr).toContain(message);
    }
    expect(getAgent(db, OWNER_ACCOUNT, "alice")).toBeDefined();
  }, 60_000);

  it("prints its usage and exits 2 for anything else", () => {
    for (const args of [
      ["agent"],
      ["agent", "remove"],
      ["agent", "remove", "--account", "owner"],
      ["agent", "remove", "a", "--account"],
      ["agent", "remove", "a", "--account", "owner", "--account", "friend"],
      ["agent", "remove", "a", "--key", "x"],
    ]) {
      const res = cli(...args);
      expect(res.status).toBe(2);
      expect(res.stderr).toContain("usage: message-cp agent list [--account <name>] | message-cp agent remove <name> [--account <name>]");
    }
    expect(cli("nope").stderr).toContain("Commands: serve, wait, account, token, webhook, person, agent");
  }, 120_000);
});
