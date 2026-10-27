import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtempSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addAccount, addToken, listAccounts } from "../src/accounts.js";
import { addPerson, identityOf, registerAgent } from "../src/agents.js";
import { joinChannel, post, type Member } from "../src/channels.js";
import { OWNER_ACCOUNT, openDb, type AccountId, type Db } from "../src/db.js";
import { startHttp, type HttpServer } from "../src/http.js";
import { sendMessage } from "../src/messages.js";

// Agent tokens (`token add --agent-only`): /mcp, /wait and GET /api/token as a full token of the account reaches them,
// and 403 on every other /api path, on a server with the owner's account and a friend's.
const OWNER_TOKEN = "owner-token";
let db: Db;
let http: HttpServer;
let friend: AccountId;
let ownerAgent: string;
let ownerFull: string;
let friendAgent: string;

const start = async (options: { maxSessions?: number; waitHoldMs?: number } = {}) => {
  http = await startHttp(db, { token: OWNER_TOKEN, port: 0, waitHoldMs: 0, ...options });
};

beforeEach(async () => {
  db = openDb(join(mkdtempSync(join(tmpdir(), "message-cp-api-agent-token-")), "db.sqlite"));
  addAccount(db, "friend");
  friend = listAccounts(db).find((a) => a.name === "friend")!.id;
  ownerAgent = addToken(db, "owner", false, true).token;
  ownerFull = addToken(db, "owner").token;
  friendAgent = addToken(db, "friend", false, true).token;
  addPerson(db, "owner", "colin");
  registerAgent(db, OWNER_ACCOUNT, "bob", "x");
  registerAgent(db, OWNER_ACCOUNT, "carol", "x");
  sendMessage(db, OWNER_ACCOUNT, "bob", "carol", "hello carol");
  const bob: Member = { ...identityOf(db, OWNER_ACCOUNT, "bob")!, name: "bob" };
  joinChannel(db, OWNER_ACCOUNT, bob, "general");
  post(db, OWNER_ACCOUNT, bob, "general", "hello @carol");
  await start();
});

afterEach(async () => {
  await http.close();
  db.close();
});

const base = () => `http://127.0.0.1:${http.port}`;
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });
const get = (path: string, token: string, method = "GET") => fetch(`${base()}${path}`, { method, headers: auth(token) });
const stored = () =>
  JSON.stringify([
    db.prepare("SELECT * FROM messages ORDER BY id").all(),
    db.prepare("SELECT * FROM channel_posts ORDER BY id").all(),
    db.prepare("SELECT * FROM mentions ORDER BY post_id").all(),
    db.prepare("SELECT * FROM webhook_deliveries ORDER BY id").all(),
    db.prepare("SELECT * FROM channels ORDER BY id").all(),
  ]);
// lastSeen moves with every poll, so it is left out when two answers are compared.
const answer = async (path: string, token: string) => {
  const res = await get(path, token);
  const text = await res.text();
  return { status: res.status, body: text.replace(/"lastSeen":"[^"]*"/g, "") };
};

describe("agent tokens", () => {
  // Every /api path the server routes, one it does not, and each with every method.
  const API_PATHS = [
    "/api/token",
    "/api/agents",
    "/api/channels",
    "/api/channel-posts?channel=general",
    "/api/messages",
    "/api/search?text=hello",
    "/api/webhook-deliveries",
    "/api/conversation?a=bob&b=carol",
    "/api/send",
    "/api/post",
    "/api/nothing-here",
    "/api",
  ];
  const METHODS = ["GET", "POST", "PUT", "DELETE"];

  it("get 403 on every /api path and method but GET /api/token, and change nothing", async () => {
    const before = stored();
    for (const path of API_PATHS) {
      for (const method of METHODS) {
        if (path === "/api/token" && method === "GET") continue;
        const res = await fetch(`${base()}${path}`, {
          method,
          headers: { ...auth(ownerAgent), "Content-Type": "application/json" },
          body: method === "GET" ? undefined : JSON.stringify({ as: "colin", to: "bob", channel: "general", body: "hi" }),
        });
        expect(res.status, `${method} ${path}`).toBe(403);
        const text = await res.text();
        expect(JSON.parse(text).error.message).toBe("Agent tokens cannot use the dashboard API");
        expect(text, `${method} ${path}`).not.toContain("hello");
      }
    }
    // Nothing was sent, posted or deleted: bob's message to carol is still there.
    expect(stored()).toBe(before);
    expect(db.prepare("SELECT body FROM messages").all()).toEqual([{ body: "hello carol" }]);
  });

  it("are told by GET /api/token that they are agent tokens, in their own account too", async () => {
    for (const token of [ownerAgent, friendAgent]) {
      const res = await get("/api/token", token);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ readOnly: false, agentOnly: true });
    }
  });

  it("leave full and read-only tokens of the account as they were on every /api path", async () => {
    const viewer = addToken(db, "owner", true).token;
    for (const path of [
      "/api/token",
      "/api/agents",
      "/api/channels",
      "/api/channel-posts?channel=general",
      "/api/messages",
      "/api/search?text=hello",
      "/api/webhook-deliveries",
    ]) {
      for (const token of [ownerFull, viewer]) expect((await get(path, token)).status, path).toBe(200);
    }
    expect(await (await get("/api/messages", viewer)).text()).toContain("hello carol");
    // A read-only token is still refused where it was, and a full token still deletes but, acting as no person, is
    // refused a send or post.
    for (const [path, method] of [
      ["/api/conversation?a=bob&b=carol", "DELETE"],
      ["/api/send", "POST"],
      ["/api/post", "POST"],
    ]) {
      expect((await get(path, viewer, method)).status, path).toBe(403);
    }
    for (const [path, target] of [
      ["/api/send", { to: "bob" }],
      ["/api/post", { channel: "general" }],
    ] as const) {
      const full = await fetch(`${base()}${path}`, {
        method: "POST",
        headers: { ...auth(ownerFull), "Content-Type": "application/json" },
        body: JSON.stringify({ as: "colin", ...target, body: "from a person" }),
      });
      expect(full.status, path).toBe(403);
    }
    const res = await get("/api/conversation?a=bob&b=carol", ownerFull, "DELETE");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 1 });
  });

  it("use /mcp as an agent of their own account does", async () => {
    const client = new Client({ name: "agent-token", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base()}/mcp`), { requestInit: { headers: auth(friendAgent) } }));
    const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
    expect((await call("register", { name: "fred", bio: "x" })).isError).toBeFalsy();
    expect((await call("send_message", { to: "fred", body: "note to self" })).isError).toBeFalsy();
    const listed = JSON.stringify(await call("list_agents", {}));
    expect(listed).toContain("fred");
    expect(listed).not.toContain("bob");
    await client.close();
    expect(
      db.prepare("SELECT agents.account_id, messages.sender FROM messages JOIN agents ON agents.id = recipient_id WHERE body = 'note to self'").all(),
    ).toEqual([{ account_id: friend, sender: "fred" }]);
  });

  it("hold /wait as a full token does", async () => {
    const res = await get("/wait?agent=carol", ownerAgent);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(await (await get("/wait?agent=carol", ownerFull)).text());
    expect((await get("/wait?agent=nobody", ownerAgent)).status).toBe(404);
    // Nor does an agent token reach another account's agents.
    expect((await get("/wait?agent=carol", friendAgent)).status).toBe(404);
  });

  it("get the 403 before a send or post slot is taken or the body read, on every path that reads a body", async () => {
    await http.close();
    await start({ maxSessions: 1 });
    // A person token's request whose body has not arrived yet holds the only slot.
    const colin = addToken(db, "owner", false, false, undefined, "colin").token;
    const held = request(`${base()}/api/send`, {
      method: "POST",
      headers: { ...auth(colin), "Content-Type": "application/json", "Content-Length": "1000" },
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
    expect((await fetch(`${base()}/api/send`, { method: "POST", headers: auth(colin), body: "{}" })).status).toBe(503);
    const before = stored();
    for (const path of ["/api/send", "/api/post", "/api/token", "/api/agents"]) {
      // An agent token's request is refused at once, with its body never read: none is ever sent.
      const refused = await new Promise<number>((resolve, reject) => {
        const r = request(`${base()}${path}`, {
          method: "POST",
          headers: { ...auth(ownerAgent), "Content-Type": "application/json", "Content-Length": "1000" },
        });
        r.on("response", (res) => {
          res.resume();
          resolve(res.statusCode!);
          r.destroy();
        });
        r.on("error", reject);
        r.flushHeaders();
      });
      expect(refused).toBe(403);
    }
    expect(stored()).toBe(before);
    held.end(" ".repeat(999));
    expect(await answered).toBe(400);
  });
});
