import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addAccount, addToken, listAccounts, revokeToken } from "../src/accounts.js";
import { registerAgent, registerWithIdentity } from "../src/agents.js";
import { post } from "../src/channels.js";
import { OWNER_ACCOUNT, openDb, type AccountId, type Db } from "../src/db.js";
import { startHttp, type HttpServer } from "../src/http.js";
import { sendMessage } from "../src/messages.js";
import { addWebhook } from "../src/webhooks.js";

// GET /api/webhook-deliveries, on a server with the owner's account and a friend's. The server's own sender never runs
// here, so each delivery stays as the test sets it.
const OWNER_TOKEN = "owner-token";
const HOUR = 3_600_000;
let db: Db;
let http: HttpServer;
let friend: AccountId;
let friendToken: string;
let friendViewer: string;
let ownerViewer: string;
let ownerFull: string;

const start = (maxAttempts?: number) =>
  startHttp(db, { token: OWNER_TOKEN, port: 0, waitHoldMs: 0, webhookIntervalMs: HOUR, webhookOptions: { maxAttempts } });

beforeEach(async () => {
  db = openDb(join(mkdtempSync(join(tmpdir(), "message-cp-api-webhook-deliveries-")), "db.sqlite"));
  friendToken = addAccount(db, "friend").token;
  friend = listAccounts(db).find((a) => a.name === "friend")!.id;
  friendViewer = addToken(db, "friend", true).token;
  ownerViewer = addToken(db, "owner", true).token;
  ownerFull = addToken(db, "owner").token;
  http = await start();
});

afterEach(async () => {
  await http.close();
  db.close();
});

interface DeliveryJson {
  id: number;
  webhook: number;
  on: string;
  queuedAt: string;
  attempts: number;
  deliveredAt: string | null;
  status: "delivered" | "pending" | "failed";
}

const base = () => `http://127.0.0.1:${http.port}`;
const auth = (token: string | null): Record<string, string> => (token === null ? {} : { Authorization: `Bearer ${token}` });
const get = (path: string, token: string | null, method = "GET") => fetch(`${base()}${path}`, { method, headers: auth(token) });
const deliveries = async (token: string, query = "") => {
  const res = await get(`/api/webhook-deliveries${query}`, token);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/json");
  return (await res.json()) as DeliveryJson[];
};
const register = (account: AccountId, ...names: string[]) => names.forEach((n) => registerAgent(db, account, n, "x"));
const member = (account: AccountId, name: string) => ({ ...registerWithIdentity(db, account, name, "x").identity, name });
const set = (id: number, attempts: number, deliveredAt: number | null) =>
  db.prepare("UPDATE webhook_deliveries SET attempts = ?, delivered_at = ? WHERE id = ?").run(attempts, deliveredAt, id);
const ids = () => db.prepare("SELECT id FROM webhook_deliveries ORDER BY id").pluck().all() as number[];
const snapshot = () => JSON.stringify(db.prepare("SELECT * FROM webhook_deliveries ORDER BY id").all());

describe("GET /api/webhook-deliveries", () => {
  it("lists the account's deliveries newest first, each with its status, for every kind of token", async () => {
    register(OWNER_ACCOUNT, "bob");
    const alice = member(OWNER_ACCOUNT, "alice");
    const agent = addWebhook(db, "owner", "https://example.com/agent-hook", "agent:bob", true);
    const channel = addWebhook(db, "owner", "https://example.com/channel-hook", "#general", true);
    const mention = addWebhook(db, "owner", "https://example.com/mention-hook", "mention:bob", false);
    sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "secret plans");
    post(db, OWNER_ACCOUNT, alice, "general", "@bob more secret plans");
    const [delivered, failed, pending] = ids();
    const deliveredAt = Date.UTC(2026, 9, 20, 12);
    set(delivered!, 2, deliveredAt);
    set(failed!, 3, null);
    set(pending!, 1, null);
    const queuedAt = (db.prepare("SELECT created_at FROM webhook_deliveries ORDER BY id").pluck().all() as number[]).map((t) =>
      new Date(t).toISOString(),
    );
    for (const token of [OWNER_TOKEN, ownerFull, ownerViewer]) {
      expect(await deliveries(token)).toEqual([
        { id: pending, webhook: mention.id, on: "mention:bob", queuedAt: queuedAt[2], attempts: 1, deliveredAt: null, status: "pending" },
        { id: failed, webhook: channel.id, on: "#general", queuedAt: queuedAt[1], attempts: 3, deliveredAt: null, status: "failed" },
        {
          id: delivered,
          webhook: agent.id,
          on: "agent:bob",
          queuedAt: queuedAt[0],
          attempts: 2,
          deliveredAt: new Date(deliveredAt).toISOString(),
          status: "delivered",
        },
      ]);
    }
  });

  it("never carries a webhook's URL or secret, or the text of a message or post", async () => {
    register(OWNER_ACCOUNT, "alice", "bob");
    const hook = addWebhook(db, "owner", "https://example.com/path-credential", "agent:bob", true);
    sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "the message text");
    const text = await (await get("/api/webhook-deliveries", ownerViewer)).text();
    expect(JSON.parse(text)).toHaveLength(1);
    for (const hidden of ["example.com", "path-credential", hook.secret, "the message text", ownerViewer]) {
      expect(text).not.toContain(hidden);
    }
  });

  it("never returns another account's deliveries, whatever the token, even for webhooks on the same names", async () => {
    register(OWNER_ACCOUNT, "alice", "bob");
    register(friend, "alice", "bob");
    const owners = addWebhook(db, "owner", "https://example.com/owner", "agent:bob", true);
    const friends = addWebhook(db, "friend", "https://example.com/friend", "agent:bob", true);
    sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "owner's");
    sendMessage(db, friend, "alice", "bob", "friend's");
    sendMessage(db, friend, "alice", "bob", "friend's again");
    const query = `?limit=200&account=${friend}&webhook=${friends.id}`;
    for (const token of [OWNER_TOKEN, ownerFull, ownerViewer]) {
      expect((await deliveries(token, query)).map((d) => d.webhook)).toEqual([owners.id]);
    }
    for (const token of [friendToken, friendViewer]) {
      expect((await deliveries(token, query)).map((d) => d.webhook)).toEqual([friends.id, friends.id]);
    }
  });

  it("calls a delivery failed only once it has no attempts left under the server's maxAttempts", async () => {
    register(OWNER_ACCOUNT, "alice", "bob");
    addWebhook(db, "owner", "https://example.com/", "agent:bob", true);
    sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "x");
    set(ids()[0]!, 3, null);
    expect((await deliveries(ownerViewer)).map((d) => d.status)).toEqual(["failed"]);
    await http.close();
    http = await start(5);
    expect((await deliveries(ownerViewer)).map((d) => d.status)).toEqual(["pending"]);
    set(ids()[0]!, 5, null);
    expect((await deliveries(ownerViewer)).map((d) => d.status)).toEqual(["failed"]);
  });

  it("pages with limit and offset like GET /api/messages, and refuses bad values with 400", async () => {
    register(friend, "fred", "gina");
    addWebhook(db, "friend", "https://example.com/", "agent:gina", true);
    for (let i = 0; i < 4; i++) sendMessage(db, friend, "fred", "gina", `m${i}`);
    const all = ids().reverse();
    const page = async (query: string) => (await deliveries(friendViewer, query)).map((d) => d.id);
    expect(await page("?limit=2")).toEqual(all.slice(0, 2));
    expect(await page("?limit=2&offset=2")).toEqual(all.slice(2));
    expect(await page("?offset=3")).toEqual(all.slice(3));
    expect(await page("?offset=9")).toEqual([]);
    for (let i = 0; i < 205; i++) sendMessage(db, friend, "fred", "gina", `n${i}`);
    expect(await deliveries(friendViewer)).toHaveLength(50);
    expect(await deliveries(friendViewer, "?limit=200")).toHaveLength(200);
    const bad = ["?limit=0", "?limit=201", "?limit=x", "?offset=-1", "?limit=1.5", "?limit="];
    bad.push("?limit=1&limit=x", "?limit=x&limit=1", "?offset=0&offset=-1", "?limit=2&limit=2");
    for (const query of bad) expect((await get(`/api/webhook-deliveries${query}`, friendViewer)).status).toBe(400);
  });

  it("changes no delivery", async () => {
    register(OWNER_ACCOUNT, "alice", "bob");
    addWebhook(db, "owner", "https://example.com/", "agent:bob", true);
    sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "x");
    sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "y");
    set(ids()[0]!, 1, null);
    const before = snapshot();
    for (const token of [OWNER_TOKEN, ownerFull, ownerViewer]) await deliveries(token);
    expect(snapshot()).toBe(before);
  });

  it("answers 405 with Allow: GET to any method but GET", async () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      for (const token of [ownerViewer, OWNER_TOKEN]) {
        const res = await get("/api/webhook-deliveries", token, method);
        expect(res.status).toBe(405);
        expect(res.headers.get("allow")).toBe("GET");
      }
    }
  });

  it("answers 401 to no token, a wrong token and a revoked token", async () => {
    for (const token of [null, "nope"]) {
      const res = await get("/api/webhook-deliveries", token);
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe("Bearer");
    }
    expect((await get("/api/webhook-deliveries", null, "POST")).status).toBe(401);
    const viewer = addToken(db, "friend", true);
    expect((await get("/api/webhook-deliveries", viewer.token)).status).toBe(200);
    revokeToken(db, viewer.id);
    expect((await get("/api/webhook-deliveries", viewer.token)).status).toBe(401);
  });

  it("answers 503 with Retry-After when the database is busy, and 500 for any other failure", async () => {
    register(OWNER_ACCOUNT, "alice", "bob");
    addWebhook(db, "owner", "https://example.com/", "agent:bob", true);
    sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "x");
    // The first query reading deliveries fails once with `code`; the token lookup before it still works.
    const prepare = db.prepare.bind(db);
    const fail = (code: string) => {
      vi.restoreAllMocks();
      let thrown = false;
      vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
        if (thrown || !sql.includes("FROM webhook_deliveries")) return prepare(sql);
        thrown = true;
        throw Object.assign(new Error("database is locked"), { code });
      }) as typeof db.prepare);
    };
    fail("SQLITE_BUSY");
    const res = await get("/api/webhook-deliveries", ownerViewer);
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("1");
    fail("SQLITE_BUSY_SNAPSHOT");
    expect((await get("/api/webhook-deliveries", ownerViewer)).status).toBe(503);
    fail("SQLITE_CORRUPT");
    expect((await get("/api/webhook-deliveries", ownerViewer)).status).toBe(500);
    vi.restoreAllMocks();
    expect(await deliveries(ownerViewer)).toHaveLength(1);
  });

  it("leaves a read-only token refused on /mcp, /wait and every other path, webhooks included", async () => {
    for (const path of ["/mcp", "/wait?agent=x", "/api/webhooks", "/api/webhook-deliveries/1"]) {
      expect((await get(path, ownerViewer)).status).toBe(403);
    }
  });
});
