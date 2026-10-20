import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addAccount, addToken, listAccounts, revokeToken } from "../src/accounts.js";
import { identityOf, registerAgent, removeAgent } from "../src/agents.js";
import { joinChannel, post, type Member } from "../src/channels.js";
import { OWNER_ACCOUNT, openDb, type AccountId, type Db } from "../src/db.js";
import { startHttp, type HttpServer } from "../src/http.js";
import { sendMessage } from "../src/messages.js";

// Read-only tokens and GET /api/agents, on a server with the owner's account and a friend's.
const OWNER_TOKEN = "owner-token";
let dbFile: string;
let db: Db;
let http: HttpServer;
let friend: AccountId;
let friendToken: string;
let friendViewer: string;
let ownerViewer: string;

beforeEach(async () => {
  dbFile = join(mkdtempSync(join(tmpdir(), "message-cp-api-")), "db.sqlite");
  db = openDb(dbFile);
  friendToken = addAccount(db, "friend").token;
  friend = listAccounts(db).find((a) => a.name === "friend")!.id;
  friendViewer = addToken(db, "friend", true).token;
  ownerViewer = addToken(db, "owner", true).token;
  http = await startHttp(db, { token: OWNER_TOKEN, port: 0, waitHoldMs: 1500 });
});

afterEach(async () => {
  await http.close();
  db.close();
});

const base = () => `http://127.0.0.1:${http.port}`;
const auth = (token: string | null): Record<string, string> => (token === null ? {} : { Authorization: `Bearer ${token}` });
const agents = (token: string | null, query = "", method = "GET") =>
  fetch(`${base()}/api/agents${query}`, { method, headers: auth(token) });
const json = async (token: string, query = "") => {
  const res = await agents(token, query);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/json");
  return (await res.json()) as { name: string; bio: string; lastSeen: string; unreadMessages: number; unreadPosts: number; online: boolean }[];
};
const member = (account: AccountId, name: string): Member => ({ ...identityOf(db, account, name)!, name });
const initialize = (token: string) =>
  fetch(`${base()}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...auth(token) },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "raw", version: "0" } },
    }),
  });

describe("read-only tokens", () => {
  it("get 403 on /mcp and /wait, start no session and change nothing", async () => {
    registerAgent(db, friend, "fred", "x");
    sendMessage(db, friend, "fred", "fred", "unread body");
    const before = JSON.stringify(db.prepare("SELECT * FROM messages").all());
    for (const method of ["POST", "GET", "DELETE"]) {
      const res = method === "POST" ? await initialize(friendViewer) : await fetch(`${base()}/mcp`, { method, headers: auth(friendViewer) });
      expect(res.status).toBe(403);
      expect(await res.text()).not.toContain(friendViewer);
    }
    expect((await fetch(`${base()}/wait?agent=fred`, { headers: auth(friendViewer) })).status).toBe(403);
    expect((await fetch(`${base()}/wait?agent=nobody`, { headers: auth(ownerViewer) })).status).toBe(403);
    expect(http.sessionCount()).toBe(0);
    expect(JSON.stringify(db.prepare("SELECT * FROM messages").all())).toBe(before);
  });

  it("cannot use a session a full token of its account started", async () => {
    const res = await initialize(friendToken);
    const sid = res.headers.get("mcp-session-id")!;
    const hijack = await fetch(`${base()}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "mcp-session-id": sid, ...auth(friendViewer) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "register", arguments: { name: "x", bio: "x" } } }),
    });
    expect(hijack.status).toBe(403);
    expect(db.prepare("SELECT COUNT(*) FROM agents").pluck().get()).toBe(0);
  });

  it("leave full tokens and MESSAGE_CP_HTTP_TOKEN as they were", async () => {
    expect((await initialize(OWNER_TOKEN)).status).toBe(200);
    expect((await initialize(friendToken)).status).toBe(200);
    expect((await initialize(addToken(db, "friend").token)).status).toBe(200);
  });
});

describe("GET /api/agents", () => {
  it("lists the token's account's live agents with their unread counts, for every kind of token", async () => {
    registerAgent(db, OWNER_ACCOUNT, "alice", "receiver");
    registerAgent(db, OWNER_ACCOUNT, "bob", "sender");
    removeAgent(db, OWNER_ACCOUNT, "gone", registerAgent(db, OWNER_ACCOUNT, "gone", "x").key);
    sendMessage(db, OWNER_ACCOUNT, "bob", "alice", "secret body one");
    sendMessage(db, OWNER_ACCOUNT, "bob", "alice", "secret body two");
    joinChannel(db, OWNER_ACCOUNT, member(OWNER_ACCOUNT, "alice"), "build");
    post(db, OWNER_ACCOUNT, member(OWNER_ACCOUNT, "bob"), "build", "secret post");
    for (const token of [OWNER_TOKEN, ownerViewer]) {
      const res = await agents(token);
      const text = await res.clone().text();
      expect(text).not.toContain("secret");
      expect(text).not.toContain(token);
      const list = await json(token);
      expect(list.map((a) => a.name)).toEqual(["alice", "bob"]);
      expect(list[0]).toMatchObject({ name: "alice", bio: "receiver", unreadMessages: 2, unreadPosts: 1, online: true });
      expect(list[1]).toMatchObject({ name: "bob", unreadMessages: 0, unreadPosts: 0 });
      expect(Object.keys(list[0]).sort()).toEqual(["bio", "lastSeen", "name", "online", "unreadMessages", "unreadPosts"]);
    }
    // Reading the list marks nothing read.
    expect((await json(ownerViewer))[0].unreadMessages).toBe(2);
  });

  it("never shows another account's agents, counts or held waits, whatever the token", async () => {
    registerAgent(db, OWNER_ACCOUNT, "alice", "owner's");
    registerAgent(db, friend, "fred", "friend's");
    registerAgent(db, friend, "alice", "friend's alice");
    sendMessage(db, friend, "alice", "fred", "to fred");
    db.prepare("UPDATE agents SET last_seen = 0").run();
    // The friend's alice is held on /wait, the owner's alice of the same name is not.
    const held = await new Promise<() => void>((done) => {
      const req = request(`${base()}/wait?agent=alice`, { headers: auth(friendToken) });
      req.on("error", () => {});
      req.on("socket", (s) => s.once("connect", () => setTimeout(() => done(() => req.destroy()), 200)));
      req.end();
    });
    try {
      for (const token of [OWNER_TOKEN, ownerViewer]) {
        const list = await json(token);
        expect(list).toEqual([{ name: "alice", bio: "owner's", lastSeen: new Date(0).toISOString(), unreadMessages: 0, unreadPosts: 0, online: false }]);
      }
      for (const token of [friendToken, friendViewer]) {
        const list = await json(token);
        expect(list.map((a) => [a.name, a.unreadMessages, a.online])).toEqual([
          ["alice", 0, true],
          ["fred", 1, false],
        ]);
      }
    } finally {
      held();
    }
  });

  it("counts an agent online while its /wait is held or it was seen in the last 5 minutes", async () => {
    registerAgent(db, OWNER_ACCOUNT, "alice", "x");
    registerAgent(db, OWNER_ACCOUNT, "bob", "x");
    db.prepare("UPDATE agents SET last_seen = ? WHERE name = 'alice'").run(Date.now() - 4 * 60 * 1000);
    db.prepare("UPDATE agents SET last_seen = ? WHERE name = 'bob'").run(Date.now() - 6 * 60 * 1000);
    const online = async () => Object.fromEntries((await json(ownerViewer)).map((a) => [a.name, a.online]));
    expect(await online()).toEqual({ alice: true, bob: false });
    const pending = fetch(`${base()}/wait?agent=BOB`, { headers: auth(OWNER_TOKEN) });
    await new Promise((r) => setTimeout(r, 300));
    expect(await online()).toEqual({ alice: true, bob: true });
    expect((await pending).status).toBe(204);
    expect(await online()).toEqual({ alice: true, bob: false });
  });

  it("pages with limit and offset like list_agents, and refuses bad values with 400", async () => {
    for (const name of ["a", "b", "c", "d"]) registerAgent(db, friend, name, "x");
    const names = async (query: string) => (await json(friendViewer, query)).map((a) => a.name);
    expect(await names("?limit=2")).toEqual(["a", "b"]);
    expect(await names("?limit=2&offset=2")).toEqual(["c", "d"]);
    expect(await names("?offset=3")).toEqual(["d"]);
    expect(await names("?offset=9")).toEqual([]);
    for (const query of ["?limit=0", "?limit=201", "?limit=x", "?offset=-1", "?limit=1.5", "?limit="]) {
      expect((await agents(friendViewer, query)).status).toBe(400);
    }
  });

  it("answers 405 to any method but GET", async () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const res = await agents(friendViewer, "", method);
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("GET");
    }
    expect((await agents(OWNER_TOKEN, "", "POST")).status).toBe(405);
  });

  it("answers 401 to no token, a wrong token and a revoked token, as /mcp does", async () => {
    for (const token of [null, "nope"]) {
      const res = await agents(token);
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe("Bearer");
      expect((await initialize(token ?? "")).status).toBe(401);
    }
    expect((await agents(null, "", "POST")).status).toBe(401);
    expect((await fetch(`${base()}/api/agents`, { headers: { Authorization: friendViewer } })).status).toBe(401);
    const viewer = addToken(db, "friend", true);
    expect((await agents(viewer.token)).status).toBe(200);
    revokeToken(db, viewer.id);
    expect((await agents(viewer.token)).status).toBe(401);
  });
});

describe("message-cp token add", () => {
  const root = resolve(import.meta.dirname, "..");
  const cli = (...args: string[]) =>
    spawnSync(join(root, "node_modules/.bin/tsx"), [join(root, "src/cli.ts"), ...args], {
      env: { ...process.env, MESSAGE_CP_DB: dbFile },
      encoding: "utf8",
    });

  it("prints a read-only token with --read-only and a full one without it", async () => {
    const viewer = cli("token", "add", "friend", "--read-only");
    expect(viewer.status).toBe(0);
    expect(viewer.stderr).toContain("read-only token");
    const full = cli("token", "add", "friend");
    expect(full.status).toBe(0);
    expect(full.stderr).not.toContain("read-only");
    expect(await initialize(viewer.stdout.trim())).toHaveProperty("status", 403);
    expect((await agents(viewer.stdout.trim())).status).toBe(200);
    expect(await initialize(full.stdout.trim())).toHaveProperty("status", 200);
  }, 30_000);

  it("refuses --read-only anywhere but after token add <account>", () => {
    for (const args of [
      ["token", "add", "--read-only"],
      ["token", "add", "friend", "--readonly"],
      ["token", "add", "friend", "--read-only", "extra"],
      ["account", "add", "x", "--read-only"],
      ["token", "revoke", "1", "--read-only"],
    ]) {
      const res = cli(...args);
      expect(res.status).toBe(2);
      expect(res.stderr).toContain("[--read-only]");
    }
  }, 30_000);
});
