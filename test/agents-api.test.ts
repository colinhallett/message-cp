import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addAccount, addToken, listAccounts, revokeToken } from "../src/accounts.js";
import { addPerson, purgeAgent, setPersonAdmin } from "../src/agents.js";
import { connectAgent } from "../src/connect.js";
import { OWNER_ACCOUNT, openDb, type AccountId, type Db } from "../src/db.js";
import { startHttp, type HttpServer } from "../src/http.js";
import { COUNT_AGENT_TOKENS, NotAdminError, removeAgentBy, resetAgentKeyBy } from "../src/login.js";
import { Session, createServer } from "../src/server.js";
import { addWebhook } from "../src/webhooks.js";

// An admin person's token removes an agent (DELETE /api/agents?name=) and gives it a new key (POST /api/agents/key?name=),
// on a server with the owner's account and a friend's.
const OWNER_TOKEN = "owner-token";
let dbFile: string;
let db: Db;
let http: HttpServer;
let friend: AccountId;
let ana: string;
const clients: Client[] = [];

const start = async (options: { maxSessions?: number } = {}) => {
  http = await startHttp(db, { token: OWNER_TOKEN, port: 0, waitHoldMs: 0, ...options });
};

beforeEach(async () => {
  dbFile = join(mkdtempSync(join(tmpdir(), "message-cp-agents-api-")), "db.sqlite");
  db = openDb(dbFile);
  addAccount(db, "friend");
  friend = listAccounts(db).find((a) => a.name === "friend")!.id;
  addPerson(db, "owner", "ana", true);
  ana = personToken("owner", "ana");
  await start();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await http.close();
  db.close();
});

const personToken = (account: string, name: string) => addToken(db, account, false, false, undefined, name).token;
const base = () => `http://127.0.0.1:${http.port}`;
const call = (path: string, token: string | null, method = "GET") =>
  fetch(`${base()}${path}`, { method, headers: { ...(token !== null && { Authorization: `Bearer ${token}` }) } });
const remove = (name: string, token = ana) => call(`/api/agents?name=${encodeURIComponent(name)}`, token, "DELETE");
const reset = (name: string, token = ana) => call(`/api/agents/key?name=${encodeURIComponent(name)}`, token, "POST");
const message = async (res: Response) => ((await res.json()) as { error: { message: string } }).error.message;
const rows = (sql: string, ...p: unknown[]) => db.prepare(sql).all(...p);
const idOf = (account: AccountId, name: string) =>
  db.prepare("SELECT id FROM agents WHERE account_id = ? AND name = ?").pluck().get(account, name) as number;
/** Everything removing an agent or resetting a key could change. */
const snapshot = () =>
  Object.fromEntries(
    ["agents", "messages", "mentions", "channels", "channel_posts", "channel_reads", "webhooks", "webhook_deliveries"].map((t) => [
      t,
      rows(`SELECT * FROM ${t} ORDER BY rowid`),
    ]),
  );

/** A real MCP server and client joined in-process, acting as `account`, with its own connection to the file. */
async function connect(account: AccountId = OWNER_ACCOUNT): Promise<Client> {
  const server = createServer(openDb(dbFile), new Session(account));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  clients.push(client);
  return client;
}

async function tool(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  const text = res.content[0].text;
  return { isError: !!res.isError, text, json: res.isError ? undefined : JSON.parse(text) };
}

async function agent(name: string, account: AccountId = OWNER_ACCOUNT) {
  const client = await connect(account);
  const res = await tool(client, "register", { name, bio: "x" });
  expect(res.isError).toBe(false);
  return { client, key: res.json.key as string };
}

/** alice and bob in `account`: a message each way, a broadcast from alice (to bob and any person), a mention of each, and webhooks on alice's mail. */
async function conversation(account: AccountId = OWNER_ACCOUNT) {
  const accountName = listAccounts(db).find((a) => a.id === account)!.name;
  addWebhook(db, accountName, "https://example.com/", "agent:alice", true);
  addWebhook(db, accountName, "https://example.com/", "agent:bob", true);
  const alice = await agent("alice", account);
  const bob = await agent("bob", account);
  await tool(alice.client, "join_channel", { channel: "general" });
  await tool(bob.client, "send_message", { to: "alice", body: "secret to alice" });
  await tool(alice.client, "send_message", { to: "bob", body: "secret to bob" });
  await tool(alice.client, "send_message", { to: "all", body: "secret alice to all" });
  await tool(bob.client, "post", { channel: "general", body: "@alice look" });
  await tool(alice.client, "post", { channel: "general", body: "@bob look" });
  return { alice, bob };
}

describe("DELETE /api/agents", () => {
  it("removes a live agent with its direct messages, their webhook deliveries and its mentions, and frees its name", async () => {
    const { alice, bob } = await conversation();
    const id = idOf(OWNER_ACCOUNT, "alice");
    const posts = rows("SELECT * FROM channel_posts ORDER BY id");
    expect(rows("SELECT * FROM webhook_deliveries")).not.toEqual([]);

    const res = await remove("ALICE");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ name: "alice", messages: 4, mentions: 1, tokens: 0 });
    expect(text).not.toContain("secret");

    expect(rows("SELECT body FROM messages")).toEqual([]);
    expect(rows("SELECT * FROM webhook_deliveries WHERE message_id IS NOT NULL")).toEqual([]);
    expect(rows("SELECT * FROM mentions WHERE agent_id = ?", id)).toEqual([]);
    expect(rows("SELECT * FROM mentions")).toHaveLength(1);
    expect(rows("SELECT * FROM channel_posts ORDER BY id")).toEqual(posts);
    // The session acting as alice is unregistered, bob's is not, and the name registers again as a new agent.
    expect((await tool(alice.client, "read_inbox")).text).toMatch(/Call `register` first/);
    expect((await tool(bob.client, "read_inbox", { unread_only: false })).json.map((m: { body: string }) => m.body)).toEqual(["@bob look"]);
    const names = ((await (await call("/api/agents", ana)).json()) as { name: string }[]).map((a) => a.name);
    expect(names).not.toContain("alice");
    const again = await agent("alice");
    expect((await tool(again.client, "read_inbox", { unread_only: false })).json).toEqual([]);
  });

  it("removes an agent only left as removed rows, as purgeAgent does", async () => {
    const first = await agent("alice");
    const bob = await agent("bob");
    await tool(bob.client, "send_message", { to: "alice", body: "to the first" });
    await tool(first.client, "send_message", { to: "bob", body: "from the first" });
    await tool(first.client, "unregister");
    const res = await remove("alice");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "alice", messages: 2, mentions: 0, tokens: 0 });
    expect(rows("SELECT body FROM messages")).toEqual([]);
  });

  it("counts the live agent's unrevoked connect tokens, which stop working, revoking nothing", async () => {
    const live = connectAgent(db, "owner", "writer", false);
    const revoked = connectAgent(db, "owner", "writer", true);
    const other = connectAgent(db, "owner", "editor", false);
    revokeToken(db, revoked.tokenId);
    expect((await call("/mcp", live.token, "POST")).status).not.toBe(401);
    const tokens = () => rows("SELECT id, account_id, hash, agent_id, revoked_at FROM tokens ORDER BY id");
    const before = tokens();
    const res = await remove("writer");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ name: "writer", messages: 0, mentions: 0, tokens: 1 });
    for (const secret of [live.token, live.key, revoked.token]) expect(text).not.toContain(secret);
    expect((await call("/mcp", live.token, "POST")).status).toBe(401);
    expect((await call("/mcp", other.token, "POST")).status).not.toBe(401);
    // Nothing is revoked: the agent's removal is what refuses its tokens.
    expect(tokens()).toEqual(before);
  });

  it("counts 0 for an agent left only as removed rows, whose tokens already stopped", async () => {
    connectAgent(db, "owner", "writer", false);
    purgeAgent(db, "owner", "writer");
    expect(await (await remove("writer")).json()).toMatchObject({ name: "writer", tokens: 0 });
  });

  it("never counts or changes another account's tokens, an agent of the same name's included", async () => {
    connectAgent(db, "owner", "writer", false);
    const theirs = connectAgent(db, "friend", "writer", false);
    const before = rows("SELECT id, account_id, hash, agent_id, revoked_at FROM tokens ORDER BY id");
    expect(await (await remove("writer")).json()).toMatchObject({ tokens: 1 });
    expect(rows("SELECT id, account_id, hash, agent_id, revoked_at FROM tokens ORDER BY id")).toEqual(before);
    expect((await call("/mcp", theirs.token, "POST")).status).not.toBe(401);
    // Called directly with the friend's agent row but the owner's account, nothing of the friend's is counted.
    const fay = idOf(friend, "writer");
    expect(db.prepare(COUNT_AGENT_TOKENS).pluck().get(fay, OWNER_ACCOUNT)).toBe(0);
    expect(db.prepare(COUNT_AGENT_TOKENS).pluck().get(fay, friend)).toBe(1);
  });

  it("takes no slot, so a full cap of held POST bodies does not refuse it", async () => {
    await http.close();
    await start({ maxSessions: 1 });
    await agent("alice");
    const held = request(`${base()}/api/send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ana}`, "Content-Type": "application/json", "Content-Length": "1000" },
    });
    const answered = new Promise<number>((resolve, reject) => {
      held.on("response", (r) => {
        r.resume();
        resolve(r.statusCode!);
      });
      held.on("error", reject);
    });
    held.write("{");
    await new Promise((r) => setTimeout(r, 200));
    expect((await reset("alice")).status).toBe(200);
    expect((await remove("alice")).status).toBe(200);
    held.end(" ".repeat(999));
    expect(await answered).toBe(400);
  });
});

describe("POST /api/agents/key", () => {
  it("answers a new key once, never cached, ending the agent's sessions and keeping its messages, mentions, channels and webhooks", async () => {
    const { alice, bob } = await conversation();
    const before = snapshot();
    const oldHash = db.prepare("SELECT key_hash FROM agents WHERE name = 'alice'").pluck().get();

    const res = await reset("Alice");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const answer = (await res.json()) as { name: string; key: string };
    expect(answer).toEqual({ name: "alice", key: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(answer.key).not.toBe(alice.key);
    const after = snapshot();
    const keyless = (s: ReturnType<typeof snapshot>) => ({
      ...s,
      agents: (s.agents as Record<string, unknown>[]).map(({ key_hash, instance, ...a }) => a),
    });
    expect(keyless(after)).toEqual(keyless(before));
    expect(db.prepare("SELECT key_hash FROM agents WHERE name = 'alice'").pluck().get()).not.toBe(oldHash);
    expect(JSON.stringify(after)).not.toContain(answer.key);

    // The session acting as alice is ended, bob's is not.
    expect((await tool(alice.client, "read_inbox")).text).toMatch(/Call `register` first/);
    expect((await tool(bob.client, "read_inbox")).isError).toBe(false);
    // The old key is refused at once, and the new one takes the agent over with its inbox as it was.
    const other = await connect();
    expect((await tool(other, "register", { name: "alice", bio: "x", key: alice.key })).text).toMatch(/already registered and has a key/);
    expect((await tool(other, "register", { name: "alice", bio: "x", key: answer.key })).isError).toBe(false);
    const inbox = (await tool(other, "read_inbox", { unread_only: false })).json.map((m: { body: string }) => m.body);
    expect(inbox).toEqual(expect.arrayContaining(["secret to alice", "@alice look"]));
  });
});

describe("who reaches DELETE /api/agents and POST /api/agents/key", () => {
  const both = [remove, reset] as const;

  it("answers 404, changing nothing, for an unknown name, a person's, another account's agent's, or a removed agent's key", async () => {
    addPerson(db, "owner", "ben");
    await agent("fay", friend);
    const gone = await agent("gil");
    await tool(gone.client, "unregister");
    const before = snapshot();
    for (const name of ["nobody", "ben", "Ana", "fay"]) {
      for (const route of both) {
        const res = await route(name);
        expect(res.status, `${route === remove ? "remove" : "reset"} ${name}`).toBe(404);
        expect(await message(res)).toBe("No such agent");
      }
    }
    expect((await reset("gil")).status).toBe(404);
    expect(snapshot()).toEqual(before);
  });

  it("keeps a second account's admin out of the first account, with the same 404 as an unknown name", async () => {
    await agent("alice");
    addPerson(db, "friend", "fay", true);
    const fay = personToken("friend", "fay");
    const before = snapshot();
    for (const route of both) expect(await message(await route("alice", fay))).toBe("No such agent");
    expect(snapshot()).toEqual(before);
    await agent("alice", friend);
    expect((await remove("alice", fay)).status).toBe(200);
    expect(idOf(OWNER_ACCOUNT, "alice")).toBeDefined();
  });

  it("answers 400 for a missing, repeated or empty name", async () => {
    await agent("alice");
    const before = snapshot();
    for (const query of ["", "?name=", "?name=alice&name=alice", "?other=alice"]) {
      for (const [path, method] of [
        ["/api/agents", "DELETE"],
        ["/api/agents/key", "POST"],
      ]) {
        const res = await call(`${path}${query}`, ana, method);
        expect(res.status, `${method} ${path}${query}`).toBe(400);
        expect(await message(res)).toBe("Give name once");
      }
    }
    expect(snapshot()).toEqual(before);
  });

  it("refuses a plain person, read-only, agent and full token with 403, closing the connection, and changes nothing", async () => {
    await agent("alice");
    addPerson(db, "owner", "ben");
    const tokens = [
      [personToken("owner", "ben"), "A person token only reads, sends and posts"],
      [addToken(db, "owner", true).token, "This token is read-only"],
      [addToken(db, "owner", false, true).token, "Agent tokens cannot use the dashboard API"],
      [OWNER_TOKEN, /^A full token cannot remove agents or reset their keys\. Run message-cp agent remove/],
    ] as const;
    const before = snapshot();
    for (const [token, expected] of tokens) {
      for (const route of both) {
        const res = await route("alice", token);
        expect(res.status).toBe(403);
        expect(res.headers.get("connection")).toBe("close");
        const text = await message(res);
        if (typeof expected === "string") expect(text).toBe(expected);
        else expect(text).toMatch(expected);
      }
    }
    expect((await remove("alice", "wrong")).status).toBe(401);
    expect(snapshot()).toEqual(before);
  });

  it("refuses an admin's token with 403 once they are marked not admin", async () => {
    await agent("alice");
    setPersonAdmin(db, "owner", "ana", false);
    for (const route of both) {
      const res = await route("alice");
      expect(res.status).toBe(403);
      expect(await message(res)).toBe("A person token only reads, sends and posts");
    }
    expect(idOf(OWNER_ACCOUNT, "alice")).toBeDefined();
  });

  it("refuses with 403, changing nothing, an admin unmarked or removed between the token check and the change", async () => {
    await agent("alice");
    const before = snapshot();
    for (const change of ["UPDATE agents SET admin = 0 WHERE name = 'ana'", "UPDATE agents SET removed_at = 1 WHERE name = 'ana'"]) {
      for (const route of both) {
        const prepare = db.prepare.bind(db);
        // Just before the admin's row is checked inside the transaction, as another process would between the two.
        const spy = vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
          if (sql.includes("person = 1 AND admin = 1")) prepare(change).run();
          return prepare(sql);
        }) as typeof db.prepare);
        const res = await route("alice");
        spy.mockRestore();
        expect(res.status).toBe(403);
        expect(await message(res)).toBe("This person is no longer an admin of the account");
        // The transaction rolled back, the change above with it.
        expect(snapshot()).toEqual(before);
      }
    }
  });

  it("refuses removeAgentBy and resetAgentKeyBy for anyone who is not a live admin of the account", async () => {
    await agent("alice");
    addPerson(db, "owner", "ben");
    addPerson(db, "friend", "fay", true);
    const before = snapshot();
    for (const by of [idOf(OWNER_ACCOUNT, "ben"), idOf(friend, "fay"), idOf(OWNER_ACCOUNT, "alice"), 9999]) {
      expect(() => removeAgentBy(db, OWNER_ACCOUNT, by, "alice")).toThrow(NotAdminError);
      expect(() => resetAgentKeyBy(db, OWNER_ACCOUNT, by, "alice")).toThrow(NotAdminError);
    }
    expect(snapshot()).toEqual(before);
  });

  it("answers 503 with Retry-After when the database is busy, changing nothing", async () => {
    await agent("alice");
    const before = snapshot();
    for (const route of both) {
      const prepare = db.prepare.bind(db);
      const spy = vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
        if (sql.includes("person = 1 AND admin = 1")) throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
        return prepare(sql);
      }) as typeof db.prepare);
      const res = await route("alice");
      spy.mockRestore();
      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe("1");
    }
    expect(snapshot()).toEqual(before);
  });

  it("answers 405 for another method", async () => {
    let res = await call("/api/agents?name=alice", ana, "PUT");
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, DELETE");
    res = await call("/api/agents/key?name=alice", ana);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  it("keeps GET /api/agents answering every token that reached it before", async () => {
    await agent("alice");
    addPerson(db, "owner", "ben");
    for (const token of [OWNER_TOKEN, addToken(db, "owner", true).token, personToken("owner", "ben"), ana]) {
      const res = await call("/api/agents", token);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { name: string }[]).map((a) => a.name)).toEqual(["alice", "ana", "ben"]);
    }
    expect((await call("/api/agents", addToken(db, "owner", false, true).token)).status).toBe(403);
  });
});

describe("the plans of removing an agent", () => {
  it("counts its tokens through tokens_live_by_agent, without scanning tokens", () => {
    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${COUNT_AGENT_TOKENS}`).all(1, 1) as { detail: string }[]).map((p) => p.detail);
    expect(plan).toEqual(["SEARCH tokens USING INDEX tokens_live_by_agent (agent_id=?)"]);
  });

  it("deletes its messages through messages_history and messages_by_sender, and their deliveries and replies by index, never scanning", () => {
    const prepare = db.prepare.bind(db);
    const sql: string[] = [];
    const spy = vi.spyOn(db, "prepare").mockImplementation(((s: string) => {
      sql.push(s);
      return prepare(s);
    }) as typeof db.prepare);
    expect(() => purgeAgent(db, "owner", "nobody")).toThrow();
    addPerson(db, "owner", "zed");
    db.prepare("INSERT INTO agents (account_id, name, bio, registered_at, last_seen, person) VALUES (?, 'alice', '', 0, 0, 0)").run(OWNER_ACCOUNT);
    purgeAgent(db, "owner", "alice");
    spy.mockRestore();
    const plans = [...new Set(sql)].map((s) =>
      (db.prepare(`EXPLAIN QUERY PLAN ${s}`).all(...Array.from(s.matchAll(/\?/g), () => null)) as { detail: string }[]).map((r) => r.detail),
    );
    for (const plan of plans) expect(plan.filter((d) => d.startsWith("SCAN"))).toEqual([]);
    const deletes = plans.filter((p) => p[0]?.startsWith("SEARCH messages USING"));
    expect(deletes.map((p) => p[0])).toEqual([
      "SEARCH messages USING COVERING INDEX messages_history (recipient_id=?)",
      "SEARCH messages USING COVERING INDEX messages_by_sender (recipient_id=? AND sender=?)",
    ]);
    for (const p of deletes) {
      expect(p).toContain("SEARCH webhook_deliveries USING COVERING INDEX webhook_deliveries_by_message (message_id=?)");
      expect(p).toContain("SEARCH messages USING COVERING INDEX messages_by_reply (in_reply_to=?)");
    }
  });
});
