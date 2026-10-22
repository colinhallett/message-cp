import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addAccount, addToken, listAccounts, revokeToken } from "../src/accounts.js";
import { STATUS_TTL_MS, addPerson, identityOf, registerAgent, removeAgent, setStatus } from "../src/agents.js";
import { joinChannel, leaveChannel, post, readChannel, type Member } from "../src/channels.js";
import { OWNER_ACCOUNT, openDb, type AccountId, type Db } from "../src/db.js";
import { startHttp, type HttpServer } from "../src/http.js";
import { readInbox, sendMessage, unreadSummary } from "../src/messages.js";

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
  return (await res.json()) as { name: string; bio: string; lastSeen: string; unreadMessages: number; unreadPosts: number; unreadMentions: number; person: boolean; online: boolean }[];
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
    expect((await fetch(`${base()}/elsewhere`, { headers: auth(ownerViewer) })).status).toBe(403);
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
      expect(Object.keys(list[0]).sort()).toEqual(["bio", "lastSeen", "name", "online", "person", "status", "unreadMentions", "unreadMessages", "unreadPosts"]);
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
        expect(list).toEqual([{ name: "alice", bio: "owner's", lastSeen: new Date(0).toISOString(), person: false, status: null, unreadMessages: 0, unreadPosts: 0, unreadMentions: 0, online: false }]);
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

  it("gives each agent's current status line, for every kind of token, and null with none, once expired or for a person", async () => {
    registerAgent(db, OWNER_ACCOUNT, "alice", "x");
    registerAgent(db, OWNER_ACCOUNT, "bob", "x");
    registerAgent(db, OWNER_ACCOUNT, "carol", "x");
    addPerson(db, "owner", "dana");
    setStatus(db, OWNER_ACCOUNT, identityOf(db, OWNER_ACCOUNT, "alice")!, "reading Linear");
    setStatus(db, OWNER_ACCOUNT, identityOf(db, OWNER_ACCOUNT, "carol")!, "long ago", Date.now() - STATUS_TTL_MS - 1000);
    // Not reachable through any tool: a person's row with a line still shows none.
    db.prepare("UPDATE agents SET status = 'stray', status_at = ? WHERE name = 'dana'").run(Date.now());
    for (const token of [OWNER_TOKEN, ownerViewer]) {
      const list = await json(token);
      expect(Object.fromEntries(list.map((a) => [a.name, (a as { status: string | null }).status]))).toEqual({
        alice: "reading Linear",
        bob: null,
        carol: null,
        dana: null,
      });
    }
  });

  it("never shows another account's agent's status line, even one of the same name, and the reverse", async () => {
    registerAgent(db, OWNER_ACCOUNT, "alice", "x");
    registerAgent(db, friend, "alice", "x");
    setStatus(db, friend, identityOf(db, friend, "alice")!, "friend's line");
    const status = async (token: string) => (await json(token)).map((a) => [a.name, (a as { status: string | null }).status]);
    for (const token of [OWNER_TOKEN, ownerViewer]) expect(await status(token)).toEqual([["alice", null]]);
    for (const token of [friendToken, friendViewer]) expect(await status(token)).toEqual([["alice", "friend's line"]]);
    setStatus(db, friend, identityOf(db, friend, "alice")!, "");
    setStatus(db, OWNER_ACCOUNT, identityOf(db, OWNER_ACCOUNT, "alice")!, "owner's line");
    for (const token of [OWNER_TOKEN, ownerViewer]) expect(await status(token)).toEqual([["alice", "owner's line"]]);
    for (const token of [friendToken, friendViewer]) expect(await status(token)).toEqual([["alice", null]]);
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
    for (let i = 0; i < 205; i++) registerAgent(db, friend, `z${String(i).padStart(3, "0")}`, "x");
    expect(await json(friendViewer)).toHaveLength(50);
    expect(await json(friendViewer, "?limit=200")).toHaveLength(200);
    const bad = ["?limit=0", "?limit=201", "?limit=x", "?offset=-1", "?limit=1.5", "?limit="];
    // A key given twice is refused, whichever of its values is the bad one.
    bad.push("?limit=1&limit=x", "?limit=x&limit=1", "?offset=0&offset=-1", "?limit=2&limit=2");
    for (const query of bad) {
      expect((await agents(friendViewer, query)).status).toBe(400);
    }
  });

  it("counts unread messages, posts and mentions as unreadSummary does, for every agent on the page", async () => {
    for (const name of ["alice", "bob", "carol"]) registerAgent(db, OWNER_ACCOUNT, name, "x");
    sendMessage(db, OWNER_ACCOUNT, "bob", "alice", "read later");
    readInbox(db, OWNER_ACCOUNT, "alice");
    sendMessage(db, OWNER_ACCOUNT, "bob", "alice", "one");
    sendMessage(db, OWNER_ACCOUNT, "carol", "alice", "two");
    sendMessage(db, OWNER_ACCOUNT, "alice", "all", "to everyone");
    for (const name of ["alice", "bob", "carol"]) joinChannel(db, OWNER_ACCOUNT, member(OWNER_ACCOUNT, name), "build");
    joinChannel(db, OWNER_ACCOUNT, member(OWNER_ACCOUNT, "alice"), "ops");
    post(db, OWNER_ACCOUNT, member(OWNER_ACCOUNT, "bob"), "build", "seen");
    readChannel(db, OWNER_ACCOUNT, member(OWNER_ACCOUNT, "alice"), "build");
    post(db, OWNER_ACCOUNT, member(OWNER_ACCOUNT, "bob"), "build", "new");
    post(db, OWNER_ACCOUNT, member(OWNER_ACCOUNT, "carol"), "ops", "carol is not in ops");
    post(db, OWNER_ACCOUNT, member(OWNER_ACCOUNT, "carol"), "build", "carol's own");
    leaveChannel(db, OWNER_ACCOUNT, member(OWNER_ACCOUNT, "bob"), "build");
    // Mentions count in any channel, joined or not, and reading one with read_inbox stops it counting.
    post(db, OWNER_ACCOUNT, member(OWNER_ACCOUNT, "alice"), "dev", "@bob @carol read");
    readInbox(db, OWNER_ACCOUNT, "carol");
    post(db, OWNER_ACCOUNT, member(OWNER_ACCOUNT, "alice"), "dev", "@bob @carol one");
    post(db, OWNER_ACCOUNT, member(OWNER_ACCOUNT, "carol"), "ops", "@bob two");
    const list = await json(ownerViewer);
    for (const a of list) {
      const unread = unreadSummary(db, OWNER_ACCOUNT, a.name)!;
      expect([a.name, a.unreadMessages, a.unreadPosts, a.unreadMentions]).toEqual([a.name, unread.count, unread.posts, unread.mentions]);
    }
    expect(list.map((a) => [a.name, a.unreadMessages, a.unreadPosts, a.unreadMentions])).toEqual([
      ["alice", 2, 4, 0],
      ["bob", 1, 0, 3],
      ["carol", 0, 2, 1],
    ]);
  });

  it("counts only the account's mentions of the agent's own registration, and listing marks none read", async () => {
    registerAgent(db, OWNER_ACCOUNT, "alice", "x");
    registerAgent(db, OWNER_ACCOUNT, "bob", "x");
    registerAgent(db, friend, "fred", "x");
    registerAgent(db, friend, "bob", "friend's bob");
    // A mention of bob in the friend's account is the friend's bob's, never the owner's.
    post(db, friend, member(friend, "fred"), "dev", "@bob in the friend's account");
    post(db, friend, member(friend, "fred"), "dev", "@bob again");
    const mentions = async (token: string) => Object.fromEntries((await json(token)).map((a) => [a.name, a.unreadMentions]));
    for (const token of [OWNER_TOKEN, ownerViewer]) expect(await mentions(token)).toEqual({ alice: 0, bob: 0 });
    for (const token of [friendToken, friendViewer]) expect(await mentions(token)).toEqual({ bob: 2, fred: 0 });
    // A mention row that points at another account's post never counts, even on the agent's own row.
    const friendPost = db.prepare("SELECT MAX(id) FROM channel_posts").pluck().get();
    db.prepare("INSERT INTO mentions (agent_id, post_id) VALUES (?, ?)").run(identityOf(db, OWNER_ACCOUNT, "alice")!.id, friendPost);
    for (const token of [OWNER_TOKEN, ownerViewer]) expect(await mentions(token)).toEqual({ alice: 0, bob: 0 });
    // A removed bob's mention does not count for a later bob that registers the name.
    post(db, OWNER_ACCOUNT, member(OWNER_ACCOUNT, "alice"), "dev", "@bob old");
    expect(await mentions(ownerViewer)).toEqual({ alice: 0, bob: 1 });
    const old = identityOf(db, OWNER_ACCOUNT, "bob")!;
    removeAgent(db, OWNER_ACCOUNT, "bob", undefined, old);
    registerAgent(db, OWNER_ACCOUNT, "bob", "new bob");
    expect(await mentions(ownerViewer)).toEqual({ alice: 0, bob: 0 });
    // Listing twice marks nothing read: /wait still fires on the mention and read_inbox still returns it.
    post(db, OWNER_ACCOUNT, member(OWNER_ACCOUNT, "alice"), "dev", "@bob new");
    expect(await mentions(ownerViewer)).toEqual({ alice: 0, bob: 1 });
    expect(await mentions(OWNER_TOKEN)).toEqual({ alice: 0, bob: 1 });
    const wait = await fetch(`${base()}/wait?agent=bob`, { headers: auth(OWNER_TOKEN) });
    expect(wait.status).toBe(200);
    expect(await wait.text()).toContain("1 unread mention in #dev");
    expect(readInbox(db, OWNER_ACCOUNT, "bob").map((m) => m.body)).toEqual(["@bob new"]);
    expect(await mentions(ownerViewer)).toEqual({ alice: 0, bob: 0 });
  });

  it("answers 503 with Retry-After when the database is busy, and 500 for any other failure", async () => {
    registerAgent(db, OWNER_ACCOUNT, "alice", "x");
    // The page query fails once with `code`; the token lookup before it still works.
    const prepare = db.prepare.bind(db);
    const fail = (code: string) => {
      vi.restoreAllMocks();
      let thrown = false;
      vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
        if (thrown || !sql.includes("FROM agents a WHERE")) return prepare(sql);
        thrown = true;
        throw Object.assign(new Error("database is locked"), { code });
      }) as typeof db.prepare);
    };
    fail("SQLITE_BUSY");
    let res = await agents(ownerViewer);
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("1");
    fail("SQLITE_BUSY_SNAPSHOT");
    expect((await agents(ownerViewer)).status).toBe(503);
    fail("SQLITE_CORRUPT");
    res = await agents(ownerViewer);
    expect(res.status).toBe(500);
    vi.restoreAllMocks();
    expect((await json(ownerViewer)).map((a) => a.name)).toEqual(["alice"]);
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

describe("GET /api/token", () => {
  const token = (t: string | null, method = "GET") => fetch(`${base()}/api/token`, { method, headers: auth(t) });

  it("says whether the token is read-only, and nothing else, for every kind of token", async () => {
    const friendAgent = addToken(db, "friend", false, true).token;
    const ownerAgent = addToken(db, "owner", false, true).token;
    for (const [t, readOnly, agentOnly] of [
      [OWNER_TOKEN, false, false],
      [friendToken, false, false],
      [ownerViewer, true, false],
      [friendViewer, true, false],
      [ownerAgent, false, true],
      [friendAgent, false, true],
    ] as const) {
      const res = await token(t);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/json");
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ readOnly, agentOnly });
      for (const secret of [OWNER_TOKEN, friendToken, ownerViewer, friendViewer, ownerAgent, friendAgent, friend, "owner", "friend"]) {
        expect(text).not.toContain(secret);
      }
    }
  });

  it("answers 405 with Allow: GET to any method but GET, read-only token or not", async () => {
    for (const t of [OWNER_TOKEN, friendViewer]) {
      for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
        const res = await token(t, method);
        expect(res.status).toBe(405);
        expect(res.headers.get("allow")).toBe("GET");
      }
    }
  });

  it("answers 401 to no token, a wrong token and a revoked token", async () => {
    for (const t of [null, "nope"]) {
      const res = await token(t);
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe("Bearer");
    }
    expect((await token(null, "POST")).status).toBe(401);
    const viewer = addToken(db, "friend", true);
    expect((await token(viewer.token)).status).toBe(200);
    revokeToken(db, viewer.id);
    expect((await token(viewer.token)).status).toBe(401);
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
      expect(res.stderr).toContain("[--read-only | --agent-only]");
    }
  }, 30_000);

  it("prints an agent token with --agent-only, which reaches /mcp but not POST /api/send", async () => {
    const agent = cli("token", "add", "friend", "--agent-only");
    expect(agent.status).toBe(0);
    expect(agent.stderr).toContain("agent token");
    expect(agent.stderr).not.toContain(agent.stdout.trim());
    const token = agent.stdout.trim();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(await initialize(token)).toHaveProperty("status", 200);
    expect((await agents(token)).status).toBe(200);
    const send = await fetch(`${base()}/api/send`, { method: "POST", headers: auth(token), body: "{}" });
    expect(send.status).toBe(403);
  }, 30_000);

  it("refuses --agent-only with --read-only or anywhere but after token add <account>, and makes nothing", () => {
    const tokens = () => db.prepare("SELECT COUNT(*) FROM tokens").pluck().get();
    const before = tokens();
    for (const args of [
      ["token", "add", "friend", "--read-only", "--agent-only"],
      ["token", "add", "friend", "--agent-only", "--read-only"],
      ["token", "add", "--agent-only"],
      ["token", "add", "--agent-only", "friend"],
      ["token", "add", "friend", "--agent-only", "extra"],
      ["account", "add", "x", "--agent-only"],
      ["token", "list", "--agent-only"],
      ["token", "revoke", "1", "--agent-only"],
    ]) {
      const res = cli(...args);
      expect(res.status, args.join(" ")).toBe(2);
      expect(res.stdout).toBe("");
      expect(res.stderr).toContain("[--read-only | --agent-only]");
    }
    expect(tokens()).toBe(before);
    expect(listAccounts(db).map((a) => a.name)).toEqual(["owner", "friend"]);
  }, 30_000);
});

describe("message-cp token list", () => {
  const root = resolve(import.meta.dirname, "..");
  const cli = (...args: string[]) =>
    spawnSync(join(root, "node_modules/.bin/tsx"), [join(root, "src/cli.ts"), ...args], {
      env: { ...process.env, MESSAGE_CP_DB: dbFile },
      encoding: "utf8",
    });

  it("prints one line per working token with its id, account, kind and creation time, and never a token or hash", () => {
    const agent = addToken(db, "owner", false, true);
    const gone = addToken(db, "friend");
    revokeToken(db, gone.id);
    const res = cli("token", "list");
    expect(res.status).toBe(0);
    const ids = (db.prepare("SELECT id FROM tokens WHERE revoked_at IS NULL ORDER BY id").pluck().all() as number[]);
    const lines = res.stdout.trimEnd().split("\n");
    expect(lines.map((l) => l.replace(/created \S+$/, "created"))).toEqual([
      `${ids[0]}\tfriend\tfull\tcreated`,
      `${ids[1]}\tfriend\tread-only\tcreated`,
      `${ids[2]}\towner\tread-only\tcreated`,
      `${agent.id}\towner\tagent\tcreated`,
    ]);
    for (const l of lines) expect(l).toMatch(/\tcreated \d{4}-\d\d-\d\dT[\d:.]+Z$/);
    const out = res.stdout + res.stderr;
    for (const secret of [friendToken, friendViewer, ownerViewer, agent.token, gone.token, OWNER_TOKEN]) expect(out).not.toContain(secret);
    expect(out).not.toMatch(/[0-9a-f]{64}/);
    expect(cli("token", "list", "extra").status).toBe(2);
  }, 30_000);
});
