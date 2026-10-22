import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addAccount, addToken, listAccounts, revokeToken } from "../src/accounts.js";
import { addPerson, registerAgent, removeAgent } from "../src/agents.js";
import { OWNER_ACCOUNT, openDb, type AccountId, type Db } from "../src/db.js";
import { startHttp, type HttpServer } from "../src/http.js";
import { listAccountMessages, readInbox, sendMessage } from "../src/messages.js";
import { addWebhook, sendPending } from "../src/webhooks.js";

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
  // The server's own delivery pass never runs during a test, so only the test delivers.
  http = await startHttp(db, { token: OWNER_TOKEN, port: 0, waitHoldMs: 0, webhookIntervalMs: 3_600_000 });
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
  starting: boolean;
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
        { id: ids[0], from: "alice", to: "bob", sentAt: sentAt[0], body: "hello bob", broadcast: false, read: true, starting: false },
        { id: ids[1], from: "bob", to: "alice", sentAt: sentAt[1], body: "hello everyone", broadcast: true, read: false, starting: false },
        { id: ids[2], from: "bob", to: "carol", sentAt: sentAt[2], body: "hello everyone", broadcast: true, read: false, starting: false },
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

    it("leaves out messages to a person, which no read_inbox ever reads", async () => {
      register(OWNER_ACCOUNT, "alice");
      addPerson(db, "owner", "colin");
      sendMessage(db, OWNER_ACCOUNT, "alice", "colin", "to the person");
      sendMessage(db, OWNER_ACCOUNT, "colin", "alice", "to the agent");
      sendMessage(db, OWNER_ACCOUNT, "alice", "all", "everyone");
      expect((await messages(ownerViewer)).map((m) => [m.to, m.body, m.read])).toEqual([
        ["colin", "to the person", false],
        ["alice", "to the agent", false],
        ["colin", "everyone", false],
      ]);
      for (const token of [OWNER_TOKEN, ownerFull, ownerViewer]) {
        expect((await messages(token, "?unread=true")).map((m) => [m.to, m.body])).toEqual([["alice", "to the agent"]]);
      }
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

  describe("starting", () => {
    const servers: Server[] = [];
    afterEach(async () => {
      for (const s of servers.splice(0)) {
        s.closeAllConnections();
        await new Promise((r) => s.close(r));
      }
    });

    /** A receiver on 127.0.0.1 answering every delivery with `status`. */
    const receiver = async (status: number) => {
      const server = createServer((req, res) => {
        req.resume();
        req.on("end", () => res.writeHead(status).end());
      });
      servers.push(server);
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
    };
    /** Each listed message as [to, body, read, starting], with and without unread, for every kind of owner token. */
    const flags = async (account: AccountId = OWNER_ACCOUNT, unreadOnly = false) => {
      const tokens = account === OWNER_ACCOUNT ? [OWNER_TOKEN, ownerFull, ownerViewer] : [friendToken, friendViewer];
      const answers = await Promise.all(tokens.map((t) => messages(t, unreadOnly ? "?unread=true&limit=200" : "?limit=200")));
      for (const a of answers) expect(a).toEqual(answers[0]);
      return answers[0]!.map((m) => [m.to, m.body, m.read, m.starting]);
    };
    const both = async (account: AccountId = OWNER_ACCOUNT) => [await flags(account), await flags(account, true)];
    const delivered = () => db.prepare("SELECT COUNT(*) FROM webhook_deliveries WHERE delivered_at IS NOT NULL").pluck().get();

    it("is false with no webhook, and false while the delivery is pending", async () => {
      register(OWNER_ACCOUNT, "alice", "bob", "carol");
      addWebhook(db, "owner", await receiver(204), "agent:bob", true);
      sendMessage(db, OWNER_ACCOUNT, "alice", "carol", "no webhook");
      sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "pending");
      const unread = [
        ["carol", "no webhook", false, false],
        ["bob", "pending", false, false],
      ];
      expect(await both()).toEqual([unread, unread]);
    });

    it("is false for a delivery whose attempts are used up without a 2xx", async () => {
      register(OWNER_ACCOUNT, "alice", "bob");
      addWebhook(db, "owner", await receiver(500), "agent:bob", true);
      sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "failed");
      expect(await sendPending(db, { maxAttempts: 1 })).toEqual({ delivered: 0, failed: 1 });
      expect(db.prepare("SELECT attempts, delivered_at FROM webhook_deliveries").get()).toEqual({ attempts: 1, delivered_at: null });
      const unread = [["bob", "failed", false, false]];
      expect(await both()).toEqual([unread, unread]);
    });

    it("is true once a delivery is delivered, with or without unread, and false again once the recipient reads it", async () => {
      register(OWNER_ACCOUNT, "alice", "bob", "carol");
      addWebhook(db, "owner", await receiver(204), "agent:bob", true);
      // A second webhook on the same agent that fails: one delivered delivery is enough.
      addWebhook(db, "owner", await receiver(500), "agent:bob", true);
      sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "to bob");
      sendMessage(db, OWNER_ACCOUNT, "bob", "carol", "to carol");
      expect(await sendPending(db)).toEqual({ delivered: 1, failed: 1 });
      expect(await both()).toEqual([
        [
          ["bob", "to bob", false, true],
          ["carol", "to carol", false, false],
        ],
        [
          ["bob", "to bob", false, true],
          ["carol", "to carol", false, false],
        ],
      ]);
      const before = snapshot();
      expect(delivered()).toBe(1);
      readInbox(db, OWNER_ACCOUNT, "bob");
      expect(await both()).toEqual([
        [
          ["bob", "to bob", true, false],
          ["carol", "to carol", false, false],
        ],
        [["carol", "to carol", false, false]],
      ]);
      expect(snapshot()).not.toBe(before);
    });

    it("is true for each recipient of a broadcast a delivery went out for, and never for a person", async () => {
      register(OWNER_ACCOUNT, "alice", "bob");
      addPerson(db, "owner", "colin");
      const url = await receiver(204);
      addWebhook(db, "owner", url, "agent:bob", true);
      addWebhook(db, "owner", url, "agent:colin", true);
      sendMessage(db, OWNER_ACCOUNT, "alice", "colin", "to the person");
      sendMessage(db, OWNER_ACCOUNT, "alice", "all", "everyone");
      expect(await sendPending(db)).toEqual({ delivered: 3, failed: 0 });
      expect(await flags()).toEqual([
        ["colin", "to the person", false, false],
        ["bob", "everyone", false, true],
        ["colin", "everyone", false, false],
      ]);
      expect(await flags(OWNER_ACCOUNT, true)).toEqual([["bob", "everyone", false, true]]);
    });

    it("changes nothing and sends nothing: no message is marked read and no delivery is claimed or retried", async () => {
      register(OWNER_ACCOUNT, "alice", "bob");
      addWebhook(db, "owner", await receiver(204), "agent:bob", true);
      sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "pending");
      const deliveries = () => JSON.stringify(db.prepare("SELECT * FROM webhook_deliveries ORDER BY id").all());
      const before = [snapshot(), deliveries()];
      await both();
      expect([snapshot(), deliveries()]).toEqual(before);
    });

    it("says nothing else about a webhook: no URL, secret, header or delivery id", async () => {
      register(OWNER_ACCOUNT, "alice", "bob");
      const url = await receiver(204);
      const hook = addWebhook(db, "owner", url, "agent:bob", true, "Authorization: Bearer header-value");
      sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "x");
      await sendPending(db);
      for (const query of ["", "?unread=true"]) {
        const text = await (await get(`/api/messages${query}`, ownerViewer)).text();
        for (const secret of [url, hook.secret, "header-value", "delivered", "attempts"]) expect(text).not.toContain(secret);
        expect(Object.keys((JSON.parse(text) as object[])[0]!).sort()).toEqual(
          ["body", "broadcast", "from", "id", "read", "sentAt", "starting", "to"],
        );
      }
    });

    it("never comes from another account's webhook or deliveries, even for agents of the same names", async () => {
      register(OWNER_ACCOUNT, "alice", "bob");
      register(friend, "alice", "bob");
      addWebhook(db, "friend", await receiver(204), "agent:bob", true);
      sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "owner's message");
      sendMessage(db, friend, "alice", "bob", "friend's message");
      expect(await sendPending(db)).toEqual({ delivered: 1, failed: 0 });
      expect(await both()).toEqual([[["bob", "owner's message", false, false]], [["bob", "owner's message", false, false]]]);
      expect(await both(friend)).toEqual([[["bob", "friend's message", false, true]], [["bob", "friend's message", false, true]]]);
      // And the reverse: the owner's webhook delivering leaves the friend's flags as they were.
      addWebhook(db, "owner", await receiver(204), "agent:bob", true);
      sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "owner's second");
      sendMessage(db, friend, "alice", "bob", "friend's second");
      expect(await sendPending(db)).toEqual({ delivered: 2, failed: 0 });
      expect(await flags()).toEqual([
        ["bob", "owner's message", false, false],
        ["bob", "owner's second", false, true],
      ]);
      expect(await flags(friend)).toEqual([
        ["bob", "friend's message", false, true],
        ["bob", "friend's second", false, true],
      ]);
      expect(await flags(friend, true)).toEqual(await flags(friend));
    });

    it("is false again once the webhook that delivered it is removed, since its deliveries go with it", async () => {
      register(OWNER_ACCOUNT, "alice", "bob");
      const hook = addWebhook(db, "owner", await receiver(204), "agent:bob", true);
      sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "x");
      await sendPending(db);
      expect(await flags()).toEqual([["bob", "x", false, true]]);
      db.prepare("DELETE FROM webhooks WHERE id = ?").run(hook.id);
      expect(await flags()).toEqual([["bob", "x", false, false]]);
    });

    it("reads each message's deliveries by index, without scanning messages or webhook_deliveries", () => {
      const prepare = db.prepare.bind(db);
      const sql: string[] = [];
      const spy = vi.spyOn(db, "prepare").mockImplementation(((s: string) => {
        sql.push(s);
        return prepare(s);
      }) as typeof db.prepare);
      listAccountMessages(db, OWNER_ACCOUNT, 50, 0);
      listAccountMessages(db, OWNER_ACCOUNT, 50, 0, true);
      spy.mockRestore();
      expect(sql).toHaveLength(2);
      const plans = sql.map((s) =>
        (db.prepare(`EXPLAIN QUERY PLAN ${s}`).all(OWNER_ACCOUNT, 50, 0) as { detail: string }[]).map((p) => p.detail).join("\n"),
      );
      for (const plan of plans) {
        expect(plan).not.toMatch(/SCAN (m|d|messages|webhook_deliveries)\b/);
        expect(plan).toMatch(/SEARCH m USING (COVERING )?INDEX messages_(history|inbox) \(recipient_id=\?/);
        expect(plan).toMatch(
          /SEARCH d USING COVERING INDEX webhook_deliveries_delivered_by_message \(message_id=\? AND delivered_at>\?\)/,
        );
      }
      expect(plans[1]).toMatch(/messages_inbox \(recipient_id=\? AND read_at=\?\)/);
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
