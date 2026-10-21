import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addAccount, addToken, listAccounts, revokeToken } from "../src/accounts.js";
import { registerAgent, registerWithIdentity, removeAgent } from "../src/agents.js";
import { post } from "../src/channels.js";
import { OWNER_ACCOUNT, openDb, type AccountId, type Db } from "../src/db.js";
import { startHttp, type HttpServer } from "../src/http.js";
import { listAccountMessages, readInbox, sendMessage } from "../src/messages.js";
import { addWebhook } from "../src/webhooks.js";

// DELETE /api/conversation, on a server with the owner's account and a friend's.
const OWNER_TOKEN = "owner-token";
let db: Db;
let http: HttpServer;
let friend: AccountId;
let friendToken: string;
let ownerViewer: string;
let ownerFull: string;

beforeEach(async () => {
  db = openDb(join(mkdtempSync(join(tmpdir(), "message-cp-api-conversation-")), "db.sqlite"));
  friendToken = addAccount(db, "friend").token;
  friend = listAccounts(db).find((a) => a.name === "friend")!.id;
  ownerViewer = addToken(db, "owner", true).token;
  ownerFull = addToken(db, "owner").token;
  http = await startHttp(db, { token: OWNER_TOKEN, port: 0, waitHoldMs: 0 });
});

afterEach(async () => {
  await http.close();
  db.close();
});

const base = () => `http://127.0.0.1:${http.port}`;
const auth = (token: string | null): Record<string, string> => (token === null ? {} : { Authorization: `Bearer ${token}` });
const call = (query: string, token: string | null, method = "DELETE") =>
  fetch(`${base()}/api/conversation${query}`, { method, headers: auth(token) });
const del = async (query: string, token: string) => {
  const res = await call(query, token);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/json");
  return (await res.json()) as unknown;
};
const register = (account: AccountId, ...names: string[]) => names.forEach((n) => registerAgent(db, account, n, "x"));
const left = (account: AccountId) => listAccountMessages(db, account, 200, 0).map((m) => [m.from, m.to, m.body]);

describe("DELETE /api/conversation", () => {
  it("deletes the messages between a and b both ways, in any case and either order, and answers the count", async () => {
    register(OWNER_ACCOUNT, "alice", "Bob", "carol");
    sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "a to b");
    sendMessage(db, OWNER_ACCOUNT, "bob", "alice", "b to a");
    sendMessage(db, OWNER_ACCOUNT, "alice", "carol", "a to c");
    sendMessage(db, OWNER_ACCOUNT, "carol", "bob", "c to b");
    readInbox(db, OWNER_ACCOUNT, "Bob");
    expect(await del("?a=BOB&b=Alice", ownerFull)).toEqual({ deleted: 2 });
    expect(left(OWNER_ACCOUNT)).toEqual([
      ["alice", "carol", "a to c"],
      ["carol", "Bob", "c to b"],
    ]);
    expect(await del("?b=bob&a=alice", OWNER_TOKEN)).toEqual({ deleted: 0 });
    expect(await del("?a=nobody&b=alice", ownerFull)).toEqual({ deleted: 0 });
  });

  it("deletes a broadcast's row for the pair only, leaving its rows for other recipients", async () => {
    register(OWNER_ACCOUNT, "alice", "bob", "carol");
    sendMessage(db, OWNER_ACCOUNT, "alice", "all", "hello everyone");
    expect(await del("?a=bob&b=alice", ownerFull)).toEqual({ deleted: 1 });
    expect(left(OWNER_ACCOUNT)).toEqual([["alice", "carol", "hello everyone"]]);
  });

  it("deletes messages to an unregistered agent by the name it had, and not a later agent's of that name only by it", async () => {
    register(OWNER_ACCOUNT, "alice", "dave");
    const key = registerAgent(db, OWNER_ACCOUNT, "Bob", "x").key;
    sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "to the old bob");
    removeAgent(db, OWNER_ACCOUNT, "Bob", key);
    register(OWNER_ACCOUNT, "bob");
    sendMessage(db, OWNER_ACCOUNT, "dave", "bob", "to the new bob");
    expect(await del("?a=alice&b=bob", ownerFull)).toEqual({ deleted: 1 });
    expect(left(OWNER_ACCOUNT)).toEqual([["dave", "bob", "to the new bob"]]);
  });

  it("never touches another account's messages between the same names, whichever account's token", async () => {
    register(OWNER_ACCOUNT, "alice", "bob");
    register(friend, "alice", "bob");
    sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "owner's");
    sendMessage(db, friend, "alice", "bob", "friend's");
    sendMessage(db, friend, "bob", "alice", "friend's reply");
    expect(await del(`?a=alice&b=bob&account=${friend}`, ownerFull)).toEqual({ deleted: 1 });
    expect(left(OWNER_ACCOUNT)).toEqual([]);
    expect(left(friend)).toEqual([
      ["alice", "bob", "friend's"],
      ["bob", "alice", "friend's reply"],
    ]);
    expect(await del("?a=alice&b=bob", friendToken)).toEqual({ deleted: 2 });
    expect(left(friend)).toEqual([]);
  });

  it("leaves channel posts and mentions alone, takes the messages' webhook deliveries, and answers no body", async () => {
    const alice = registerWithIdentity(db, OWNER_ACCOUNT, "alice", "x");
    register(OWNER_ACCOUNT, "bob");
    addWebhook(db, "owner", "https://example.com/hook", "agent:bob", true);
    addWebhook(db, "owner", "https://example.com/hook", "mention:bob", true);
    post(db, OWNER_ACCOUNT, { ...alice.identity, name: "alice" }, "dev", "@bob secret post");
    sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "secret message");
    const count = (table: string) => db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get();
    expect(count("webhook_deliveries")).toBe(2);
    const res = await call("?a=alice&b=bob", ownerFull);
    const text = await res.text();
    expect(text).toBe('{"deleted":1}');
    expect(count("messages")).toBe(0);
    expect(count("channel_posts")).toBe(1);
    expect(db.prepare("SELECT COUNT(*) FROM webhook_deliveries WHERE post_id IS NOT NULL").pluck().get()).toBe(1);
    expect(count("webhook_deliveries")).toBe(1);
    expect(readInbox(db, OWNER_ACCOUNT, "bob").map((m) => m.body)).toEqual(["@bob secret post"]);
  });

  it("logs nothing", async () => {
    register(OWNER_ACCOUNT, "alice", "bob");
    sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "x");
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m));
    const stderr = vi.spyOn(process.stderr, "write");
    const stdout = vi.spyOn(process.stdout, "write");
    await del("?a=alice&b=bob", ownerFull);
    for (const spy of [...spies, stderr, stdout]) expect(spy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("answers 400 to a missing, empty or repeated a or b, and deletes nothing", async () => {
    register(OWNER_ACCOUNT, "alice", "bob");
    sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "x");
    const bad = ["", "?a=alice", "?b=bob", "?a=&b=bob", "?a=alice&b=", "?a=alice&a=alice&b=bob", "?a=alice&b=bob&b=bob"];
    for (const query of bad) expect((await call(query, ownerFull)).status).toBe(400);
    expect(left(OWNER_ACCOUNT)).toHaveLength(1);
  });

  it("answers 403 to a read-only token, and deletes nothing", async () => {
    register(OWNER_ACCOUNT, "alice", "bob");
    sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "x");
    for (const method of ["DELETE", "GET"]) expect((await call("?a=alice&b=bob", ownerViewer, method)).status).toBe(403);
    expect(left(OWNER_ACCOUNT)).toHaveLength(1);
  });

  it("answers 405 with Allow: DELETE to any method but DELETE, and GET /api/messages still 405s a DELETE", async () => {
    for (const method of ["GET", "POST", "PUT", "PATCH"]) {
      const res = await call("?a=alice&b=bob", ownerFull, method);
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("DELETE");
    }
    const res = await fetch(`${base()}/api/messages?a=alice&b=bob`, { method: "DELETE", headers: auth(ownerFull) });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
  });

  it("answers 401 to no token, a wrong token and a revoked token", async () => {
    register(OWNER_ACCOUNT, "alice", "bob");
    sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "x");
    for (const token of [null, "nope"]) {
      const res = await call("?a=alice&b=bob", token);
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe("Bearer");
    }
    const full = addToken(db, "owner");
    revokeToken(db, full.id);
    expect((await call("?a=alice&b=bob", full.token)).status).toBe(401);
    expect(left(OWNER_ACCOUNT)).toHaveLength(1);
  });

  it("answers 503 with Retry-After when the database is busy, and 500 for any other failure", async () => {
    register(OWNER_ACCOUNT, "alice", "bob");
    sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "x");
    const prepare = db.prepare.bind(db);
    const fail = (code: string) => {
      vi.restoreAllMocks();
      let thrown = false;
      vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
        if (thrown || !sql.includes("DELETE FROM messages")) return prepare(sql);
        thrown = true;
        throw Object.assign(new Error("database is locked"), { code });
      }) as typeof db.prepare);
    };
    fail("SQLITE_BUSY");
    const res = await call("?a=alice&b=bob", ownerFull);
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("1");
    fail("SQLITE_CORRUPT");
    expect((await call("?a=alice&b=bob", ownerFull)).status).toBe(500);
    vi.restoreAllMocks();
    expect(left(OWNER_ACCOUNT)).toHaveLength(1);
  });
});
