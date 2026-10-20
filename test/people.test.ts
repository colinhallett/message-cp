import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addAccount, listAccounts } from "../src/accounts.js";
import {
  PersonError,
  ToolError,
  addPerson,
  getAgent,
  identityOf,
  listAgents,
  listPeople,
  nameOfIdentity,
  registerAgent,
  registerFromEnv,
} from "../src/agents.js";
import { OWNER_ACCOUNT, openDb, type AccountId, type Db } from "../src/db.js";
import { startHttp } from "../src/http.js";
import { listAgentsUnread, readInbox, sendMessage } from "../src/messages.js";
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
    expect((await call(client, "send_message", { to: "Colin", body: "hello" })).json).toEqual({ delivered: 1, recipients: ["colin"] });
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
    expect((await call(client, "send_message", { to: "all", body: "hi all" })).json).toEqual({ delivered: 2, recipients: ["bob", "colin"] });
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
    expect((await call(client, "send_message", { to: "all", body: "hi all" })).json).toEqual({ delivered: 0, recipients: [] });
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

  it("prints its usage and exits 2 for anything else", () => {
    for (const args of [["person"], ["person", "add"], ["person", "add", "--account", "owner"], ["person", "add", "c", "--bio", "x"], ["person", "list", "--account"], ["person", "remove", "c"]]) {
      const res = cli(...args);
      expect(res.status).toBe(2);
      expect(res.stderr).toContain("usage: message-cp person add <name>");
    }
    expect(cli("nope").stderr).toContain("Commands: serve, wait, account, token, webhook, person");
  }, 120_000);
});
