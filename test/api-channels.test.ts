import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addAccount, addToken, listAccounts, revokeToken } from "../src/accounts.js";
import { addPerson, identityOf, registerAgent, removeAgent } from "../src/agents.js";
import { joinChannel, leaveChannel, post, type Member } from "../src/channels.js";
import { OWNER_ACCOUNT, openDb, type AccountId, type Db } from "../src/db.js";
import { startHttp, type HttpServer } from "../src/http.js";
import { readInbox, sendMessage } from "../src/messages.js";

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
  posts: { id: number; from: string; sentAt: string; body: string; mentions: { name: string; read: boolean }[] }[];
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
    db.prepare("SELECT agent_id, post_id, read_at FROM mentions ORDER BY agent_id, post_id").all(),
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
    // Joined before anyone posted; names sort regardless of case, so "alpha" comes before "Zed".
    joinChannel(db, OWNER_ACCOUNT, member(OWNER_ACCOUNT, "alice"), "alpha");
    joinChannel(db, OWNER_ACCOUNT, member(OWNER_ACCOUNT, "alice"), "Zed");
    for (const token of [OWNER_TOKEN, ownerFull, ownerViewer]) {
      const text = await (await get("/api/channels", token)).text();
      expect(text).not.toContain("secret");
      expect(text).not.toContain(token);
      expect(await channels(token)).toEqual([
        { name: "alpha", posts: 0, lastPostAt: null, members: ["alice"] },
        { name: "build", posts: 2, lastPostAt: last.sentAt, members: ["alice", "carol"] },
        { name: "Zed", posts: 0, lastPostAt: null, members: ["alice"] },
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
    // A friend's agent joined to the owner's channel, which no tool can do, still never shows as a member.
    db.prepare("INSERT INTO channel_reads (agent_id, channel_id, last_read_id, joined) VALUES (?, ?, 0, 1)").run(
      member(friend, "fred").id,
      db.prepare("SELECT id FROM channels WHERE account_id = ? AND name = 'build'").pluck().get(OWNER_ACCOUNT),
    );
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
          { id: first.id, from: "bob", sentAt: first.sentAt, body: "one", mentions: [] },
          { id: second.id, from: "alice", sentAt: second.sentAt, body: "two", mentions: [] },
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
    bad.push("&limit=1&limit=x", "&limit=x&limit=1", "&offset=0&offset=-1", "&limit=2&limit=2");
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

describe("GET /api/channel-posts mentions", () => {
  const mentions = async (token: string, query: string) =>
    (await posts(token, query)).posts.map((p) => [p.body, p.mentions.map((m) => `${m.name}:${m.read ? "read" : "unread"}`)]);

  it("gives each post its mentioned agents in name order with whether each has read the mention, leaving people out", async () => {
    register(OWNER_ACCOUNT, "alice", "carol", "Bob");
    addPerson(db, "owner", "colin");
    post(db, OWNER_ACCOUNT, member(OWNER_ACCOUNT, "alice"), "build", "no mention");
    post(db, OWNER_ACCOUNT, member(OWNER_ACCOUNT, "alice"), "build", "@carol @colin @bob @nobody @alice");
    post(db, OWNER_ACCOUNT, member(OWNER_ACCOUNT, "alice"), "build", "@carol again");
    readInbox(db, OWNER_ACCOUNT, "carol", true, 1);
    for (const token of [OWNER_TOKEN, ownerFull, ownerViewer]) {
      // alice mentions herself, which records nothing; colin is a person, who has no read_inbox; nobody is not an agent.
      expect(await mentions(token, "?channel=build")).toEqual([
        ["no mention", []],
        ["@carol @colin @bob @nobody @alice", ["Bob:unread", "carol:read"]],
        ["@carol again", ["carol:unread"]],
      ]);
    }
  });

  it("shows a mentioned agent that has since unregistered under the name it had", async () => {
    register(OWNER_ACCOUNT, "alice");
    const bob = registerAgent(db, OWNER_ACCOUNT, "bob", "x").key;
    post(db, OWNER_ACCOUNT, member(OWNER_ACCOUNT, "alice"), "build", "@bob hello");
    removeAgent(db, OWNER_ACCOUNT, "bob", bob);
    register(OWNER_ACCOUNT, "bob");
    expect(await mentions(ownerViewer, "?channel=build")).toEqual([["@bob hello", ["bob:unread"]]]);
    expect(await mentions(ownerViewer, "?channel=build&unread=true")).toEqual([["@bob hello", ["bob:unread"]]]);
  });

  it("answers with ?unread=true only the posts with an unread mention of an agent, in the same shape, order and paging", async () => {
    register(OWNER_ACCOUNT, "alice", "bob", "carol");
    addPerson(db, "owner", "colin");
    post(db, OWNER_ACCOUNT, member(OWNER_ACCOUNT, "alice"), "build", "plain");
    post(db, OWNER_ACCOUNT, member(OWNER_ACCOUNT, "alice"), "build", "@bob @carol one");
    post(db, OWNER_ACCOUNT, member(OWNER_ACCOUNT, "alice"), "build", "@colin only a person");
    post(db, OWNER_ACCOUNT, member(OWNER_ACCOUNT, "alice"), "build", "@bob two");
    post(db, OWNER_ACCOUNT, member(OWNER_ACCOUNT, "alice"), "build", "@carol three");
    post(db, OWNER_ACCOUNT, member(OWNER_ACCOUNT, "alice"), "other", "@bob elsewhere");
    expect(await mentions(ownerViewer, "?channel=build&unread=true")).toEqual([
      ["@bob @carol one", ["bob:unread", "carol:unread"]],
      ["@bob two", ["bob:unread"]],
      ["@carol three", ["carol:unread"]],
    ]);
    const unread = await posts(ownerViewer, "?channel=build&unread=true");
    const all = await posts(ownerViewer, "?channel=build");
    expect(unread.channel).toBe("build");
    expect(unread.posts).toEqual(all.posts.filter((p) => p.mentions.some((m) => !m.read)));
    const bodies = async (query: string) => (await posts(ownerViewer, `?channel=build&unread=true${query}`)).posts.map((p) => p.body);
    expect(await bodies("&limit=2")).toEqual(["@bob @carol one", "@bob two"]);
    expect(await bodies("&limit=2&offset=2")).toEqual(["@carol three"]);
    expect(await bodies("&offset=3")).toEqual([]);
    // bob reads his mentions: the first post stays for carol's, the second goes.
    readInbox(db, OWNER_ACCOUNT, "bob");
    expect(await mentions(ownerViewer, "?channel=build&unread=true")).toEqual([
      ["@bob @carol one", ["bob:read", "carol:unread"]],
      ["@carol three", ["carol:unread"]],
    ]);
    readInbox(db, OWNER_ACCOUNT, "carol");
    expect(await mentions(ownerViewer, "?channel=build&unread=true")).toEqual([]);
  });

  it("refuses unread given twice or with any value but true with 400", async () => {
    register(OWNER_ACCOUNT, "alice");
    post(db, OWNER_ACCOUNT, member(OWNER_ACCOUNT, "alice"), "build", "x");
    for (const query of ["&unread=", "&unread=false", "&unread=TRUE", "&unread=1", "&unread=true&unread=true", "&unread=true&unread=false"]) {
      expect((await get(`/api/channel-posts?channel=build${query}`, ownerViewer)).status).toBe(400);
    }
  });

  it("never shows another account's mentions or read state, through its agents and channel of the same names", async () => {
    register(OWNER_ACCOUNT, "alice", "bob");
    register(friend, "alice", "bob");
    post(db, OWNER_ACCOUNT, member(OWNER_ACCOUNT, "alice"), "build", "@bob owner's");
    post(db, friend, member(friend, "alice"), "build", "@bob friend's");
    post(db, friend, member(friend, "alice"), "build", "@bob friend's again");
    readInbox(db, friend, "bob", true, 1);
    // A mention of a friend's agent on the owner's post, which no tool can make, still never shows.
    const ownerPost = db.prepare("SELECT id FROM channel_posts WHERE body = ?").pluck().get("@bob owner's");
    db.prepare("INSERT INTO mentions (agent_id, post_id) VALUES (?, ?)").run(member(friend, "alice").id, ownerPost);
    for (const token of [OWNER_TOKEN, ownerFull, ownerViewer]) {
      expect(await mentions(token, "?channel=build")).toEqual([["@bob owner's", ["bob:unread"]]]);
      expect(await mentions(token, "?channel=build&unread=true")).toEqual([["@bob owner's", ["bob:unread"]]]);
    }
    for (const token of [friendToken, friendViewer]) {
      expect(await mentions(token, "?channel=build")).toEqual([
        ["@bob friend's", ["bob:read"]],
        ["@bob friend's again", ["bob:unread"]],
      ]);
      expect(await mentions(token, "?channel=build&unread=true")).toEqual([["@bob friend's again", ["bob:unread"]]]);
    }
  });

  it("finds a page's mentions and the unread posts by index, without scanning mentions or channel_posts", async () => {
    const plan = (sql: string) =>
      (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...Array(sql.split("?").length - 1).fill(1)) as { detail: string }[])
        .map((p) => p.detail)
        .join("\n");
    // Run the queries readAccountChannel runs, by catching their SQL.
    register(OWNER_ACCOUNT, "alice", "bob");
    post(db, OWNER_ACCOUNT, member(OWNER_ACCOUNT, "alice"), "build", "@bob x");
    const seen: string[] = [];
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
      if (sql.includes("mentions") || sql.includes("channel_posts")) seen.push(sql);
      return prepare(sql);
    }) as typeof db.prepare);
    await posts(ownerViewer, "?channel=build");
    await posts(ownerViewer, "?channel=build&unread=true");
    vi.restoreAllMocks();
    // The page of posts and its mentions, without and with unread. The page itself (pg), at most 200 rows, is the only scan.
    expect(seen).toHaveLength(4);
    for (const sql of seen) expect(plan(sql)).not.toMatch(/SCAN (x|p|a|channel_posts|mentions)\b/);
    expect(plan(seen[0])).toMatch(/SEARCH channel_posts USING INDEX channel_posts_by_channel \(channel_id=\?\)/);
    expect(plan(seen[1])).toMatch(/SEARCH x USING INDEX mentions_by_post \(post_id=\?\)/);
    expect(plan(seen[2])).toMatch(/SEARCH x USING COVERING INDEX mentions_unread \(agent_id=\? AND read_at=\?\)/);
    expect(plan(seen[2])).toMatch(/SEARCH p USING INTEGER PRIMARY KEY/);
    expect(plan(seen[3])).toMatch(/SEARCH x USING INDEX mentions_by_post \(post_id=\?\)/);
  });
});

describe("both endpoints", () => {
  const paths = ["/api/channels", "/api/channel-posts?channel=build", "/api/channel-posts?channel=build&unread=true"];

  it("change nothing: read positions, last_seen and unread counts stay as they were", async () => {
    register(OWNER_ACCOUNT, "alice", "bob");
    joinChannel(db, OWNER_ACCOUNT, member(OWNER_ACCOUNT, "alice"), "build");
    post(db, OWNER_ACCOUNT, member(OWNER_ACCOUNT, "bob"), "build", "unread");
    post(db, OWNER_ACCOUNT, member(OWNER_ACCOUNT, "bob"), "build", "unread too, @alice");
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
