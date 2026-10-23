import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addAccount, addToken, listAccounts, revokeToken } from "../src/accounts.js";
import { registerWithIdentity, removeAgent, type Identity } from "../src/agents.js";
import { joinChannel, post } from "../src/channels.js";
import { OWNER_ACCOUNT, openDb, type AccountId, type Db } from "../src/db.js";
import { startHttp, type HttpServer } from "../src/http.js";
import { MAX_SEARCH_LENGTH, readInbox, search, sendMessage } from "../src/messages.js";

// GET /api/search, on a server with the owner's account and a friend's.
const OWNER_TOKEN = "owner-token";
let db: Db;
let http: HttpServer;
let friend: AccountId;
let friendToken: string;
let friendViewer: string;
let ownerViewer: string;
let ownerFull: string;

beforeEach(async () => {
  db = openDb(join(mkdtempSync(join(tmpdir(), "message-cp-api-search-")), "db.sqlite"));
  stamped.messages = stamped.channel_posts = 0;
  friendToken = addAccount(db, "friend").token;
  friend = listAccounts(db).find((a) => a.name === "friend")!.id;
  friendViewer = addToken(db, "friend", true).token;
  ownerViewer = addToken(db, "owner", true).token;
  ownerFull = addToken(db, "owner").token;
  http = await startHttp(db, { token: OWNER_TOKEN, port: 0, waitHoldMs: 0 });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await http.close();
  db.close();
});

interface Match {
  kind: "message" | "post";
  id: number;
  from: string;
  to?: string;
  channel?: string;
  sentAt: string;
  body: string;
  broadcast?: boolean;
  read?: boolean;
}

const base = () => `http://127.0.0.1:${http.port}`;
const auth = (token: string | null): Record<string, string> => (token === null ? {} : { Authorization: `Bearer ${token}` });
const get = (path: string, token: string | null, method = "GET") => fetch(`${base()}${path}`, { method, headers: auth(token) });
const ok = async <T>(path: string, token: string): Promise<T> => {
  const res = await get(path, token);
  expect(res.status, await res.clone().text()).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/json");
  return (await res.json()) as T;
};
const find = (token: string, query: string) => ok<Match[]>(`/api/search?${query}`, token);
const bodies = async (token: string, query: string) => (await find(token, query)).map((m) => m.body);

const members = new Map<string, Identity & { name: string }>();
const register = (account: AccountId, ...names: string[]) => {
  for (const name of names) members.set(`${account}:${name}`, { ...registerWithIdentity(db, account, name, "x").identity, name });
};
const member = (account: AccountId, name: string) => members.get(`${account}:${name}`)!;
// Each message and post at its own second from a fixed time, so newest first is a known order: the rows just
// written, found by id whatever the real time is, move to the next second.
let clock = Date.UTC(2026, 9, 1);
const stamped = { messages: 0, channel_posts: 0 };
const at = (table: "messages" | "channel_posts") => {
  clock += 1000;
  db.prepare(`UPDATE ${table} SET created_at = ? WHERE id > ?`).run(clock, stamped[table]);
  stamped[table] = db.prepare(`SELECT COALESCE(MAX(id), 0) FROM ${table}`).pluck().get() as number;
};
const send = (account: AccountId, from: string, to: string, body: string) => {
  sendMessage(db, account, from, to, body);
  at("messages");
};
const postTo = (account: AccountId, from: string, channel: string, body: string) => {
  const id = post(db, account, member(account, from), channel, body).id;
  at("channel_posts");
  return id;
};
const iso = (table: string, id: number) =>
  new Date(db.prepare(`SELECT created_at FROM ${table} WHERE id = ?`).pluck().get(id) as number).toISOString();
const snapshot = () =>
  JSON.stringify([
    db.prepare("SELECT id, read_at FROM messages ORDER BY id").all(),
    db.prepare("SELECT * FROM mentions ORDER BY agent_id, post_id").all(),
    db.prepare("SELECT id, last_seen FROM agents ORDER BY id").all(),
    db.prepare("SELECT * FROM channel_reads ORDER BY agent_id, channel_id").all(),
  ]);

describe("GET /api/search", () => {
  beforeEach(() => members.clear());

  it("finds the account's messages and posts by text, newest first, for every kind of token", async () => {
    register(OWNER_ACCOUNT, "alice", "bob", "carol");
    send(OWNER_ACCOUNT, "alice", "bob", "the Deploy is done");
    send(OWNER_ACCOUNT, "bob", "all", "deploy again tomorrow");
    const postId = postTo(OWNER_ACCOUNT, "carol", "ops", "DEPLOY log attached");
    send(OWNER_ACCOUNT, "alice", "bob", "unrelated");
    readInbox(db, OWNER_ACCOUNT, "bob");
    const ids = db.prepare("SELECT id FROM messages ORDER BY id").pluck().all() as number[];
    for (const token of [OWNER_TOKEN, ownerFull, ownerViewer]) {
      expect(await find(token, "text=deploy")).toEqual([
        { kind: "post", channel: "ops", id: postId, from: "carol", sentAt: iso("channel_posts", postId), body: "DEPLOY log attached" },
        // A broadcast is one message per recipient, as in GET /api/messages.
        { kind: "message", id: ids[2], from: "bob", to: "carol", sentAt: iso("messages", ids[2]), body: "deploy again tomorrow", broadcast: true, read: false },
        { kind: "message", id: ids[1], from: "bob", to: "alice", sentAt: iso("messages", ids[1]), body: "deploy again tomorrow", broadcast: true, read: false },
        { kind: "message", id: ids[0], from: "alice", to: "bob", sentAt: iso("messages", ids[0]), body: "the Deploy is done", broadcast: false, read: true },
      ]);
    }
  });

  it("shows a message to an unregistered agent under the name it had", async () => {
    register(OWNER_ACCOUNT, "alice");
    const bob = registerWithIdentity(db, OWNER_ACCOUNT, "Bob", "x");
    send(OWNER_ACCOUNT, "alice", "bob", "kept note");
    removeAgent(db, OWNER_ACCOUNT, "Bob", bob.result.key);
    expect((await find(ownerViewer, "text=note")).map((m) => [m.to, m.body])).toEqual([["Bob", "kept note"]]);
  });

  it("puts a post before a message of the same millisecond, and each kind newest id first", async () => {
    register(OWNER_ACCOUNT, "alice", "bob");
    sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "tie m1");
    post(db, OWNER_ACCOUNT, member(OWNER_ACCOUNT, "alice"), "ops", "tie p1");
    sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "tie m2");
    post(db, OWNER_ACCOUNT, member(OWNER_ACCOUNT, "alice"), "ops", "tie p2");
    db.prepare("UPDATE messages SET created_at = 1000").run();
    db.prepare("UPDATE channel_posts SET created_at = 1000").run();
    expect(await bodies(ownerViewer, "text=tie")).toEqual(["tie p2", "tie p1", "tie m2", "tie m1"]);
  });

  it("matches %, _ and \\ literally, and ASCII letters in any case", async () => {
    register(OWNER_ACCOUNT, "alice", "bob");
    for (const body of ["100% done", "1000 done", "snake_case", "snakeXcase", "a\\b", "ab", "MiXeD"]) {
      send(OWNER_ACCOUNT, "alice", "bob", body);
    }
    expect(await bodies(ownerViewer, `text=${encodeURIComponent("0%")}`)).toEqual(["100% done"]);
    expect(await bodies(ownerViewer, "text=e_c")).toEqual(["snake_case"]);
    expect(await bodies(ownerViewer, `text=${encodeURIComponent("a\\b")}`)).toEqual(["a\\b"]);
    expect(await bodies(ownerViewer, "text=mixed")).toEqual(["MiXeD"]);
  });

  it("filters by channel, sender in any case, since and until as the search tool does", async () => {
    register(OWNER_ACCOUNT, "alice", "bob");
    send(OWNER_ACCOUNT, "alice", "bob", "x one");
    postTo(OWNER_ACCOUNT, "bob", "ops", "x two");
    postTo(OWNER_ACCOUNT, "alice", "dev", "x three");
    send(OWNER_ACCOUNT, "bob", "alice", "x four");
    expect(await bodies(ownerViewer, "text=x&channel=ops")).toEqual(["x two"]);
    expect(await bodies(ownerViewer, "text=x&channel=nope")).toEqual([]);
    // A message that names the channel is still not one of its posts.
    send(OWNER_ACCOUNT, "alice", "bob", "ops note");
    expect(await bodies(ownerViewer, "text=ops&channel=ops")).toEqual([]);
    expect(await bodies(ownerViewer, "text=ops")).toEqual(["ops note"]);
    expect(await bodies(ownerViewer, "text=x&from=ALICE")).toEqual(["x three", "x one"]);
    const second = iso("channel_posts", db.prepare("SELECT id FROM channel_posts WHERE body = 'x two'").pluck().get() as number);
    const third = iso("channel_posts", db.prepare("SELECT id FROM channel_posts WHERE body = 'x three'").pluck().get() as number);
    expect(await bodies(ownerViewer, `text=x&since=${encodeURIComponent(second)}`)).toEqual(["x four", "x three", "x two"]);
    expect(await bodies(ownerViewer, `text=x&until=${encodeURIComponent(third)}`)).toEqual(["x two", "x one"]);
    expect(await bodies(ownerViewer, `text=x&since=${second}&until=${third}&from=bob`)).toEqual(["x two"]);
    expect(await bodies(ownerViewer, "text=x&since=2026-10-02")).toEqual([]);
    expect(await bodies(ownerViewer, "text=x&until=2026-10-01")).toEqual([]);
  });

  it("gives the search tool's results for the same posts, and leaves the tool's own results unchanged", async () => {
    register(OWNER_ACCOUNT, "alice", "bob");
    send(OWNER_ACCOUNT, "alice", "bob", "find me");
    postTo(OWNER_ACCOUNT, "alice", "ops", "find me too");
    const tool = search(db, OWNER_ACCOUNT, member(OWNER_ACCOUNT, "bob"), "find");
    expect(tool).toEqual([
      expect.objectContaining({ kind: "post", body: "find me too" }),
      { kind: "message", id: expect.any(Number), inReplyTo: null, from: "alice", sentAt: expect.any(String), body: "find me", broadcast: false },
    ]);
    const found = await find(ownerViewer, "text=find");
    expect(found[0]).toEqual(tool[0]);
    expect(search(db, OWNER_ACCOUNT, member(OWNER_ACCOUNT, "alice"), "find").map((m) => m.body)).toEqual(["find me too"]);
  });

  it("never returns another account's messages, posts or channels, even with the same names", async () => {
    register(OWNER_ACCOUNT, "alice", "bob");
    register(friend, "alice", "bob", "fred");
    send(OWNER_ACCOUNT, "alice", "bob", "owner's secret");
    postTo(OWNER_ACCOUNT, "alice", "ops", "owner's secret post");
    send(friend, "alice", "bob", "friend's secret");
    send(friend, "fred", "all", "friend's secret broadcast");
    postTo(friend, "alice", "ops", "friend's secret post");
    postTo(friend, "fred", "hidden", "friend's secret elsewhere");
    for (const token of [OWNER_TOKEN, ownerFull, ownerViewer]) {
      for (const query of ["text=secret&limit=200", "text=friend", "text=secret&channel=ops", "text=secret&channel=hidden", "text=secret&from=fred"]) {
        const text = await (await get(`/api/search?${query}&account=${friend}`, token)).text();
        expect(text).not.toContain("friend");
        expect(text).not.toContain("hidden");
      }
      expect(await bodies(token, "text=secret")).toEqual(["owner's secret post", "owner's secret"]);
    }
    for (const token of [friendToken, friendViewer]) {
      expect(await bodies(token, "text=secret&limit=200")).toEqual([
        "friend's secret elsewhere",
        "friend's secret post",
        "friend's secret broadcast",
        "friend's secret broadcast",
        "friend's secret",
      ]);
      expect(await bodies(token, "text=owner")).toEqual([]);
    }
  });

  it("pages with limit and offset, and refuses bad values with 400", async () => {
    register(friend, "fred", "gina");
    for (const body of ["a1", "a2", "a3", "a4"]) send(friend, "fred", "gina", body);
    expect(await bodies(friendViewer, "text=a&limit=2")).toEqual(["a4", "a3"]);
    expect(await bodies(friendViewer, "text=a&limit=2&offset=2")).toEqual(["a2", "a1"]);
    expect(await bodies(friendViewer, "text=a&offset=9")).toEqual([]);
    for (let i = 0; i < 205; i++) sendMessage(db, friend, "fred", "gina", `a-many ${i}`);
    expect(await find(friendViewer, "text=a")).toHaveLength(50);
    expect(await find(friendViewer, "text=a&limit=200")).toHaveLength(200);
    const bad = ["limit=0", "limit=201", "limit=x", "offset=-1", "limit=1.5", "limit=", "limit=1&limit=1", "offset=0&offset=1"];
    for (const query of bad) expect((await get(`/api/search?text=a&${query}`, friendViewer)).status).toBe(400);
  });

  it("refuses a missing or invalid text, channel, since or until, and any key given twice, with 400", async () => {
    register(OWNER_ACCOUNT, "alice");
    const long = "x".repeat(MAX_SEARCH_LENGTH + 1);
    const bad = [
      "",
      "text=",
      `text=${long}`,
      `text=${encodeURIComponent("😀".repeat(MAX_SEARCH_LENGTH + 1))}`,
      "text=a&text=a",
      "text=a&text=b",
      "text=a&channel=bad%20name",
      "text=a&channel=",
      "text=a&channel=ops&channel=ops",
      "text=a&from=alice&from=bob",
      "text=a&since=yesterday",
      "text=a&since=2026-02-30",
      "text=a&since=2026-10-01&since=2026-10-02",
      "text=a&until=10/20/2026",
      "text=a&until=2026-10-01&until=2026-10-01",
    ];
    for (const query of bad) {
      const res = await get(`/api/search?${query}`, ownerViewer);
      expect(res.status, query).toBe(400);
    }
    const res = await get("/api/search?text=a&since=nope", ownerViewer);
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/^Invalid since/);
    expect(await bodies(ownerViewer, `text=${"x".repeat(MAX_SEARCH_LENGTH)}`)).toEqual([]);
    expect(await bodies(ownerViewer, `text=${encodeURIComponent("😀".repeat(MAX_SEARCH_LENGTH))}`)).toEqual([]);
  });

  it("changes nothing: no message or mention is marked read, and no read position, unread count or /wait moves", async () => {
    register(OWNER_ACCOUNT, "alice", "bob");
    joinChannel(db, OWNER_ACCOUNT, member(OWNER_ACCOUNT, "alice"), "ops");
    send(OWNER_ACCOUNT, "bob", "alice", "unread hello");
    postTo(OWNER_ACCOUNT, "bob", "ops", "unread hello @alice");
    db.prepare("UPDATE agents SET last_seen = 0").run();
    const waitBefore = await (await get("/wait?agent=alice", OWNER_TOKEN)).text();
    const agentsBefore = await ok<unknown>("/api/agents", ownerViewer);
    const before = snapshot();
    for (const token of [OWNER_TOKEN, ownerFull, ownerViewer]) {
      expect(await find(token, "text=hello")).toHaveLength(2);
      await find(token, "text=hello&channel=ops");
    }
    expect(snapshot()).toBe(before);
    expect(db.prepare("SELECT COUNT(*) FROM messages WHERE read_at IS NOT NULL").pluck().get()).toBe(0);
    expect(db.prepare("SELECT COUNT(*) FROM mentions WHERE read_at IS NOT NULL").pluck().get()).toBe(0);
    expect(await ok<unknown>("/api/agents", ownerViewer)).toEqual(agentsBefore);
    expect(await (await get("/wait?agent=alice", OWNER_TOKEN)).text()).toBe(waitBefore);
    expect(waitBefore).toContain("1 unread message from bob");
    expect(readInbox(db, OWNER_ACCOUNT, "alice").map((m) => m.body)).toEqual(["unread hello", "unread hello @alice"]);
  });

  it("answers 405 with Allow: GET to any method but GET", async () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      for (const token of [ownerViewer, OWNER_TOKEN]) {
        const res = await get("/api/search?text=a", token, method);
        expect(res.status).toBe(405);
        expect(res.headers.get("allow")).toBe("GET");
      }
    }
  });

  it("answers 401 to no token, a wrong token and a revoked token", async () => {
    for (const token of [null, "nope"]) {
      const res = await get("/api/search?text=a", token);
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe("Bearer");
    }
    expect((await fetch(`${base()}/api/search?text=a`, { headers: { Authorization: friendViewer } })).status).toBe(401);
    const viewer = addToken(db, "friend", true);
    expect((await get("/api/search?text=a", viewer.token)).status).toBe(200);
    revokeToken(db, viewer.id);
    expect((await get("/api/search?text=a", viewer.token)).status).toBe(401);
  });

  it("answers 503 with Retry-After when the database is busy, and 500 for any other failure", async () => {
    register(OWNER_ACCOUNT, "alice", "bob");
    send(OWNER_ACCOUNT, "alice", "bob", "x");
    // The first query reading posts fails once with `code`; the token lookup before it still works.
    const prepare = db.prepare.bind(db);
    const fail = (code: string) => {
      vi.restoreAllMocks();
      let thrown = false;
      vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
        if (thrown || !sql.includes("FROM channel_posts")) return prepare(sql);
        thrown = true;
        throw Object.assign(new Error("database is locked"), { code });
      }) as typeof db.prepare);
    };
    fail("SQLITE_BUSY");
    const res = await get("/api/search?text=x", ownerViewer);
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("1");
    fail("SQLITE_CORRUPT");
    expect((await get("/api/search?text=x", ownerViewer)).status).toBe(500);
    vi.restoreAllMocks();
    expect(await bodies(ownerViewer, "text=x")).toEqual(["x"]);
  });

  it("logs nothing per request: no search text, body or token", async () => {
    register(OWNER_ACCOUNT, "alice", "bob");
    send(OWNER_ACCOUNT, "alice", "bob", "quiet body");
    const log = vi.spyOn(console, "log");
    const error = vi.spyOn(console, "error");
    await find(ownerViewer, "text=quiet");
    await get("/api/search?text=quiet&since=bad", ownerViewer);
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});
