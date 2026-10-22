import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addAccount, addToken, listAccounts, revokeToken } from "../src/accounts.js";
import { registerAgent, removeAgent } from "../src/agents.js";
import { OWNER_ACCOUNT, openDb, type AccountId, type Db } from "../src/db.js";
import { startHttp, type HttpServer } from "../src/http.js";
import { readInbox, sendMessage } from "../src/messages.js";

// GET /api/messages, on a server with the owner's account and a friend's.
const OWNER_TOKEN = "owner-token";
let db: Db;
let http: HttpServer;
let friend: AccountId;
let friendToken: string;
let friendViewer: string;
let ownerViewer: string;
let ownerFull: string;

beforeEach(async () => {
  db = openDb(join(mkdtempSync(join(tmpdir(), "message-cp-api-messages-")), "db.sqlite"));
  friendToken = addAccount(db, "friend").token;
  friend = listAccounts(db).find((a) => a.name === "friend")!.id;
  friendViewer = addToken(db, "friend", true).token;
  ownerViewer = addToken(db, "owner", true).token;
  ownerFull = addToken(db, "owner").token;
  http = await startHttp(db, { token: OWNER_TOKEN, port: 0, waitHoldMs: 0 });
});

afterEach(async () => {
  await http.close();
  db.close();
});

interface MessageJson {
  id: number;
  from: string;
  to: string;
  sentAt: string;
  body: string;
  broadcast: boolean;
  read: boolean;
}

const base = () => `http://127.0.0.1:${http.port}`;
const auth = (token: string | null): Record<string, string> => (token === null ? {} : { Authorization: `Bearer ${token}` });
const get = (path: string, token: string | null, method = "GET") => fetch(`${base()}${path}`, { method, headers: auth(token) });
const ok = async <T>(path: string, token: string): Promise<T> => {
  const res = await get(path, token);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/json");
  return (await res.json()) as T;
};
const messages = (token: string, query = "") => ok<MessageJson[]>(`/api/messages${query}`, token);
const register = (account: AccountId, ...names: string[]) => names.forEach((n) => registerAgent(db, account, n, "x"));
const snapshot = () =>
  JSON.stringify([
    db.prepare("SELECT id, read_at FROM messages ORDER BY id").all(),
    db.prepare("SELECT id, last_seen FROM agents ORDER BY id").all(),
    db.prepare("SELECT * FROM channel_reads ORDER BY agent_id, channel_id").all(),
  ]);

describe("GET /api/messages", () => {
  it("lists the account's messages oldest first, a broadcast once per recipient, for every kind of token", async () => {
    register(OWNER_ACCOUNT, "alice", "bob", "carol");
    sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "hello bob");
    sendMessage(db, OWNER_ACCOUNT, "bob", "all", "hello everyone");
    readInbox(db, OWNER_ACCOUNT, "bob");
    const sentAt = (db.prepare("SELECT created_at FROM messages ORDER BY id").pluck().all() as number[]).map((t) =>
      new Date(t).toISOString(),
    );
    const ids = db.prepare("SELECT id FROM messages ORDER BY id").pluck().all() as number[];
    for (const token of [OWNER_TOKEN, ownerFull, ownerViewer]) {
      expect(await (await get("/api/messages", token)).text()).not.toContain(token);
      expect(await messages(token)).toEqual([
        { id: ids[0], from: "alice", to: "bob", sentAt: sentAt[0], body: "hello bob", broadcast: false, read: true },
        { id: ids[1], from: "bob", to: "alice", sentAt: sentAt[1], body: "hello everyone", broadcast: true, read: false },
        { id: ids[2], from: "bob", to: "carol", sentAt: sentAt[2], body: "hello everyone", broadcast: true, read: false },
      ]);
    }
  });

  it("shows a message to an unregistered agent under the name it had, not the placeholder", async () => {
    register(OWNER_ACCOUNT, "alice");
    const bob = registerAgent(db, OWNER_ACCOUNT, "Bob", "x").key;
    sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "kept");
    removeAgent(db, OWNER_ACCOUNT, "Bob", bob);
    // A new agent may take the freed name; the old message still names the old recipient, the new one its own.
    register(OWNER_ACCOUNT, "bob");
    sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "new");
    expect((await messages(ownerViewer)).map((m) => [m.to, m.body])).toEqual([
      ["Bob", "kept"],
      ["bob", "new"],
    ]);
  });

  it("never returns another account's messages, whatever the token, even between agents of the same names", async () => {
    register(OWNER_ACCOUNT, "alice", "bob");
    register(friend, "alice", "bob", "fred");
    sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "owner's message");
    sendMessage(db, friend, "alice", "bob", "friend's message");
    sendMessage(db, friend, "fred", "all", "friend's broadcast");
    const fredKey = registerAgent(db, friend, "gone", "x").key;
    sendMessage(db, friend, "fred", "gone", "friend's kept message");
    removeAgent(db, friend, "gone", fredKey);
    const query = `?limit=200&account=${friend}&agent=fred`;
    for (const token of [OWNER_TOKEN, ownerFull, ownerViewer]) {
      const text = await (await get(`/api/messages${query}`, token)).text();
      expect(text).not.toContain("friend's");
      expect((await messages(token, query)).map((m) => [m.from, m.to, m.body])).toEqual([["alice", "bob", "owner's message"]]);
    }
    for (const token of [friendToken, friendViewer]) {
      expect((await messages(token, "?limit=200")).map((m) => [m.from, m.to, m.body])).toEqual([
        ["alice", "bob", "friend's message"],
        ["fred", "alice", "friend's broadcast"],
        ["fred", "bob", "friend's broadcast"],
        ["fred", "gone", "friend's kept message"],
      ]);
    }
  });

  it("pages with limit and offset like GET /api/channels, and refuses bad values with 400", async () => {
    register(friend, "fred", "gina");
    for (const body of ["a", "b", "c", "d"]) sendMessage(db, friend, "fred", "gina", body);
    const bodies = async (query: string) => (await messages(friendViewer, query)).map((m) => m.body);
    expect(await bodies("?limit=2")).toEqual(["a", "b"]);
    expect(await bodies("?limit=2&offset=2")).toEqual(["c", "d"]);
    expect(await bodies("?offset=3")).toEqual(["d"]);
    expect(await bodies("?offset=9")).toEqual([]);
    for (let i = 0; i < 205; i++) sendMessage(db, friend, "fred", "gina", `m${i}`);
    expect(await messages(friendViewer)).toHaveLength(50);
    expect(await messages(friendViewer, "?limit=200")).toHaveLength(200);
    const bad = ["?limit=0", "?limit=201", "?limit=x", "?offset=-1", "?limit=1.5", "?limit="];
    bad.push("?limit=1&limit=x", "?limit=x&limit=1", "?offset=0&offset=-1", "?limit=2&limit=2");
    for (const query of bad) expect((await get(`/api/messages${query}`, friendViewer)).status).toBe(400);
  });

  it("changes nothing, with or without unread: no message is marked read, and unread counts, lastSeen and /wait stay as they were", async () => {
    register(OWNER_ACCOUNT, "alice", "bob");
    sendMessage(db, OWNER_ACCOUNT, "bob", "alice", "unread");
    sendMessage(db, OWNER_ACCOUNT, "alice", "all", "unread too");
    db.prepare("UPDATE agents SET last_seen = 0").run();
    const waitBefore = await (await get("/wait?agent=alice", OWNER_TOKEN)).text();
    const before = snapshot();
    const agentsBefore = await ok<unknown>("/api/agents", ownerViewer);
    for (const token of [OWNER_TOKEN, ownerFull, ownerViewer]) {
      await messages(token);
      expect((await messages(token, "?unread=true")).map((m) => m.body)).toEqual(["unread", "unread too"]);
    }
    expect(snapshot()).toBe(before);
    expect(db.prepare("SELECT COUNT(*) FROM messages WHERE read_at IS NOT NULL").pluck().get()).toBe(0);
    expect(await ok<unknown>("/api/agents", ownerViewer)).toEqual(agentsBefore);
    expect(await (await get("/wait?agent=alice", OWNER_TOKEN)).text()).toBe(waitBefore);
    expect(waitBefore).toBe("1 unread message from bob\n");
  });

  describe("?unread=true", () => {
    it("answers only the messages whose recipient has not read them, a broadcast once per unread recipient", async () => {
      register(OWNER_ACCOUNT, "alice", "bob", "carol");
      sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "read by bob");
      readInbox(db, OWNER_ACCOUNT, "bob");
      sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "unread by bob");
      sendMessage(db, OWNER_ACCOUNT, "bob", "all", "hello everyone");
      readInbox(db, OWNER_ACCOUNT, "alice");
      const all = await messages(ownerViewer);
      for (const token of [OWNER_TOKEN, ownerFull, ownerViewer]) {
        // The same shape and order as without unread, less the rows that have been read.
        expect(await messages(token, "?unread=true")).toEqual(all.filter((m) => !m.read));
        expect((await messages(token, "?unread=true")).map((m) => [m.to, m.body, m.broadcast, m.read])).toEqual([
          ["bob", "unread by bob", false, false],
          ["carol", "hello everyone", true, false],
        ]);
      }
      readInbox(db, OWNER_ACCOUNT, "carol");
      expect((await messages(ownerViewer, "?unread=true")).map((m) => [m.to, m.body])).toEqual([["bob", "unread by bob"]]);
    });

    it("never answers another account's unread messages, even between agents of the same names", async () => {
      register(OWNER_ACCOUNT, "alice", "bob");
      register(friend, "alice", "bob", "fred");
      sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "owner's message");
      sendMessage(db, friend, "alice", "bob", "friend's message");
      sendMessage(db, friend, "fred", "all", "friend's broadcast");
      const query = `?unread=true&limit=200&account=${friend}&agent=fred`;
      for (const token of [OWNER_TOKEN, ownerFull, ownerViewer]) {
        expect(await (await get(`/api/messages${query}`, token)).text()).not.toContain("friend's");
        expect((await messages(token, query)).map((m) => [m.from, m.to, m.body])).toEqual([["alice", "bob", "owner's message"]]);
      }
      for (const token of [friendToken, friendViewer]) {
        expect((await messages(token, "?unread=true")).map((m) => [m.from, m.to, m.body])).toEqual([
          ["alice", "bob", "friend's message"],
          ["fred", "alice", "friend's broadcast"],
          ["fred", "bob", "friend's broadcast"],
        ]);
      }
    });

    it("pages the unread messages with limit and offset", async () => {
      register(friend, "fred", "gina");
      for (const body of ["a", "b", "c", "d", "e"]) sendMessage(db, friend, "fred", "gina", body);
      readInbox(db, friend, "gina", true, 1);
      const bodies = async (query: string) => (await messages(friendViewer, `?unread=true${query}`)).map((m) => m.body);
      expect(await bodies("")).toEqual(["b", "c", "d", "e"]);
      expect(await bodies("&limit=2")).toEqual(["b", "c"]);
      expect(await bodies("&limit=2&offset=2")).toEqual(["d", "e"]);
      expect(await bodies("&offset=9")).toEqual([]);
      for (let i = 0; i < 205; i++) sendMessage(db, friend, "fred", "gina", `m${i}`);
      expect(await messages(friendViewer, "?unread=true")).toHaveLength(50);
      expect(await messages(friendViewer, "?unread=true&limit=200")).toHaveLength(200);
    });

    it("refuses unread given twice or with any value but true with 400", async () => {
      const bad = ["?unread=", "?unread=false", "?unread=1", "?unread=TRUE", "?unread=true&unread=true", "?unread=true&unread=false"];
      bad.push("?unread", "?unread=true&limit=0");
      for (const query of bad) expect((await get(`/api/messages${query}`, friendViewer)).status).toBe(400);
      expect((await get("/api/messages?unread=true", friendViewer)).status).toBe(200);
    });
  });

  it("answers 405 with Allow: GET to any method but GET", async () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      for (const token of [ownerViewer, OWNER_TOKEN]) {
        const res = await get("/api/messages", token, method);
        expect(res.status).toBe(405);
        expect(res.headers.get("allow")).toBe("GET");
      }
    }
  });

  it("answers 401 to no token, a wrong token and a revoked token", async () => {
    for (const token of [null, "nope"]) {
      const res = await get("/api/messages", token);
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe("Bearer");
    }
    expect((await get("/api/messages", null, "POST")).status).toBe(401);
    expect((await fetch(`${base()}/api/messages`, { headers: { Authorization: friendViewer } })).status).toBe(401);
    const viewer = addToken(db, "friend", true);
    expect((await get("/api/messages", viewer.token)).status).toBe(200);
    revokeToken(db, viewer.id);
    expect((await get("/api/messages", viewer.token)).status).toBe(401);
  });

  it("answers 503 with Retry-After when the database is busy, and 500 for any other failure", async () => {
    register(OWNER_ACCOUNT, "alice", "bob");
    sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "x");
    // The first query reading messages fails once with `code`; the token lookup before it still works.
    const prepare = db.prepare.bind(db);
    const fail = (code: string) => {
      vi.restoreAllMocks();
      let thrown = false;
      vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
        if (thrown || !sql.includes("FROM messages")) return prepare(sql);
        thrown = true;
        throw Object.assign(new Error("database is locked"), { code });
      }) as typeof db.prepare);
    };
    fail("SQLITE_BUSY");
    const res = await get("/api/messages", ownerViewer);
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("1");
    fail("SQLITE_BUSY_SNAPSHOT");
    expect((await get("/api/messages", ownerViewer)).status).toBe(503);
    fail("SQLITE_CORRUPT");
    expect((await get("/api/messages", ownerViewer)).status).toBe(500);
    vi.restoreAllMocks();
    expect((await messages(ownerViewer)).map((m) => m.body)).toEqual(["x"]);
  });

  it("leaves a read-only token refused on /mcp, /wait and every other path", async () => {
    for (const path of ["/mcp", "/wait?agent=x", "/api/message", "/api/messages/1"]) {
      expect((await get(path, ownerViewer)).status).toBe(403);
    }
  });
});
