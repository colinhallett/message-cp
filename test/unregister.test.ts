import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAgent, registerFromEnv, removeAgent } from "../src/agents.js";
import { unreadSummary } from "../src/messages.js";
import { OWNER_ACCOUNT, openDb, type Db } from "../src/db.js";
import { Session, createServer } from "../src/server.js";

let dbFile: string;
let db: Db;
const clients: Client[] = [];

beforeEach(() => {
  dbFile = join(mkdtempSync(join(tmpdir(), "message-cp-unreg-")), "db.sqlite");
  db = openDb(dbFile);
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  db.close();
});

// Each call is a separate server with its own connection to the one file, like a separate process.
async function connect(session = new Session(OWNER_ACCOUNT)): Promise<Client> {
  const server = createServer(openDb(dbFile), session);
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

/** Registers `name` on a new session and returns the client and the key it was given. */
async function agent(name: string, key?: string) {
  const client = await connect();
  const res = await call(client, "register", { name, bio: "x", ...(key ? { key } : {}) });
  return { client, key: key ?? (res.json.key as string) };
}

const count = (sql: string, ...p: unknown[]) => (db.prepare(sql).get(...p) as { n: number }).n;
const REGISTER_FIRST = /Call `register` first/;

describe("unregister", () => {
  it("with no arguments removes the caller, who must then register again", async () => {
    const a = await agent("alice");
    const res = await call(a.client, "unregister");
    expect(res.json.removed).toBe("alice");
    expect(count("SELECT COUNT(*) AS n FROM agents WHERE removed_at IS NULL")).toBe(0);
    const next = await call(a.client, "read_inbox");
    expect(next.isError).toBe(true);
    expect(next.text).toMatch(REGISTER_FIRST);
    expect((await call(a.client, "register", { name: "alice", bio: "again" })).isError).toBe(false);
    expect((await call(a.client, "read_inbox")).isError).toBe(false);
  });

  it("with its own name and key removes the caller the same way", async () => {
    const a = await agent("alice");
    expect((await call(a.client, "unregister", { name: "alice", key: a.key })).isError).toBe(false);
    expect((await call(a.client, "read_inbox")).text).toMatch(REGISTER_FIRST);
  });

  it("removes another agent only with its key", async () => {
    const a = await agent("alice");
    const b = await agent("bob");
    for (const args of [{ name: "alice" }, { name: "alice", key: "wrong" }]) {
      const res = await call(b.client, "unregister", args);
      expect(res.isError).toBe(true);
      expect(res.text).not.toContain(a.key);
      expect(count("SELECT COUNT(*) AS n FROM agents WHERE name = 'alice' AND removed_at IS NULL")).toBe(1);
    }
    expect((await call(b.client, "unregister", { name: "alice", key: a.key })).json.removed).toBe("alice");
    expect(count("SELECT COUNT(*) AS n FROM agents WHERE name = 'alice' AND removed_at IS NULL")).toBe(0);
    // bob is untouched
    expect((await call(b.client, "read_inbox")).isError).toBe(false);
    // and alice's own session is now unregistered
    expect((await call(a.client, "read_inbox")).text).toMatch(REGISTER_FIRST);
  });

  it("removes an agent that has no key by name alone", async () => {
    const b = await agent("bob");
    db.prepare("INSERT INTO agents (account_id, name, bio, registered_at, last_seen) VALUES (1, 'old', '', 1, 1)").run();
    expect((await call(b.client, "unregister", { name: "old" })).isError).toBe(false);
    expect(count("SELECT COUNT(*) AS n FROM agents WHERE name = 'old' AND removed_at IS NULL")).toBe(0);
  });

  it("errors for an unknown name", async () => {
    const b = await agent("bob");
    expect((await call(b.client, "unregister", { name: "nobody", key: "k" })).isError).toBe(true);
  });

  it("needs a registered session, except for a name with its key", async () => {
    const a = await agent("alice");
    const anon = await connect();
    expect((await call(anon, "unregister")).text).toMatch(REGISTER_FIRST);
    expect((await call(anon, "unregister", { name: "alice" })).text).toMatch(REGISTER_FIRST);
    expect((await call(anon, "unregister", { name: "alice", key: "wrong" })).isError).toBe(true);
    expect(count("SELECT COUNT(*) AS n FROM agents WHERE removed_at IS NULL")).toBe(1);
    expect((await call(anon, "unregister", { name: "alice", key: a.key })).isError).toBe(false);
    expect(count("SELECT COUNT(*) AS n FROM agents WHERE removed_at IS NULL")).toBe(0);
  });

  it("keeps the messages addressed to the agent, unchanged, and shows them to no one", async () => {
    const a = await agent("alice");
    const b = await agent("bob");
    await call(b.client, "send_message", { to: "alice", body: "read one" });
    await call(a.client, "read_inbox");
    await call(b.client, "send_message", { to: "alice", body: "unread one" });
    await call(b.client, "send_message", { to: "all", body: "to everyone" });
    await call(a.client, "send_message", { to: "bob", body: "keep me" });
    const id = (db.prepare("SELECT id FROM agents WHERE name = 'alice'").get() as { id: number }).id;
    const messages = () => db.prepare("SELECT * FROM messages ORDER BY id").all();
    const before = messages();

    const res = await call(a.client, "unregister");
    expect(res.json).toEqual({ removed: "alice", keptMessages: 3 });
    expect(messages()).toEqual(before);
    expect(db.prepare("SELECT name, removed_name FROM agents WHERE id = ?").get(id)).toEqual({
      name: `removed:${id}`,
      removed_name: "alice",
    });

    // The name is free at once, in any case, and the new agent starts with an empty inbox.
    const again = await agent("ALICE");
    expect((await call(again.client, "read_inbox", { unread_only: false })).json).toEqual([]);
    expect(messages()).toEqual(before);
    expect((await call(b.client, "read_inbox")).json).toHaveLength(1);
  });

  it("makes the agent invisible to every tool", async () => {
    const a = await agent("alice");
    const b = await agent("bob");
    await call(b.client, "send_message", { to: "alice", body: "hello" });
    await call(a.client, "unregister");
    expect((await call(b.client, "list_agents")).json.map((x: { name: string }) => x.name)).toEqual(["bob"]);
    expect((await call(b.client, "get_agent", { name: "alice" })).isError).toBe(true);
    expect((await call(b.client, "send_message", { to: "alice", body: "x" })).isError).toBe(true);
    expect((await call(b.client, "send_message", { to: "all", body: "x" })).json).toEqual({ delivered: 0, recipients: [] });
    expect((await call(b.client, "unregister", { name: "alice" })).text).toMatch(/No agent named/);
    expect((await call(a.client, "read_inbox")).text).toMatch(REGISTER_FIRST);
    expect(unreadSummary(db, OWNER_ACCOUNT, "alice")).toBeUndefined();
    // Nor can anyone reach the row by its placeholder name.
    const id = (db.prepare("SELECT id FROM agents WHERE removed_name = 'alice'").get() as { id: number }).id;
    expect(getAgent(db, OWNER_ACCOUNT, `removed:${id}`)).toBeUndefined();
    expect(unreadSummary(db, OWNER_ACCOUNT, `removed:${id}`)).toBeUndefined();
    expect((await call(b.client, "register", { name: `removed:${id}`, bio: "x" })).isError).toBe(true);
  });

  it("keeps a removed agent out of reach of a release that does not know about removals", async () => {
    const session = new Session(OWNER_ACCOUNT);
    const a = await connect(session);
    await call(a, "register", { name: "alice", bio: "x" });
    const stale = session.registration!;
    const b = await agent("bob");
    await call(b.client, "send_message", { to: "alice", body: "hello" });
    await call(a, "unregister");
    // The previous release finds an agent by name, checking its key, or by a session's (id, registered_at, instance).
    // Neither reaches the row any more, so it can neither read nor delete the messages kept with it.
    const row = db.prepare("SELECT name, key_hash FROM agents WHERE id = ?").get(stale.id) as { name: string; key_hash: string };
    expect(row.name).toBe(`removed:${stale.id}`);
    expect(row.key_hash).not.toMatch(/^[0-9a-f]{64}$/);
    expect(
      db.prepare("SELECT id FROM agents WHERE id = ? AND registered_at = ? AND instance IS ?").get(stale.id, stale.registeredAt, stale.instance),
    ).toBeUndefined();
  });
});

describe("a session whose agent was removed", () => {
  it("is unregistered even if another session took the name over first", async () => {
    const a = await agent("alice");
    const other = await connect();
    // Takes the name over with the key, as a restarted process would.
    await call(other, "register", { name: "alice", bio: "x", key: a.key });
    expect((await call(a.client, "read_inbox")).isError).toBe(false); // a takeover keeps the registration
    await call(other, "unregister");
    expect((await call(a.client, "read_inbox")).text).toMatch(REGISTER_FIRST);
    expect((await call(other, "read_inbox")).text).toMatch(REGISTER_FIRST);
  });

  it("never acts as a different agent registered under the same name", async () => {
    const a = await agent("alice");
    const b = await agent("bob");
    await call(b.client, "unregister", { name: "alice", key: a.key });
    const newcomer = await agent("alice");
    expect(newcomer.key).not.toBe(a.key);
    await call(newcomer.client, "send_message", { to: "bob", body: "from the new alice" });
    expect((await call(a.client, "read_inbox")).text).toMatch(REGISTER_FIRST);
    expect((await call(a.client, "send_message", { to: "bob", body: "x" })).text).toMatch(REGISTER_FIRST);
    expect(count("SELECT COUNT(*) AS n FROM messages")).toBe(1);
  });

  it("is not fooled by a new registration that reuses the id and the timestamp", async () => {
    const a = await agent("alice");
    const row = db.prepare("SELECT id, registered_at FROM agents WHERE name = 'alice' AND removed_at IS NULL").get() as { id: number; registered_at: number };
    db.prepare("DELETE FROM agents WHERE id = ?").run(row.id);
    db.prepare("INSERT INTO agents (id, account_id, name, bio, registered_at, last_seen, instance) VALUES (?, 1, 'alice', '', ?, ?, 'other')").run(
      row.id,
      row.registered_at,
      row.registered_at,
    );
    expect((await call(a.client, "read_inbox")).text).toMatch(REGISTER_FIRST);
  });

  it("self-unregister never removes a different agent that took the name after the check", async () => {
    const a = await agent("alice");
    const session = new Session(OWNER_ACCOUNT);
    const c = await connect(session);
    await call(c, "register", { name: "carol", bio: "x" });
    const stale = session.registration!;
    // carol removed behind the session's back and registered again by someone else
    db.prepare("DELETE FROM agents WHERE name = 'carol'").run();
    const other = await agent("carol");
    expect(() => removeAgent(db, OWNER_ACCOUNT, "carol", undefined, stale)).toThrow(REGISTER_FIRST);
    expect(count("SELECT COUNT(*) AS n FROM agents WHERE name = 'carol'")).toBe(1);
    expect((await call(other.client, "read_inbox")).isError).toBe(false);
    expect((await call(a.client, "read_inbox")).isError).toBe(false);
  });

  it("also applies to a session started from MESSAGE_CP_AGENT", async () => {
    const env = { MESSAGE_CP_AGENT: "worker", MESSAGE_CP_AGENT_KEY: "k" };
    const session = new Session(OWNER_ACCOUNT);
    session.bind(registerFromEnv(db, OWNER_ACCOUNT, env)!.identity);
    const w = await connect(session);
    expect((await call(w, "read_inbox")).isError).toBe(false);
    const b = await agent("bob");
    await call(b.client, "unregister", { name: "worker", key: "k" });
    expect((await call(w, "read_inbox")).text).toMatch(REGISTER_FIRST);
  });
});
