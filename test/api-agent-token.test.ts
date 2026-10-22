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

// Agent tokens (`token add --agent-only`): everything a full token of the account reaches but POST /api/send and
// /api/post, on a server with the owner's account and a friend's.
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
  it("answer every GET /api endpoint but /api/token exactly as a full token of the account does", async () => {
    for (const path of [
      "/api/agents",
      "/api/channels",
      "/api/channel-posts?channel=general",
      "/api/messages",
      "/api/search?text=hello",
      "/api/webhook-deliveries",
    ]) {
      const full = await answer(path, ownerFull);
      expect(full.status, path).toBe(200);
      expect(await answer(path, ownerAgent), path).toEqual(full);
    }
  });

  it("see only their own account's agents and messages", async () => {
    registerAgent(db, friend, "fred", "x");
    const names = (await (await get("/api/agents", friendAgent)).json()) as { name: string }[];
    expect(names.map((a) => a.name)).toEqual(["fred"]);
    expect(await (await get("/api/messages", friendAgent)).json()).toEqual([]);
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

  it("hold /wait and delete a conversation as a full token does", async () => {
    expect((await get("/wait?agent=carol", ownerAgent)).status).toBe(200);
    expect((await get("/wait?agent=nobody", ownerAgent)).status).toBe(404);
    const res = await get("/api/conversation?a=bob&b=carol", ownerAgent, "DELETE");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 1 });
  });

  it("get 403 on POST /api/send and /api/post, whatever the method, and store nothing", async () => {
    const before = stored();
    for (const [path, target] of [
      ["/api/send", { to: "bob" }],
      ["/api/post", { channel: "general" }],
    ] as const) {
      for (const method of ["POST", "GET", "PUT", "DELETE"]) {
        const res = await fetch(`${base()}${path}`, {
          method,
          headers: { ...auth(ownerAgent), "Content-Type": "application/json" },
          body: method === "GET" ? undefined : JSON.stringify({ as: "colin", ...target, body: "hi" }),
        });
        expect(res.status, `${method} ${path}`).toBe(403);
        expect(((await res.json()) as { error: { message: string } }).error.message).toBe("This token cannot act as a person");
      }
      // The full token of the same account still can.
      const full = await fetch(`${base()}${path}`, {
        method: "POST",
        headers: { ...auth(ownerFull), "Content-Type": "application/json" },
        body: JSON.stringify({ as: "colin", ...target, body: "from a person" }),
      });
      expect(full.status).toBe(200);
    }
    expect(JSON.stringify(db.prepare("SELECT * FROM messages WHERE body = 'hi'").all())).toBe("[]");
    expect(JSON.stringify(db.prepare("SELECT * FROM channel_posts WHERE body = 'hi'").all())).toBe("[]");
    expect(stored()).not.toBe(before);
  });

  it("get the 403 before a send or post slot is taken or the body read", async () => {
    await http.close();
    await start({ maxSessions: 1 });
    // A full token's request whose body has not arrived yet holds the only slot.
    const held = request(`${base()}/api/send`, {
      method: "POST",
      headers: { ...auth(OWNER_TOKEN), "Content-Type": "application/json", "Content-Length": "1000" },
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
    expect((await fetch(`${base()}/api/send`, { method: "POST", headers: auth(OWNER_TOKEN), body: "{}" })).status).toBe(503);
    const before = stored();
    for (const path of ["/api/send", "/api/post"]) {
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
