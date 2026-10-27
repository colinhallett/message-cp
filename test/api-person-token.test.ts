import { mkdtempSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addAccount, addToken, revokeToken } from "../src/accounts.js";
import { addPerson, identityOf, registerAgent, removePerson } from "../src/agents.js";
import { joinChannel, post, type Member } from "../src/channels.js";
import { OWNER_ACCOUNT, openDb, type Db } from "../src/db.js";
import { startHttp, type HttpServer } from "../src/http.js";
import { sendMessage } from "../src/messages.js";

// Person tokens (`token add --person`): the read-only GET /api/* endpoints, and POST /api/send and /api/post only as
// the token's own person, on a server with the owner's account and a friend's.
const OWNER_TOKEN = "owner-token";
let db: Db;
let http: HttpServer;
let maria: string;
let ownerViewer: string;
let friendMaria: string;

const start = async (options: { maxSessions?: number } = {}) => {
  http = await startHttp(db, { token: OWNER_TOKEN, port: 0, waitHoldMs: 0, ...options });
};

beforeEach(async () => {
  db = openDb(join(mkdtempSync(join(tmpdir(), "message-cp-api-person-token-")), "db.sqlite"));
  addAccount(db, "friend");
  addPerson(db, "owner", "maria");
  addPerson(db, "owner", "dana");
  addPerson(db, "friend", "maria");
  maria = addToken(db, "owner", false, false, undefined, "maria").token;
  friendMaria = addToken(db, "friend", false, false, undefined, "maria").token;
  ownerViewer = addToken(db, "owner", true).token;
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
const send = (path: string, token: string, body: unknown) =>
  fetch(`${base()}${path}`, { method: "POST", headers: { ...auth(token), "Content-Type": "application/json" }, body: JSON.stringify(body) });
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
  return { status: res.status, body: (await res.text()).replace(/"lastSeen":"[^"]*"/g, "") };
};

const READS = [
  "/api/agents",
  "/api/channels",
  "/api/channel-posts?channel=general",
  "/api/messages",
  "/api/search?text=hello",
  "/api/webhook-deliveries",
];

describe("person tokens", () => {
  it("read every read-only endpoint as a read-only token of the account does, and only their own account", async () => {
    for (const path of READS) {
      const mine = await answer(path, maria);
      expect(mine.status, path).toBe(200);
      expect(mine, path).toEqual(await answer(path, ownerViewer));
    }
    expect(await (await get("/api/messages", maria)).text()).toContain("hello carol");
    // The friend's person token reads the friend's account, which has none of the owner's messages or agents.
    for (const path of ["/api/messages", "/api/agents", "/api/search?text=hello"]) {
      const text = await (await get(path, friendMaria)).text();
      expect(text, path).not.toContain("hello carol");
      expect(text, path).not.toContain("bob");
    }
  });

  it("are told by GET /api/token their person's name, and every other token's answer is unchanged", async () => {
    expect(await (await get("/api/token", maria)).json()).toEqual({ readOnly: false, agentOnly: false, person: "maria" });
    expect(await (await get("/api/token", friendMaria)).json()).toEqual({ readOnly: false, agentOnly: false, person: "maria" });
    expect(await (await get("/api/token", OWNER_TOKEN)).json()).toEqual({ readOnly: false, agentOnly: false });
    expect(await (await get("/api/token", addToken(db, "owner").token)).json()).toEqual({ readOnly: false, agentOnly: false });
    expect(await (await get("/api/token", ownerViewer)).json()).toEqual({ readOnly: true, agentOnly: false });
    expect(await (await get("/api/token", addToken(db, "owner", false, true).token)).json()).toEqual({ readOnly: false, agentOnly: true });
  });

  it.each([
    ["/api/send", { to: "bob" }],
    ["/api/post", { channel: "general" }],
  ] as const)("%s as their own person in any case, stored under the person's name", async (path, target) => {
    const res = await send(path, maria, { as: "MARIA", ...target, body: "from maria" });
    expect(res.status, await res.clone().text()).toBe(200);
    const table = path === "/api/send" ? "messages" : "channel_posts";
    expect(db.prepare(`SELECT sender FROM ${table} WHERE body = 'from maria'`).all()).toEqual([{ sender: "maria" }]);
  });

  it.each([
    ["/api/send", { to: "bob" }],
    ["/api/post", { channel: "general" }],
  ] as const)("%s as anyone else gets 403, another live person included, and stores nothing", async (path, target) => {
    const before = stored();
    for (const as of ["dana", "Dana", "bob", "nobody", "all"]) {
      const res = await send(path, maria, { as, ...target, body: "not maria" });
      expect(res.status, as).toBe(403);
      expect(((await res.json()) as { error: { message: string } }).error.message).toBe("This token sends and posts only as its own person");
    }
    // Nor does the friend's person token of the same name send as the owner's maria: it stays in its own account.
    expect((await send(path, friendMaria, { as: "maria", ...target, body: "friend's maria" })).status).toBe(path === "/api/send" ? 400 : 200);
    expect(db.prepare("SELECT COUNT(*) FROM messages WHERE body IN ('not maria', 'friend''s maria')").pluck().get()).toBe(0);
    expect(db.prepare("SELECT COUNT(*) FROM channel_posts WHERE body = 'not maria'").pluck().get()).toBe(0);
    expect(
      db.prepare("SELECT channels.account_id FROM channel_posts JOIN channels ON channels.id = channel_id WHERE body = 'friend''s maria'").pluck().all(),
    ).not.toContain(OWNER_ACCOUNT);
    if (path === "/api/send") expect(stored()).toBe(before);
  });

  it("get 403 on /mcp, /wait, DELETE /api/conversation and any other path, changing nothing", async () => {
    const before = stored();
    for (const [path, method] of [
      ["/mcp", "POST"],
      ["/mcp", "GET"],
      ["/mcp", "DELETE"],
      ["/wait?agent=carol", "GET"],
      ["/api/conversation?a=bob&b=carol", "DELETE"],
      ["/api/nothing-here", "GET"],
    ]) {
      const res = await get(path, maria, method);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(res.headers.get("connection"), `${method} ${path}`).toBe("close");
    }
    expect(stored()).toBe(before);
    expect(db.prepare("SELECT body FROM messages").all()).toEqual([{ body: "hello carol" }]);
  });

  it("get the 403 before a slot is taken or the body read", async () => {
    await http.close();
    await start({ maxSessions: 1 });
    // Another person token's request whose body has not arrived yet holds the only send slot.
    const dana = addToken(db, "owner", false, false, undefined, "dana").token;
    const held = request(`${base()}/api/send`, {
      method: "POST",
      headers: { ...auth(dana), "Content-Type": "application/json", "Content-Length": "1000" },
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
    for (const path of ["/mcp", "/api/conversation?a=bob&b=carol"]) {
      const refused = await new Promise<number>((resolve, reject) => {
        const r = request(`${base()}${path}`, {
          method: path === "/mcp" ? "POST" : "DELETE",
          headers: { ...auth(maria), "Content-Type": "application/json", "Content-Length": "1000" },
        });
        r.on("response", (res) => {
          res.resume();
          resolve(res.statusCode!);
          r.destroy();
        });
        r.on("error", reject);
        r.flushHeaders();
      });
      expect(refused, path).toBe(403);
    }
    // A send of its own person takes a slot, so it waits its turn behind the held one.
    expect((await send("/api/send", maria, { as: "maria", to: "bob", body: "hi" })).status).toBe(503);
    held.end(" ".repeat(999));
    expect(await answered).toBe(400);
  });

  it("get 401 once revoked, or once their person is removed, and never reach a later person of the same name", async () => {
    const other = addToken(db, "owner", false, false, undefined, "dana");
    revokeToken(db, other.id);
    for (const path of ["/api/token", "/api/agents"]) expect((await get(path, other.token)).status).toBe(401);
    removePerson(db, "owner", "maria");
    addPerson(db, "owner", "maria");
    for (const path of ["/api/token", ...READS]) expect((await get(path, maria)).status, path).toBe(401);
    const res = await send("/api/send", maria, { as: "maria", to: "bob", body: "after removal" });
    expect(res.status).toBe(401);
    expect(db.prepare("SELECT COUNT(*) FROM messages WHERE body = 'after removal'").pluck().get()).toBe(0);
    // The friend's maria is another person, whose token still works.
    expect((await get("/api/token", friendMaria)).status).toBe(200);
  });

  it("are the only tokens that send or post: a full token is refused as any person", async () => {
    const before = stored();
    for (const token of [OWNER_TOKEN, addToken(db, "owner").token]) {
      for (const as of ["maria", "dana"]) {
        for (const [path, target] of [
          ["/api/send", { to: "bob" }],
          ["/api/post", { channel: "general" }],
        ] as const) {
          const res = await send(path, token, { as, ...target, body: "hi" });
          expect(res.status, `${path} ${as}`).toBe(403);
          expect(res.headers.get("connection")).toBe("close");
          expect(await res.text()).toContain("message-cp login-link --url <public url> --person <name>");
        }
      }
    }
    expect(stored()).toBe(before);
    expect((await send("/api/send", maria, { as: "maria", to: "bob", body: "hi" })).status).toBe(200);
    expect((await send("/api/post", maria, { as: "maria", channel: "general", body: "hi" })).status).toBe(200);
  });
});
