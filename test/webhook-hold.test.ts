import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtempSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addAccount } from "../src/accounts.js";
import { WAIT_MARK_MS, identityOf, markWaiting, registerAgent, removeAgent } from "../src/agents.js";
import { post, type Member } from "../src/channels.js";
import { OWNER_ACCOUNT, openDb, type AccountId, type Db } from "../src/db.js";
import { startHttp, type HttpServer } from "../src/http.js";
import { readInbox, sendMessage } from "../src/messages.js";
import { addWebhook, sendPending } from "../src/webhooks.js";

// A message or mention to an agent that is waiting for mail holds its webhook delivery while the wait lasts, so a
// standing agent's reply does not also start a second run; the delivery goes out once the wait ends unread, and is
// dropped if the agent read it.
let db: Db;
let bobKey: string;
const servers: Server[] = [];

beforeEach(() => {
  db = openDb(join(mkdtempSync(join(tmpdir(), "message-cp-hold-")), "db.sqlite"));
  registerAgent(db, OWNER_ACCOUNT, "alice", "sender");
  bobKey = registerAgent(db, OWNER_ACCOUNT, "bob", "waits").key!;
  return async () => {
    for (const s of servers.splice(0)) {
      s.closeAllConnections();
      await new Promise((r) => s.close(r));
    }
    db.close();
  };
});

/** A receiver on 127.0.0.1 answering 200 and keeping each body it got. */
async function receiver() {
  const got: { text?: string; sender: string; recipient?: string }[] = [];
  const server = createHttpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      got.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      res.writeHead(200).end();
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { got, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook` };
}

const member = (account: AccountId, name: string): Member => ({ ...identityOf(db, account, name)!, name });
const deliveries = () => db.prepare("SELECT held_for, attempts, delivered_at FROM webhook_deliveries ORDER BY id").all();
/** Ends bob's wait as if its mark had run out `ms` ago, as when the process holding it crashed. */
const expire = (account = OWNER_ACCOUNT, name = "bob", ms = 1) =>
  db.prepare("UPDATE agents SET waiting_until = ? WHERE account_id = ? AND name = ?").run(Date.now() - ms, account, name);

describe("held deliveries", () => {
  it("sends a message to an agent that is not waiting exactly as before", async () => {
    const r = await receiver();
    addWebhook(db, "owner", r.url, "agent:bob", true);
    sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "hi");
    expect(deliveries()).toEqual([{ held_for: null, attempts: 0, delivered_at: null }]);
    expect(await sendPending(db)).toEqual({ delivered: 1, failed: 0 });
    expect(r.got.map((g) => g.text)).toEqual(["hi"]);
  });

  it("holds a message to a waiting agent, and drops it unsent once the agent reads it", async () => {
    const r = await receiver();
    addWebhook(db, "owner", r.url, "agent:bob", true);
    markWaiting(db, OWNER_ACCOUNT, identityOf(db, OWNER_ACCOUNT, "bob")!);
    sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "reply");
    expect(await sendPending(db)).toEqual({ delivered: 0, failed: 0 });
    expect(deliveries()).toMatchObject([{ attempts: 0, delivered_at: null }]);
    readInbox(db, OWNER_ACCOUNT, identityOf(db, OWNER_ACCOUNT, "bob")!);
    // Dropped while bob still waits, and nothing goes out once the wait ends either.
    expect(await sendPending(db)).toEqual({ delivered: 0, failed: 0 });
    expect(deliveries()).toEqual([]);
    expire();
    expect(await sendPending(db)).toEqual({ delivered: 0, failed: 0 });
    expect(r.got).toEqual([]);
  });

  it("sends a held message once the wait ends with it unread, as when the waiter crashed", async () => {
    const r = await receiver();
    addWebhook(db, "owner", r.url, "agent:bob", true, undefined, 1);
    markWaiting(db, OWNER_ACCOUNT, "bob");
    sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "unread");
    expect(await sendPending(db)).toEqual({ delivered: 0, failed: 0 });
    // Held, it used none of the webhook's allowance.
    expect(db.prepare("SELECT window_count FROM webhooks").get()).toEqual({ window_count: 0 });
    expire();
    expect(await sendPending(db)).toEqual({ delivered: 1, failed: 0 });
    expect(r.got.map((g) => g.text)).toEqual(["unread"]);
  });

  it("lasts WAIT_MARK_MS after the last check, so a waiter that stops checking holds nothing for long", () => {
    const now = Date.now();
    markWaiting(db, OWNER_ACCOUNT, "bob", now);
    const until = () => (db.prepare("SELECT waiting_until FROM agents WHERE name = 'bob'").get() as { waiting_until: number }).waiting_until;
    expect(until()).toBe(now + WAIT_MARK_MS);
    // A check soon after leaves the mark alone, so most checks write nothing.
    markWaiting(db, OWNER_ACCOUNT, "bob", now + 1000);
    expect(until()).toBe(now + WAIT_MARK_MS);
    markWaiting(db, OWNER_ACCOUNT, "bob", now + WAIT_MARK_MS);
    expect(until()).toBe(now + 2 * WAIT_MARK_MS);
    expect(WAIT_MARK_MS).toBeLessThanOrEqual(60_000);
  });

  it("holds a mention of a waiting agent the same way, and never a #channel webhook", async () => {
    const r = await receiver();
    addWebhook(db, "owner", r.url, "mention:bob", true);
    addWebhook(db, "owner", r.url, "#general", true);
    markWaiting(db, OWNER_ACCOUNT, "bob");
    post(db, OWNER_ACCOUNT, member(OWNER_ACCOUNT, "alice"), "general", "hey @bob");
    expect(await sendPending(db)).toEqual({ delivered: 1, failed: 0 });
    expect(r.got).toHaveLength(1);
    expect(r.got[0]).toMatchObject({ channel: "general", text: "hey @bob", event: "channel" });
    expire();
    expect(await sendPending(db)).toEqual({ delivered: 1, failed: 0 });
    expect(r.got[1]).toMatchObject({ event: "mention", text: "hey @bob" });
  });

  it("drops a held mention once the agent reads it", async () => {
    const r = await receiver();
    addWebhook(db, "owner", r.url, "mention:bob", true);
    markWaiting(db, OWNER_ACCOUNT, "bob");
    post(db, OWNER_ACCOUNT, member(OWNER_ACCOUNT, "alice"), "general", "hey @bob");
    readInbox(db, OWNER_ACCOUNT, identityOf(db, OWNER_ACCOUNT, "bob")!);
    expire();
    expect(await sendPending(db)).toEqual({ delivered: 0, failed: 0 });
    expect(deliveries()).toEqual([]);
    expect(r.got).toEqual([]);
  });

  it("sends a held message at once when its agent is removed", async () => {
    const r = await receiver();
    addWebhook(db, "owner", r.url, "agent:bob", true);
    markWaiting(db, OWNER_ACCOUNT, "bob");
    sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "for bob");
    removeAgent(db, OWNER_ACCOUNT, "bob", bobKey);
    expect(await sendPending(db)).toEqual({ delivered: 1, failed: 0 });
    expect(r.got.map((g) => g.text)).toEqual(["for bob"]);
  });

  it("holds only for the waiting agent of its own account", async () => {
    const friend = (addAccount(db, "friend"), (db.prepare("SELECT id FROM accounts WHERE name = 'friend'").get() as { id: number }).id);
    registerAgent(db, friend, "bob", "the friend's bob");
    registerAgent(db, friend, "alice", "the friend's alice");
    const r = await receiver();
    addWebhook(db, "owner", r.url, "agent:bob", true);
    addWebhook(db, "friend", r.url, "agent:bob", true);
    markWaiting(db, friend, "bob");
    sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "owner's");
    sendMessage(db, friend, "alice", "bob", "friend's");
    expect(await sendPending(db)).toEqual({ delivered: 1, failed: 0 });
    expect(r.got.map((g) => g.text)).toEqual(["owner's"]);
  });

  it("finds the held agent and its message or mention by primary key, not by scanning history", () => {
    const plan = (sql: string) =>
      (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]).map((p) => p.detail).join("\n");
    const pending = plan(
      `SELECT id, attempts FROM webhook_deliveries
       WHERE webhook_id = 1 AND delivered_at IS NULL AND attempts < 3 AND (claimed_until IS NULL OR claimed_until <= 0)
         AND (held_for IS NULL OR NOT EXISTS (SELECT 1 FROM agents a WHERE a.id = held_for AND a.waiting_until > 0 AND a.removed_at IS NULL)
           OR EXISTS (SELECT 1 FROM messages m WHERE m.id = message_id AND m.recipient_id = held_for AND m.read_at IS NOT NULL)
           OR EXISTS (SELECT 1 FROM mentions x WHERE x.agent_id = held_for AND x.post_id = webhook_deliveries.post_id AND x.read_at IS NOT NULL))
       ORDER BY id LIMIT 20`,
    );
    expect(pending).toMatch(/USING INDEX webhook_deliveries_pending_by_webhook \(webhook_id=\? AND delivered_at=\?\)/);
    expect(pending).toMatch(/SEARCH a USING INTEGER PRIMARY KEY \(rowid=\?\)/);
    expect(pending).toMatch(/SEARCH m USING INTEGER PRIMARY KEY \(rowid=\?\)/);
    expect(pending).toMatch(/SEARCH x USING (COVERING )?INDEX (sqlite_autoindex_mentions_1|mentions_unread) \(agent_id=\? AND/);
    expect(pending).not.toMatch(/SCAN|TEMP B-TREE/);
  });
});

describe("over HTTP", () => {
  const TOKEN = "s3cret-token";
  let http: HttpServer;
  const clients: Client[] = [];
  beforeEach(async () => {
    http = await startHttp(db, { token: TOKEN, port: 0, webhookIntervalMs: 20 });
    return async () => {
      for (const c of clients.splice(0)) await c.close().catch(() => {});
      await http.close();
    };
  });

  const auth = { Authorization: `Bearer ${TOKEN}` };
  async function client(name: string) {
    const c = new Client({ name: "test", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${http.port}/mcp`), { requestInit: { headers: auth } }));
    clients.push(c);
    await c.callTool({ name: "register", arguments: { name, bio: "waits", key: bobKey } });
    return c;
  }
  const text = async (c: Client, name: string, args: Record<string, unknown> = {}) =>
    JSON.parse(((await c.callTool({ name, arguments: args })) as { content: { text: string }[] }).content[0]!.text);

  it("sends no delivery for a message that reaches a held wait_for_mail, which returns and read_inbox gets it", async () => {
    const r = await receiver();
    addWebhook(db, "owner", r.url, "agent:bob", true);
    const bob = await client("bob");
    const waiting = text(bob, "wait_for_mail", { timeout_seconds: 10 });
    await vi.waitFor(() => expect(db.prepare("SELECT waiting_until FROM agents WHERE name = 'bob'").get()).not.toEqual({ waiting_until: null }));
    sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "reply");
    expect(await waiting).toEqual({ unread: "1 unread message from alice" });
    expect((await text(bob, "read_inbox")).map((m: { body: string }) => m.body)).toEqual(["reply"]);
    await new Promise((res) => setTimeout(res, 200));
    expect(r.got).toEqual([]);
    expect(deliveries()).toEqual([]);
  });

  it("holds a message that reaches a held GET /wait, and sends it once that wait has ended unread", async () => {
    const r = await receiver();
    addWebhook(db, "owner", r.url, "agent:bob", true);
    const controller = new AbortController();
    const res = fetch(`http://127.0.0.1:${http.port}/wait?agent=bob`, { headers: auth, signal: controller.signal });
    await vi.waitFor(() => expect(db.prepare("SELECT waiting_until FROM agents WHERE name = 'bob'").get()).not.toEqual({ waiting_until: null }));
    sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "never read");
    expect((await res).status).toBe(200);
    await new Promise((res) => setTimeout(res, 200));
    expect(r.got).toEqual([]);
    // The wait has ended and bob stopped; once its mark runs out the delivery goes out.
    expire();
    await vi.waitFor(() => expect(r.got.map((g) => g.text)).toEqual(["never read"]));
  });
});
