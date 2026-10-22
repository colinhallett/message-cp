import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addAccount, listAccounts } from "../src/accounts.js";
import { KeyResetError, addPerson, identityOf, registerAgent, removeAgent, resetAgentKey } from "../src/agents.js";
import { addWebhook } from "../src/webhooks.js";
import { OWNER_ACCOUNT, openDb, type AccountId, type Db } from "../src/db.js";
import { Session, createServer } from "../src/server.js";
import { restorableSession, saveSession } from "../src/sessions.js";

// `message-cp agent key reset`: an agent gets a new key and keeps everything else; whoever held the old one is cut off.
let dbFile: string;
let db: Db;
let friend: AccountId;
const clients: Client[] = [];

beforeEach(() => {
  dbFile = join(mkdtempSync(join(tmpdir(), "message-cp-agent-key-reset-")), "db.sqlite");
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
  const res = await call(client, "register", { name, bio: `${name}'s bio` });
  expect(res.isError).toBe(false);
  return { client, key: res.json.key as string };
}

const rows = (sql: string, ...p: unknown[]) => db.prepare(sql).all(...p);

/** alice and bob in `account`: a message each way, a broadcast, a mention of each, and a channel both joined. */
async function conversation(account: AccountId = OWNER_ACCOUNT) {
  const alice = await agent("alice", account);
  const bob = await agent("bob", account);
  await call(alice.client, "join_channel", { channel: "general" });
  await call(bob.client, "join_channel", { channel: "general" });
  await call(bob.client, "send_message", { to: "alice", body: "to alice" });
  await call(alice.client, "send_message", { to: "bob", body: "to bob" });
  await call(alice.client, "send_message", { to: "all", body: "alice to all" });
  await call(bob.client, "post", { channel: "general", body: "@alice look" });
  await call(alice.client, "post", { channel: "general", body: "@bob look" });
  await call(alice.client, "read_channel", { channel: "general" });
  return { alice, bob };
}

/** Everything of the database but the agents' key hashes and instances, and the recorded HTTP sessions. */
const snapshot = () => ({
  agents: rows("SELECT id, account_id, name, bio, registered_at, last_seen, person, removed_at, removed_name FROM agents ORDER BY id"),
  ...Object.fromEntries(
    ["messages", "mentions", "channels", "channel_posts", "channel_reads", "webhooks", "webhook_deliveries"].map((t) => [
      t,
      rows(`SELECT * FROM ${t} ORDER BY rowid`),
    ]),
  ),
});

describe("resetAgentKey", () => {
  it("gives the agent a new key and keeps its row, messages, mentions, channels and webhooks", async () => {
    addWebhook(db, "owner", "https://example.com/", "agent:alice", true);
    addWebhook(db, "owner", "https://example.com/", "mention:alice", true);
    const { alice, bob } = await conversation();
    const before = snapshot();
    expect((before.webhook_deliveries as unknown[]).length).toBeGreaterThan(0);
    const oldHash = (db.prepare("SELECT key_hash FROM agents WHERE name = 'alice'").get() as { key_hash: string }).key_hash;

    const reset = resetAgentKey(db, "owner", "ALICE");
    expect(reset).toEqual({ name: "alice", account: "owner", key: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(reset.key).not.toBe(alice.key);
    expect(snapshot()).toEqual(before);
    const newHash = (db.prepare("SELECT key_hash FROM agents WHERE name = 'alice'").get() as { key_hash: string }).key_hash;
    expect(newHash).not.toBe(oldHash);
    expect(newHash).not.toBe(reset.key);

    // Still in the directory.
    expect((await call(bob.client, "get_agent", { name: "alice" })).json).toMatchObject({ name: "alice", bio: "alice's bio" });

    // The new key takes the agent over, with its inbox, conversation, mentions and channels as they were.
    const again = await connect();
    expect((await call(again, "register", { name: "alice", bio: "x", key: reset.key })).isError).toBe(false);
    const inbox = (await call(again, "read_inbox", { unread_only: false })).json.map((m: { body: string }) => m.body);
    expect(inbox).toEqual(expect.arrayContaining(["to alice", "@alice look"]));
    const convo = (await call(again, "read_conversation", { name: "bob" })).json;
    expect(JSON.stringify(convo)).toContain("to alice");
    expect(JSON.stringify(convo)).toContain("to bob");
    expect((await call(again, "list_channels")).json).toMatchObject([{ name: "general", joined: true }]);
    // The read position is the one alice had: nothing new in the channel.
    expect((await call(again, "read_channel", { channel: "general" })).json).toMatchObject({ posts: [] });
  });

  it("refuses the old key for register and unregister, and accepts the new one", async () => {
    const { key } = await agent("alice");
    const { key: newKey } = resetAgentKey(db, "owner", "alice");
    const other = await connect();
    expect((await call(other, "register", { name: "alice", bio: "x", key })).text).toMatch(/already registered and has a key/);
    expect((await call(other, "unregister", { name: "alice", key })).text).toMatch(/Wrong key for agent 'alice'/);
    expect(() => registerAgent(db, OWNER_ACCOUNT, "alice", undefined, key)).toThrow(/has a key/);
    expect((await call(other, "unregister", { name: "alice", key: newKey })).isError).toBe(false);
  });

  it("unregisters every session acting as the agent, and a recorded HTTP session is not restored", async () => {
    const { alice, bob } = await conversation();
    const identity = identityOf(db, OWNER_ACCOUNT, "alice")!;
    saveSession(db, "http-session", OWNER_ACCOUNT, identity);
    const bobIdentity = identityOf(db, OWNER_ACCOUNT, "bob")!;
    saveSession(db, "bob-session", OWNER_ACCOUNT, bobIdentity);
    expect(restorableSession(db, "http-session", OWNER_ACCOUNT, 0)).toEqual(identity);

    resetAgentKey(db, "owner", "alice");
    for (const [tool, args] of [
      ["read_inbox", {}],
      ["send_message", { to: "bob", body: "after" }],
      ["post", { channel: "general", body: "after" }],
      ["read_channel", { channel: "general" }],
    ] as const) {
      expect((await call(alice.client, tool, args)).text).toMatch(/Call `register` first/);
    }
    expect(restorableSession(db, "http-session", OWNER_ACCOUNT, 0)).toBeUndefined();
    // The identity kept its id and registration time; only the instance changed.
    expect(identityOf(db, OWNER_ACCOUNT, "alice")).toMatchObject({ id: identity.id, registeredAt: identity.registeredAt });
    // bob's session and recorded session are untouched, and alice is still listed.
    expect(restorableSession(db, "bob-session", OWNER_ACCOUNT, 0)).toEqual(bobIdentity);
    expect((await call(bob.client, "list_agents")).json.map((a: { name: string }) => a.name)).toEqual(["alice", "bob"]);
  });

  it("leaves another account's agent of the same name, its key and its sessions untouched", async () => {
    const theirs = await conversation(friend);
    const before = rows("SELECT * FROM agents WHERE account_id = ? ORDER BY id", friend);
    const identity = identityOf(db, friend, "alice")!;
    saveSession(db, "friend-session", friend, identity);
    await agent("alice");

    resetAgentKey(db, "owner", "alice");
    expect(rows("SELECT * FROM agents WHERE account_id = ? ORDER BY id", friend)).toEqual(before);
    expect(restorableSession(db, "friend-session", friend, 0)).toEqual(identity);
    expect((await call(theirs.alice.client, "read_inbox")).isError).toBe(false);
  });

  it("refuses a person, a removed agent, an unknown name and an unknown account, and changes nothing", async () => {
    await conversation();
    addPerson(db, "owner", "colin");
    registerAgent(db, friend, "dana", "x");
    const gone = await agent("erin");
    removeAgent(db, OWNER_ACCOUNT, "erin", gone.key);
    const all = () => ({ ...snapshot(), keys: rows("SELECT key_hash, instance FROM agents ORDER BY id") });
    const before = all();
    expect(() => resetAgentKey(db, "owner", "Colin")).toThrow("The name 'colin' belongs to a person, not an agent.");
    expect(() => resetAgentKey(db, "owner", "erin")).toThrow("No agent named 'erin' in account 'owner'.");
    expect(() => resetAgentKey(db, "owner", "nobody")).toThrow("No agent named 'nobody' in account 'owner'.");
    expect(() => resetAgentKey(db, "owner", "dana")).toThrow("No agent named 'dana' in account 'owner'.");
    expect(() => resetAgentKey(db, "nobody", "alice")).toThrow("No account named 'nobody'.");
    expect(() => resetAgentKey(db, "nobody", "alice")).toThrow(KeyResetError);
    expect(all()).toEqual(before);
  });

  it("finds the agent by the account and name index and updates it by id", () => {
    const plan = (sql: string) =>
      db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...Array.from(sql.matchAll(/\?/g), () => null))
        .map((r) => (r as { detail: string }).detail);
    expect(plan("SELECT id, name FROM accounts WHERE name = ?")).toEqual([expect.stringMatching(/^SEARCH accounts USING /)]);
    expect(plan("SELECT id, name, person FROM agents WHERE account_id = ? AND name = ? AND removed_at IS NULL")).toEqual([
      "SEARCH agents USING INDEX sqlite_autoindex_agents_1 (account_id=? AND name=?)",
    ]);
    expect(plan("UPDATE agents SET key_hash = ?, instance = ? WHERE id = ?")).toEqual(["SEARCH agents USING INTEGER PRIMARY KEY (rowid=?)"]);
  });
});

describe("message-cp agent key reset", () => {
  const root = resolve(import.meta.dirname, "..");
  const cli = (...args: string[]) =>
    spawnSync(join(root, "node_modules/.bin/tsx"), [join(root, "src/cli.ts"), ...args], {
      env: { ...process.env, MESSAGE_CP_DB: dbFile },
      encoding: "utf8",
    });

  it("prints the new key alone on stdout and only the agent and account on stderr", async () => {
    const { key } = await agent("alice");
    await agent("alice", friend);
    const res = cli("agent", "key", "reset", "Alice");
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/^[0-9a-f]{64}\n$/);
    expect(res.stderr).toBe(
      "message-cp: new key for agent 'alice' of account 'owner'. It is shown only now; keep it. The old key no longer works.\n",
    );
    const newKey = res.stdout.trim();
    expect(newKey).not.toBe(key);
    expect(res.stderr).not.toMatch(/[0-9a-f]{32}/);
    expect(res.stdout).not.toContain(key);
    expect(() => registerAgent(db, OWNER_ACCOUNT, "alice", undefined, newKey)).not.toThrow();

    const other = cli("agent", "key", "reset", "alice", "--account", "friend");
    expect(other.status).toBe(0);
    expect(other.stderr).toContain("new key for agent 'alice' of account 'friend'");
    expect(other.stdout.trim()).not.toBe(newKey);
    expect(() => registerAgent(db, friend, "alice", undefined, other.stdout.trim())).not.toThrow();
  }, 60_000);

  it("fails with exit 1 and a reason for a person, an unknown name or an unknown account", () => {
    addPerson(db, "owner", "colin");
    registerAgent(db, OWNER_ACCOUNT, "alice", "x");
    const before = rows("SELECT * FROM agents ORDER BY id");
    for (const [args, message] of [
      [["agent", "key", "reset", "colin"], "The name 'colin' belongs to a person, not an agent."],
      [["agent", "key", "reset", "nobody"], "No agent named 'nobody' in account 'owner'."],
      [["agent", "key", "reset", "alice", "--account", "friend"], "No agent named 'alice' in account 'friend'."],
      [["agent", "key", "reset", "alice", "--account", "nobody"], "No account named 'nobody'."],
    ] as const) {
      const res = cli(...args);
      expect(res.status).toBe(1);
      expect(res.stdout).toBe("");
      expect(res.stderr).toContain(message);
    }
    expect(rows("SELECT * FROM agents ORDER BY id")).toEqual(before);
  }, 60_000);

  it("prints its usage and exits 2 for anything else", () => {
    for (const args of [
      ["agent", "key"],
      ["agent", "key", "reset"],
      ["agent", "key", "reset", "--account", "owner"],
      ["agent", "key", "reset", "a", "--account"],
      ["agent", "key", "reset", "a", "--account", "owner", "--account", "friend"],
      ["agent", "key", "reset", "a", "--key", "x"],
      ["agent", "key", "show", "a"],
      ["agent", "reset", "a"],
    ]) {
      const res = cli(...args);
      expect(res.status).toBe(2);
      expect(res.stdout).toBe("");
      expect(res.stderr).toContain(
        "usage: message-cp agent remove <name> [--account <name>] | message-cp agent key reset <name> [--account <name>]",
      );
    }
  }, 120_000);
});
