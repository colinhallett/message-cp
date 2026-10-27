import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { accountForToken, addAccount, addToken, listAccounts } from "../src/accounts.js";
import {
  PersonError,
  ToolError,
  WrongPersonError,
  purgeAgent,
  addPerson,
  getAgent,
  identityOf,
  listAgents,
  listPeople,
  nameOfIdentity,
  registerAgent,
  registerFromEnv,
  removePerson,
} from "../src/agents.js";
import { OWNER_ACCOUNT, openDb, type AccountId, type Db } from "../src/db.js";
import { startHttp } from "../src/http.js";
import { listAgentsUnread, readInbox, sendAsPerson, sendMessage } from "../src/messages.js";
import { postAsPerson } from "../src/channels.js";
import { Session, createServer } from "../src/server.js";
import { addWebhook, deliveryBody } from "../src/webhooks.js";

// People: names the operator adds with `message-cp person add`, stored as rows of `agents` marked `person`.
let dbFile: string;
let db: Db;
let friend: AccountId;
const clients: Client[] = [];

beforeEach(() => {
  dbFile = join(mkdtempSync(join(tmpdir(), "message-cp-people-")), "db.sqlite");
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

const agentsRows = () => db.prepare("SELECT * FROM agents ORDER BY id").all();

describe("addPerson and listPeople", () => {
  it("adds a person to the named account, marked as a person and holding no key anyone has", () => {
    expect(addPerson(db, "owner", "colin")).toMatchObject({ name: "colin", account: "owner" });
    expect(db.prepare("SELECT account_id, name, person, key_hash FROM agents").all()).toEqual([
      { account_id: OWNER_ACCOUNT, name: "colin", person: 1, key_hash: "person" },
    ]);
    expect(getAgent(db, OWNER_ACCOUNT, "Colin")).toMatchObject({ name: "colin", person: true });
    expect(listPeople(db)).toEqual([{ name: "colin", account: "owner", addedAt: expect.any(String) }]);
  });

  it("refuses an invalid name, all, a taken name in any case and an unknown account, and stores nothing", () => {
    registerAgent(db, OWNER_ACCOUNT, "alice", "x");
    addPerson(db, "owner", "colin");
    const before = agentsRows();
    expect(() => addPerson(db, "owner", "no spaces")).toThrow(/Invalid name/);
    expect(() => addPerson(db, "owner", "ALL")).toThrow(/'all' is reserved/);
    expect(() => addPerson(db, "owner", "Alice")).toThrow("The name 'alice' is already used by an agent in account 'owner'.");
    expect(() => addPerson(db, "owner", "COLIN")).toThrow("The name 'colin' is already used by a person in account 'owner'.");
    expect(() => addPerson(db, "nobody", "dana")).toThrow("No account named 'nobody'.");
    expect(() => addPerson(db, "owner", "")).toThrow(PersonError);
    expect(agentsRows()).toEqual(before);
  });

  it("keeps each account's people apart, and lets two accounts each have a person of the same name", () => {
    registerAgent(db, friend, "colin", "friend's agent");
    expect(() => addPerson(db, "owner", "colin")).not.toThrow();
    addPerson(db, "friend", "dana");
    expect(listPeople(db, "owner").map((p) => p.name)).toEqual(["colin"]);
    expect(listPeople(db, "friend").map((p) => p.name)).toEqual(["dana"]);
    expect(getAgent(db, friend, "colin")).toMatchObject({ person: false });
    expect(getAgent(db, friend, "colin")?.bio).toBe("friend's agent");
    expect(() => listPeople(db, "nobody")).toThrow("No account named 'nobody'.");
  });
});

describe("a person in the tools", () => {
  it("receives a message and a mention stored as an agent's are, with their webhook deliveries", async () => {
    addPerson(db, "owner", "colin");
    const direct = addWebhook(db, "owner", "https://example.com/", "agent:colin", true);
    const mention = addWebhook(db, "owner", "https://example.com/", "mention:colin", true);
    const { client } = await agent("alice");
    expect((await call(client, "send_message", { to: "Colin", body: "hello" })).json).toEqual({ delivered: 1, recipients: ["colin"], messages: [{ id: expect.any(Number), to: "colin" }] });
    expect((await call(client, "post", { channel: "general", body: "@colin look" })).isError).toBe(false);

    const colin = getAgentId("colin", OWNER_ACCOUNT);
    expect(db.prepare("SELECT recipient_id, sender, body FROM messages").all()).toEqual([{ recipient_id: colin, sender: "alice", body: "hello" }]);
    expect(db.prepare("SELECT agent_id FROM mentions").all()).toEqual([{ agent_id: colin }]);
    const deliveries = db.prepare("SELECT id, webhook_id FROM webhook_deliveries ORDER BY id").all() as { id: number; webhook_id: number }[];
    expect(deliveries.map((d) => [d.webhook_id, deliveryBody(db, d.id)?.event])).toEqual([
      [direct.id, "agent"],
      [mention.id, "mention"],
    ]);
    expect(readInbox(db, OWNER_ACCOUNT, "colin").map((m) => m.body)).toEqual(["hello", "@colin look"]);
  });

  it("receives a broadcast like any agent", async () => {
    addPerson(db, "owner", "colin");
    const { client } = await agent("alice");
    await agent("bob");
    expect((await call(client, "send_message", { to: "all", body: "hi all" })).json).toEqual({
      delivered: 2,
      recipients: ["bob", "colin"],
      messages: [{ id: expect.any(Number), to: "bob" }, { id: expect.any(Number), to: "colin" }],
    });
  });

  it("is in list_agents and get_agent with person true, and every agent has person false", async () => {
    addPerson(db, "owner", "colin");
    const { client } = await agent("alice");
    const list = (await call(client, "list_agents")).json as { name: string; person: boolean }[];
    expect(list.map((a) => [a.name, a.person])).toEqual([
      ["alice", false],
      ["colin", true],
    ]);
    expect((await call(client, "get_agent", { name: "colin" })).json).toMatchObject({ name: "colin", person: true });
    expect((await call(client, "get_agent", { name: "alice" })).json).toMatchObject({ person: false });
  });

  it("cannot be registered, with or without a key, and nothing changes", async () => {
    addPerson(db, "owner", "colin");
    const before = agentsRows();
    const client = await connect();
    for (const args of [{ name: "colin", bio: "me" }, { name: "COLIN", bio: "me" }, { name: "colin", bio: "me", key: "person" }]) {
      const res = await call(client, "register", args);
      expect(res.isError).toBe(true);
      expect(res.text).toBe("The name 'colin' belongs to a person, not an agent. No agent can register or remove it.");
    }
    expect(agentsRows()).toEqual(before);
    // The session is still unregistered.
    expect((await call(client, "send_message", { to: "colin", body: "x" })).text).toMatch(/Call `register` first/);
  });

  it("cannot be taken by a process started with MESSAGE_CP_AGENT", () => {
    addPerson(db, "owner", "colin");
    const before = agentsRows();
    expect(() => registerFromEnv(db, OWNER_ACCOUNT, { MESSAGE_CP_AGENT: "colin", MESSAGE_CP_AGENT_KEY: "person" })).toThrow(ToolError);
    expect(agentsRows()).toEqual(before);
  });

  it("has no identity, so no session can act as them even when bound to their row", () => {
    addPerson(db, "owner", "colin");
    expect(identityOf(db, OWNER_ACCOUNT, "colin")).toBeUndefined();
    const row = db.prepare("SELECT id, registered_at, instance FROM agents WHERE name = 'colin'").get() as {
      id: number;
      registered_at: number;
      instance: string | null;
    };
    const identity = { id: row.id, registeredAt: row.registered_at, instance: row.instance };
    expect(nameOfIdentity(db, OWNER_ACCOUNT, identity)).toBeUndefined();
    const session = new Session(OWNER_ACCOUNT);
    session.attach(db);
    session.bind(identity);
    expect(session.current()).toBeUndefined();
    expect(() => session.require()).toThrow(ToolError);
  });

  it("cannot be unregistered, with or without a key, and nothing changes", async () => {
    addPerson(db, "owner", "colin");
    const before = agentsRows();
    const { client } = await agent("alice");
    const stranger = await connect();
    for (const [c, args] of [
      [client, { name: "colin" }],
      [client, { name: "Colin", key: "person" }],
      [stranger, { name: "colin", key: "anything" }],
    ] as const) {
      const res = await call(c, "unregister", args);
      expect(res.isError).toBe(true);
      expect(res.text).toBe("The name 'colin' belongs to a person, not an agent. No agent can register or remove it.");
    }
    expect(agentsRows().filter((r) => (r as { name: string }).name === "colin")).toEqual(
      before.filter((r) => (r as { name: string }).name === "colin"),
    );
  });

  it("cannot be seen, messaged or mentioned from another account", async () => {
    addPerson(db, "owner", "colin");
    addWebhook(db, "owner", "https://example.com/", "agent:colin", true);
    addWebhook(db, "owner", "https://example.com/", "mention:colin", true);
    const { client } = await agent("fred", friend);
    expect((await call(client, "list_agents")).json.map((a: { name: string }) => a.name)).toEqual(["fred"]);
    expect((await call(client, "get_agent", { name: "colin" })).isError).toBe(true);
    const sent = await call(client, "send_message", { to: "colin", body: "hi" });
    expect(sent.isError).toBe(true);
    expect(sent.text).toBe("No agent named 'colin'.");
    expect((await call(client, "send_message", { to: "all", body: "hi all" })).json).toEqual({ delivered: 0, recipients: [], messages: [] });
    expect((await call(client, "post", { channel: "general", body: "@colin look" })).isError).toBe(false);
    expect(db.prepare("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM mentions").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM webhook_deliveries").get()).toEqual({ n: 0 });
    // And the friend's account can register its own colin, an agent unrelated to the owner's person.
    expect((await call(await connect(friend), "register", { name: "colin", bio: "friend's" })).isError).toBe(false);
    expect(getAgent(db, OWNER_ACCOUNT, "colin")).toMatchObject({ person: true, bio: "" });
  });
});

function getAgentId(name: string, account: AccountId): number {
  return (db.prepare("SELECT id FROM agents WHERE account_id = ? AND name = ?").get(account, name) as { id: number }).id;
}

const bodies = (account: AccountId) =>
  db
    .prepare("SELECT m.body FROM messages m JOIN agents a ON a.id = m.recipient_id WHERE a.account_id = ? ORDER BY m.id")
    .all(account)
    .map((r) => (r as { body: string }).body);
const mentionsOf = (account: AccountId) =>
  db.prepare("SELECT m.agent_id FROM mentions m JOIN agents a ON a.id = m.agent_id WHERE a.account_id = ? ORDER BY m.post_id").all(account);

/**
 * The person colin and the agents alice and bob in `account`: a message each way between alice and colin, a broadcast
 * from each of them, a mention of colin and of alice, and a post by colin.
 */
async function personConversation(account: AccountId = OWNER_ACCOUNT, tag = "") {
  const accountName = account === OWNER_ACCOUNT ? "owner" : "friend";
  addPerson(db, accountName, "colin");
  const alice = await agent("alice", account);
  const bob = await agent("bob", account);
  await call(alice.client, "join_channel", { channel: "general" });
  await call(alice.client, "send_message", { to: "colin", body: `${tag}to colin` });
  sendAsPerson(db, account, "colin", "alice", `${tag}from colin`);
  sendAsPerson(db, account, "colin", "all", `${tag}colin to all`);
  await call(alice.client, "send_message", { to: "all", body: `${tag}alice to all` });
  await call(bob.client, "post", { channel: "general", body: `${tag}@colin look` });
  await call(bob.client, "post", { channel: "general", body: `${tag}@alice look` });
  postAsPerson(db, account, "colin", "general", `${tag}colin posts`);
  return { alice, bob };
}

describe("removePerson", () => {
  it("removes a person, the messages to and from them and their mentions, and keeps the row, channels and posts", async () => {
    addWebhook(db, "owner", "https://example.com/", "agent:colin", true);
    addWebhook(db, "owner", "https://example.com/", "agent:bob", true);
    const { alice } = await personConversation();
    const queued = (db.prepare("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE message_id IS NOT NULL").get() as { n: number }).n;
    const posts = db.prepare("SELECT * FROM channel_posts ORDER BY id").all();
    const reads = db.prepare("SELECT * FROM channel_reads ORDER BY agent_id").all();
    const channels = db.prepare("SELECT * FROM channels").all();
    const id = getAgentId("colin", OWNER_ACCOUNT);

    expect(removePerson(db, "owner", "COLIN")).toEqual({ name: "colin", account: "owner", messages: 5, mentions: 1 });
    expect(bodies(OWNER_ACCOUNT)).toEqual(["alice to all"]);
    expect(mentionsOf(OWNER_ACCOUNT)).toHaveLength(1);
    expect(db.prepare("SELECT name, removed_name, removed_at IS NOT NULL AS removed FROM agents WHERE id = ?").get(id)).toEqual({
      name: `removed:${id}`,
      removed_name: "colin",
      removed: 1,
    });
    expect(listPeople(db)).toEqual([]);
    expect(getAgent(db, OWNER_ACCOUNT, "colin")).toBeUndefined();
    // Only the deliveries of the messages that are left are still queued.
    const left = new Set(db.prepare("SELECT id FROM messages").all().map((r) => (r as { id: number }).id));
    const deliveries = db.prepare("SELECT message_id FROM webhook_deliveries WHERE message_id IS NOT NULL").all() as { message_id: number }[];
    expect(deliveries.length).toBeGreaterThan(0);
    expect(deliveries.length).toBeLessThan(queued);
    expect(deliveries.every((d) => left.has(d.message_id))).toBe(true);
    // Channels, posts (colin's own included) and read positions stay.
    expect(db.prepare("SELECT * FROM channel_posts ORDER BY id").all()).toEqual(posts);
    expect(db.prepare("SELECT * FROM channel_reads ORDER BY agent_id").all()).toEqual(reads);
    expect(db.prepare("SELECT * FROM channels").all()).toEqual(channels);
    expect((await call(alice.client, "read_inbox", { unread_only: false })).json.map((m: { body: string }) => m.body)).toEqual(["@alice look"]);
  });

  it("frees the name for a new person, or for an agent, with nothing from before", async () => {
    await personConversation();
    removePerson(db, "owner", "colin");
    addPerson(db, "owner", "colin");
    expect(readInbox(db, OWNER_ACCOUNT, "colin", false)).toEqual([]);
    removePerson(db, "owner", "colin");
    const again = await agent("colin");
    expect((await call(again.client, "read_inbox", { unread_only: false })).json).toEqual([]);
    expect(getAgent(db, OWNER_ACCOUNT, "colin")).toMatchObject({ person: false });
  });

  it("leaves a person token unable to send or post as the removed person or a new person of the same name", () => {
    addPerson(db, "owner", "colin");
    const token = addToken(db, "owner", false, false, undefined, "colin");
    const access = accountForToken(db, token.token, "owner-token")!;
    expect(access.person?.name).toBe("colin");
    removePerson(db, "owner", "colin");
    expect(accountForToken(db, token.token, "owner-token")).toBeUndefined();
    addPerson(db, "owner", "colin");
    expect(accountForToken(db, token.token, "owner-token")).toBeUndefined();
    // Even holding the removed row's id, a send or post finds the new colin is another row, and stores nothing.
    expect(() => sendAsPerson(db, OWNER_ACCOUNT, "colin", "all", "hi", access.person!.id)).toThrow(WrongPersonError);
    expect(() => postAsPerson(db, OWNER_ACCOUNT, "colin", "general", "hi", access.person!.id)).toThrow(WrongPersonError);
    expect(db.prepare("SELECT COUNT(*) FROM messages WHERE body = 'hi'").pluck().get()).toBe(0);
    expect(db.prepare("SELECT COUNT(*) FROM channel_posts WHERE body = 'hi'").pluck().get()).toBe(0);
  });

  it("refuses an agent, an unknown name, a removed person and an unknown account, and changes nothing", async () => {
    await personConversation();
    addPerson(db, "owner", "dana");
    removePerson(db, "owner", "dana");
    addPerson(db, "friend", "erin");
    const snapshot = () => ["agents", "messages", "mentions", "channel_posts", "channel_reads", "webhook_deliveries"].map((t) => db.prepare(`SELECT * FROM ${t}`).all());
    const before = snapshot();
    expect(() => removePerson(db, "owner", "Alice")).toThrow("The name 'alice' belongs to an agent, not a person. Remove it with `agent remove`.");
    expect(() => removePerson(db, "owner", "nobody")).toThrow("No person named 'nobody' in account 'owner'.");
    expect(() => removePerson(db, "owner", "dana")).toThrow("No person named 'dana' in account 'owner'.");
    // Another account's person is not one of this account's.
    expect(() => removePerson(db, "owner", "erin")).toThrow("No person named 'erin' in account 'owner'.");
    expect(() => removePerson(db, "nobody", "colin")).toThrow("No account named 'nobody'.");
    expect(() => removePerson(db, "nobody", "colin")).toThrow(PersonError);
    expect(snapshot()).toEqual(before);
    // `agent remove` does not take a removed person for an agent.
    expect(() => purgeAgent(db, "owner", "dana")).toThrow("No agent named 'dana' in account 'owner'.");
    expect(snapshot()).toEqual(before);
  });

  it("leaves the messages of an earlier agent of the same name to `agent remove`", async () => {
    const old = await agent("colin");
    await agent("dave");
    await call(old.client, "send_message", { to: "dave", body: "old colin to dave" });
    await call(old.client, "send_message", { to: "all", body: "old colin to all" });
    expect((await call(old.client, "unregister")).isError).toBe(false);
    // Sent before the person was added, even on a fast clock.
    db.prepare("UPDATE messages SET created_at = created_at - 1000").run();
    await personConversation();

    // The person's: to them, from them, their broadcast's three copies and their copy of alice's.
    expect(removePerson(db, "owner", "colin")).toMatchObject({ messages: 6, mentions: 1 });
    expect(bodies(OWNER_ACCOUNT)).toEqual(["old colin to dave", "old colin to all", "alice to all", "alice to all"]);
    expect(purgeAgent(db, "owner", "colin")).toMatchObject({ messages: 2 });
    expect(bodies(OWNER_ACCOUNT)).toEqual(["alice to all", "alice to all"]);
  });

  it("leaves another account's person and agents of the same names, their messages and mentions untouched", async () => {
    await personConversation(OWNER_ACCOUNT, "owner ");
    await personConversation(friend, "friend ");
    const friendState = () =>
      [
        db.prepare("SELECT m.* FROM messages m JOIN agents a ON a.id = m.recipient_id WHERE a.account_id = ? ORDER BY m.id").all(friend),
        mentionsOf(friend),
        db.prepare("SELECT * FROM agents WHERE account_id = ? ORDER BY id").all(friend),
      ];
    const before = friendState();
    expect(before[0]).toHaveLength(6);
    expect(removePerson(db, "owner", "colin")).toMatchObject({ messages: 5, mentions: 1 });
    expect(friendState()).toEqual(before);
    expect(listPeople(db, "friend").map((p) => p.name)).toEqual(["colin"]);

    // And the other way round.
    expect(removePerson(db, "friend", "colin")).toMatchObject({ account: "friend", messages: 5, mentions: 1 });
    expect(bodies(OWNER_ACCOUNT)).toEqual(["owner alice to all"]);
  });
});

describe("GET /api/agents", () => {
  it("marks a person with person true and never online, and shows another account no person", async () => {
    const token = "owner-token";
    addPerson(db, "owner", "colin");
    registerAgent(db, OWNER_ACCOUNT, "alice", "x");
    const friendToken = addAccount(db, "friend2").token;
    const http = await startHttp(db, { token, port: 0 });
    try {
      const get = async (t: string) =>
        (await (await fetch(`http://127.0.0.1:${http.port}/api/agents`, { headers: { Authorization: `Bearer ${t}` } })).json()) as {
          name: string;
          person: boolean;
          online: boolean;
        }[];
      expect((await get(token)).map((a) => [a.name, a.person, a.online])).toEqual([
        ["alice", false, true],
        ["colin", true, false],
      ]);
      expect(await get(friendToken)).toEqual([]);
    } finally {
      await http.close();
    }
    expect(listAgentsUnread(db, friend, 50, 0)).toEqual([]);
  });
});

describe("an existing database", () => {
  it("gains the person column with every existing agent an agent, unchanged and still working", () => {
    const file = join(mkdtempSync(join(tmpdir(), "message-cp-people-old-")), "db.sqlite");
    const old = openDb(file);
    const { key } = registerAgent(old, OWNER_ACCOUNT, "alice", "old bio");
    registerAgent(old, OWNER_ACCOUNT, "bob", "x");
    sendMessage(old, OWNER_ACCOUNT, "bob", "alice", "kept");
    old.close();
    // Take the column away again, as a database from before people would be.
    const raw = new Database(file);
    raw.exec("ALTER TABLE agents DROP COLUMN person");
    const before = raw.prepare("SELECT * FROM agents ORDER BY id").all();
    raw.close();

    const db2 = openDb(file);
    try {
      const after = db2.prepare("SELECT * FROM agents ORDER BY id").all() as Record<string, unknown>[];
      expect(after).toEqual(before.map((r) => ({ ...(r as object), person: 0 })));
      expect(listAgents(db2, OWNER_ACCOUNT).map((a) => [a.name, a.bio, a.person])).toEqual([
        ["alice", "old bio", false],
        ["bob", "x", false],
      ]);
      expect(() => registerAgent(db2, OWNER_ACCOUNT, "alice", "new", key)).not.toThrow();
      expect(readInbox(db2, OWNER_ACCOUNT, "alice").map((m) => m.body)).toEqual(["kept"]);
    } finally {
      db2.close();
    }
  });
});

describe("message-cp person", () => {
  const root = resolve(import.meta.dirname, "..");
  const cli = (...args: string[]) =>
    spawnSync(join(root, "node_modules/.bin/tsx"), [join(root, "src/cli.ts"), ...args], {
      env: { ...process.env, MESSAGE_CP_DB: dbFile },
      encoding: "utf8",
    });

  it("adds a person to the owner's account by default, or to --account, and lists them with their account", () => {
    const owner = cli("person", "add", "colin");
    expect(owner.status).toBe(0);
    expect(owner.stdout).toBe("");
    expect(owner.stderr).toContain("person 'colin' in account 'owner'");
    const other = cli("person", "add", "dana", "--account", "friend");
    expect(other.status).toBe(0);
    expect(other.stderr).toContain("person 'dana' in account 'friend'");

    const all = cli("person", "list");
    expect(all.status).toBe(0);
    expect(all.stdout.trim().split("\n").map((l) => l.split("\t").slice(0, 2))).toEqual([
      ["dana", "friend"],
      ["colin", "owner"],
    ]);
    expect(cli("person", "list", "--account", "owner").stdout.trim().split("\n").map((l) => l.split("\t")[0])).toEqual(["colin"]);
    // Nothing printed looks like a key or a token.
    for (const out of [owner, other, all]) expect(out.stdout + out.stderr).not.toMatch(/[0-9a-f]{32}/);
  }, 60_000);

  it("fails with exit 1 and a message for a bad name, all, a taken name or an unknown account", () => {
    registerAgent(db, OWNER_ACCOUNT, "alice", "x");
    for (const [args, message] of [
      [["person", "add", "a b"], "Invalid name"],
      [["person", "add", "All"], "'all' is reserved"],
      [["person", "add", "ALICE"], "already used by an agent in account 'owner'"],
      [["person", "add", "colin", "--account", "nobody"], "No account named 'nobody'."],
      [["person", "list", "--account", "nobody"], "No account named 'nobody'."],
    ] as const) {
      const res = cli(...args);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain(message);
    }
    expect(listPeople(db)).toEqual([]);
  }, 60_000);

  it("removes the owner's person by default, or --account's, saying what it removed and printing no body", async () => {
    await personConversation(OWNER_ACCOUNT, "secret-owner ");
    await personConversation(friend, "secret-friend ");
    const res = cli("person", "remove", "Colin");
    expect(res.status).toBe(0);
    expect(res.stdout).toBe("");
    expect(res.stderr).toBe("message-cp: removed person 'colin' of account 'owner', with 5 direct message(s) and 1 mention(s). The name is free.\n");
    expect(bodies(OWNER_ACCOUNT)).toEqual(["secret-owner alice to all"]);
    expect(bodies(friend)).toHaveLength(6);

    const other = cli("person", "remove", "colin", "--account", "friend");
    expect(other.status).toBe(0);
    expect(other.stderr).toContain("removed person 'colin' of account 'friend', with 5 direct message(s) and 1 mention(s)");
    expect(bodies(friend)).toEqual(["secret-friend alice to all"]);
    for (const out of [res, other]) expect(out.stderr).not.toContain("secret");
  }, 60_000);

  it("fails person remove with exit 1 and a reason for an agent, an unknown name or an unknown account", () => {
    addPerson(db, "owner", "colin");
    registerAgent(db, OWNER_ACCOUNT, "alice", "x");
    sendAsPerson(db, OWNER_ACCOUNT, "colin", "alice", "hello");
    const snapshot = () => ["agents", "messages", "mentions"].map((t) => db.prepare(`SELECT * FROM ${t}`).all());
    const before = snapshot();
    for (const [args, message] of [
      [["person", "remove", "alice"], "The name 'alice' belongs to an agent, not a person."],
      [["person", "remove", "nobody"], "No person named 'nobody' in account 'owner'."],
      [["person", "remove", "colin", "--account", "friend"], "No person named 'colin' in account 'friend'."],
      [["person", "remove", "colin", "--account", "nobody"], "No account named 'nobody'."],
    ] as const) {
      const res = cli(...args);
      expect(res.status).toBe(1);
      expect(res.stdout).toBe("");
      expect(res.stderr).toContain(message);
    }
    expect(snapshot()).toEqual(before);
  }, 60_000);

  it("prints its usage and exits 2 for anything else", () => {
    for (const args of [["person"], ["person", "add"], ["person", "add", "--account", "owner"], ["person", "add", "c", "--bio", "x"], ["person", "list", "--account"], ["person", "remove"], ["person", "remove", "--account", "owner"], ["person", "remove", "c", "--key", "x"], ["person", "rename", "c"]]) {
      const res = cli(...args);
      expect(res.status).toBe(2);
      expect(res.stderr).toContain("usage: message-cp person add <name> [--account <name>] | message-cp person remove <name> [--account <name>]");
    }
    expect(cli("nope").stderr).toContain("Commands: serve, wait, account, token, webhook, person");
  }, 120_000);
});
