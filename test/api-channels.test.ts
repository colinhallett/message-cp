import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addAccount, addToken, listAccounts, revokeToken } from "../src/accounts.js";
import { identityOf, registerAgent, removeAgent } from "../src/agents.js";
import { joinChannel, leaveChannel, post, type Member } from "../src/channels.js";
import { OWNER_ACCOUNT, openDb, type AccountId, type Db } from "../src/db.js";
import { startHttp, type HttpServer } from "../src/http.js";
import { sendMessage } from "../src/messages.js";

// GET /api/channels and GET /api/channel-posts, on a server with the owner's account and a friend's.
const OWNER_TOKEN = "owner-token";
let db: Db;
let http: HttpServer;
let friend: AccountId;
let friendToken: string;
let friendViewer: string;
let ownerViewer: string;
let ownerFull: string;

beforeEach(async () => {
  db = openDb(join(mkdtempSync(join(tmpdir(), "message-cp-api-channels-")), "db.sqlite"));
  friendToken = addAccount(db, "friend").token;
  friend = listAccounts(db).find((a) => a.name === "friend")!.id;
  friendViewer = addToken(db, "friend", true).token;
  ownerViewer = addToken(db, "owner", true).token;
  ownerFull = addToken(db, "owner").token;
  http = await startHttp(db, { token: OWNER_TOKEN, port: 0 });
});

afterEach(async () => {
  await http.close();
  db.close();
});

interface ChannelJson {
  name: string;
  posts: number;
  lastPostAt: string | null;
  members: string[];
}
interface PostsJson {
  channel: string;
  posts: { id: number; from: string; sentAt: string; body: string }[];
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
const channels = (token: string, query = "") => ok<ChannelJson[]>(`/api/channels${query}`, token);
const posts = (token: string, query: string) => ok<PostsJson>(`/api/channel-posts${query}`, token);
const member = (account: AccountId, name: string): Member => ({ ...identityOf(db, account, name)!, name });
const register = (account: AccountId, ...names: string[]) => names.forEach((n) => registerAgent(db, account, n, "x"));
const snapshot = () =>
  JSON.stringify([
    db.prepare("SELECT * FROM channel_reads ORDER BY agent_id, channel_id").all(),
    db.prepare("SELECT id, last_seen FROM agents ORDER BY id").all(),
    db.prepare("SELECT id, read_at FROM messages ORDER BY id").all(),
  ]);

describe("GET /api/channels", () => {
  it("lists the account's channels by name with post counts, last post time and live joined members, for every kind of token", async () => {
    register(OWNER_ACCOUNT, "carol", "alice", "bob");
    const dave = registerAgent(db, OWNER_ACCOUNT, "dave", "x").key;
    joinChannel(db, OWNER_ACCOUNT, member(OWNER_ACCOUNT, "carol"), "build");
    joinChannel(db, OWNER_ACCOUNT, member(OWNER_ACCOUNT, "alice"), "build");
    joinChannel(db, OWNER_ACCOUNT, member(OWNER_ACCOUNT, "bob"), "build");
    joinChannel(db, OWNER_ACCOUNT, member(OWNER_ACCOUNT, "dave"), "build");
    leaveChannel(db, OWNER_ACCOUNT, member(OWNER_ACCOUNT, "bob"), "build");
    post(db, OWNER_ACCOUNT, member(OWNER_ACCOUNT, "dave"), "build", "secret one");
    const last = post(db, OWNER_ACCOUNT, member(OWNER_ACCOUNT, "bob"), "build", "secret two");
    removeAgent(db, OWNER_ACCOUNT, "dave", dave);
    // Joined before anyone posted.
    joinChannel(db, OWNER_ACCOUNT, member(OWNER_ACCOUNT, "alice"), "Alpha");
    for (const token of [OWNER_TOKEN, ownerFull, ownerViewer]) {
      const text = await (await get("/api/channels", token)).text();
      expect(text).not.toContain("secret");
      expect(text).not.toContain(token);
      expect(await channels(token)).toEqual([
        { name: "Alpha", posts: 0, lastPostAt: null, members: ["alice"] },
        { name: "build", posts: 2, lastPostAt: last.sentAt, members: ["alice", "carol"] },
      ]);
    }
  });

  it("never shows another account's channel of the same name, its posts or its members, whatever the token", async () => {
    register(OWNER_ACCOUNT, "alice");
    register(friend, "fred", "alice");
    joinChannel(db, OWNER_ACCOUNT, member(OWNER_ACCOUNT, "alice"), "build");
    joinChannel(db, friend, member(friend, "fred"), "build");
    joinChannel(db, friend, member(friend, "alice"), "build");
    post(db, friend, member(friend, "fred"), "build", "friend's post");
    post(db, friend, member(friend, "fred"), "friends-only", "friend's other post");
    for (const token of [OWNER_TOKEN, ownerFull, ownerViewer]) {
      expect(await channels(token)).toEqual([{ name: "build", posts: 0, lastPostAt: null, members: ["alice"] }]);
    }
    for (const token of [friendToken, friendViewer]) {
      expect((await channels(token)).map((c) => [c.name, c.posts, c.members])).toEqual([
        ["build", 1, ["alice", "fred"]],
        ["friends-only", 1, []],
      ]);
    }
  });

  it("pages with limit and offset like GET /api/agents, and refuses bad values with 400", async () => {
    register(friend, "fred");
    for (const name of ["a", "b", "c", "d"]) joinChannel(db, friend, member(friend, "fred"), name);
    const names = async (query: string) => (await channels(friendViewer, query)).map((c) => c.name);
    expect(await names("?limit=2")).toEqual(["a", "b"]);
    expect(await names("?limit=2&offset=2")).toEqual(["c", "d"]);
    expect(await names("?offset=3")).toEqual(["d"]);
    expect(await names("?offset=9")).toEqual([]);
    for (let i = 0; i < 205; i++) joinChannel(db, friend, member(friend, "fred"), `z${String(i).padStart(3, "0")}`);
    expect(await channels(friendViewer)).toHaveLength(50);
    expect(await channels(friendViewer, "?limit=200")).toHaveLength(200);
    const bad = ["?limit=0", "?limit=201", "?limit=x", "?offset=-1", "?limit=1.5", "?limit="];
    bad.push("?limit=1&limit=x", "?limit=x&limit=1", "?offset=0&offset=-1", "?limit=2&limit=2");
    for (const query of bad) expect((await get(`/api/channels${query}`, friendViewer)).status).toBe(400);
  });
});

describe("GET /api/channel-posts", () => {
  it("returns the channel's posts oldest first under its stored name, for every kind of token", async () => {
    register(OWNER_ACCOUNT, "alice", "bob");
    const first = post(db, OWNER_ACCOUNT, member(OWNER_ACCOUNT, "bob"), "Build", "one");
    const second = post(db, OWNER_ACCOUNT, member(OWNER_ACCOUNT, "alice"), "build", "two");
    sendMessage(db, OWNER_ACCOUNT, "bob", "alice", "a direct message");
    for (const token of [OWNER_TOKEN, ownerFull, ownerViewer]) {
      const res = await get("/api/channel-posts?channel=BUILD", token);
      const text = await res.clone().text();
      expect(text).not.toContain("a direct message");
      expect(text).not.toContain(token);
      expect(await posts(token, "?channel=BUILD")).toEqual({
        channel: "Build",
        posts: [
          { id: first.id, from: "bob", sentAt: first.sentAt, body: "one" },
          { id: second.id, from: "alice", sentAt: second.sentAt, body: "two" },
        ],
      });
    }
  });

  it("pages with limit and offset, and refuses bad values with 400", async () => {
    register(friend, "fred");
    for (const body of ["a", "b", "c", "d"]) post(db, friend, member(friend, "fred"), "log", body);
    const bodies = async (query: string) => (await posts(friendViewer, `?channel=log${query}`)).posts.map((p) => p.body);
    expect(await bodies("&limit=2")).toEqual(["a", "b"]);
    expect(await bodies("&limit=2&offset=2")).toEqual(["c", "d"]);
    expect(await bodies("&offset=3")).toEqual(["d"]);
    expect(await bodies("&offset=9")).toEqual([]);
    for (let i = 0; i < 205; i++) post(db, friend, member(friend, "fred"), "log", `p${i}`);
    expect((await posts(friendViewer, "?channel=log")).posts).toHaveLength(50);
    expect((await posts(friendViewer, "?channel=log&limit=200")).posts).toHaveLength(200);
    const bad = ["&limit=0", "&limit=201", "&limit=x", "&offset=-1", "&limit=1.5", "&limit="];
    bad.push("&limit=1&limit=x", "&offset=0&offset=-1", "&limit=2&limit=2");
    for (const query of bad) expect((await get(`/api/channel-posts?channel=log${query}`, friendViewer)).status).toBe(400);
  });

  it("answers 404 to an invalid name, a missing or repeated channel and one that does not exist in the account", async () => {
    register(OWNER_ACCOUNT, "alice");
    register(friend, "fred");
    post(db, OWNER_ACCOUNT, member(OWNER_ACCOUNT, "alice"), "build", "owner's");
    post(db, friend, member(friend, "fred"), "friends-only", "secret friend post");
    const missing = [
      "",
      "?channel=",
      "?channel=nope",
      "?channel=bad%20name",
      `?channel=${"x".repeat(33)}`,
      "?channel=build&channel=build",
      "?channel=friends-only",
    ];
    for (const token of [OWNER_TOKEN, ownerFull, ownerViewer]) {
      for (const query of missing) {
        const res = await get(`/api/channel-posts${query}`, token);
        expect(res.status).toBe(404);
        expect(await res.text()).not.toContain("secret");
      }
    }
  });

  it("never shows another account's channel of the same name, whatever the token", async () => {
    register(OWNER_ACCOUNT, "alice");
    register(friend, "fred");
    post(db, OWNER_ACCOUNT, member(OWNER_ACCOUNT, "alice"), "build", "owner's post");
    post(db, friend, member(friend, "fred"), "build", "friend's post");
    for (const token of [OWNER_TOKEN, ownerFull, ownerViewer]) {
      expect((await posts(token, "?channel=build")).posts.map((p) => [p.from, p.body])).toEqual([["alice", "owner's post"]]);
    }
    for (const token of [friendToken, friendViewer]) {
      expect((await posts(token, "?channel=build")).posts.map((p) => [p.from, p.body])).toEqual([["fred", "friend's post"]]);
    }
  });
});

describe("both endpoints", () => {
  const paths = ["/api/channels", "/api/channel-posts?channel=build"];

  it("change nothing: read positions, last_seen and unread counts stay as they were", async () => {
    register(OWNER_ACCOUNT, "alice", "bob");
    joinChannel(db, OWNER_ACCOUNT, member(OWNER_ACCOUNT, "alice"), "build");
    post(db, OWNER_ACCOUNT, member(OWNER_ACCOUNT, "bob"), "build", "unread");
    post(db, OWNER_ACCOUNT, member(OWNER_ACCOUNT, "bob"), "build", "unread too");
    db.prepare("UPDATE agents SET last_seen = 0").run();
    const before = snapshot();
    const agentsBefore = await ok<unknown>("/api/agents", ownerViewer);
    for (const token of [OWNER_TOKEN, ownerFull, ownerViewer]) {
      for (const path of paths) await ok<unknown>(path, token);
    }
    expect(snapshot()).toBe(before);
    expect(await ok<unknown>("/api/agents", ownerViewer)).toEqual(agentsBefore);
  });

  it("answer 405 with Allow: GET to any method but GET", async () => {
    register(OWNER_ACCOUNT, "alice");
    post(db, OWNER_ACCOUNT, member(OWNER_ACCOUNT, "alice"), "build", "x");
    for (const path of paths) {
      for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
        for (const token of [ownerViewer, OWNER_TOKEN]) {
          const res = await get(path, token, method);
          expect(res.status).toBe(405);
          expect(res.headers.get("allow")).toBe("GET");
        }
      }
    }
  });

  it("answer 401 to no token, a wrong token and a revoked token", async () => {
    for (const path of paths) {
      for (const token of [null, "nope"]) {
        const res = await get(path, token);
        expect(res.status).toBe(401);
        expect(res.headers.get("www-authenticate")).toBe("Bearer");
      }
      expect((await get(path, null, "POST")).status).toBe(401);
      expect((await fetch(`${base()}${path}`, { headers: { Authorization: friendViewer } })).status).toBe(401);
    }
    const viewer = addToken(db, "friend", true);
    expect((await get("/api/channels", viewer.token)).status).toBe(200);
    revokeToken(db, viewer.id);
    for (const path of paths) expect((await get(path, viewer.token)).status).toBe(401);
  });

  it("answer 503 with Retry-After when the database is busy, and 500 for any other failure", async () => {
    register(OWNER_ACCOUNT, "alice");
    post(db, OWNER_ACCOUNT, member(OWNER_ACCOUNT, "alice"), "build", "x");
    // The first query touching channels fails once with `code`; the token lookup before it still works.
    const prepare = db.prepare.bind(db);
    const fail = (code: string) => {
      vi.restoreAllMocks();
      let thrown = false;
      vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
        if (thrown || !sql.includes("FROM channels")) return prepare(sql);
        thrown = true;
        throw Object.assign(new Error("database is locked"), { code });
      }) as typeof db.prepare);
    };
    for (const path of paths) {
      fail("SQLITE_BUSY");
      const res = await get(path, ownerViewer);
      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe("1");
      fail("SQLITE_BUSY_SNAPSHOT");
      expect((await get(path, ownerViewer)).status).toBe(503);
      fail("SQLITE_CORRUPT");
      expect((await get(path, ownerViewer)).status).toBe(500);
    }
    vi.restoreAllMocks();
    expect((await channels(ownerViewer)).map((c) => c.name)).toEqual(["build"]);
  });

  it("leave a read-only token refused on /mcp, /wait and every other path", async () => {
    for (const path of ["/mcp", "/wait?agent=x", "/api/channel", "/api/channels/build"]) {
      expect((await get(path, ownerViewer)).status).toBe(403);
    }
  });
});
