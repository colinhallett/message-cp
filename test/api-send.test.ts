import { mkdtempSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addAccount, addToken, listAccounts, revokeToken } from "../src/accounts.js";
import { addPerson, identityOf, registerAgent, removeAgent } from "../src/agents.js";
import { joinChannel, readChannel, type Member } from "../src/channels.js";
import { OWNER_ACCOUNT, openDb, type AccountId, type Db } from "../src/db.js";
import { startHttp, type HttpServer } from "../src/http.js";
import { readInbox } from "../src/messages.js";
import { addWebhook, deliveryBody } from "../src/webhooks.js";

// POST /api/send and /api/post, on a server with the owner's account and a friend's.
const OWNER_TOKEN = "owner-token";
let db: Db;
let http: HttpServer;
let friend: AccountId;
let friendToken: string;
let ownerViewer: string;
let ownerFull: string;

const start = async (options: { maxSessions?: number; waitHoldMs?: number } = {}) => {
  http = await startHttp(db, { token: OWNER_TOKEN, port: 0, waitHoldMs: 0, ...options });
};

beforeEach(async () => {
  db = openDb(join(mkdtempSync(join(tmpdir(), "message-cp-api-send-")), "db.sqlite"));
  friendToken = addAccount(db, "friend").token;
  friend = listAccounts(db).find((a) => a.name === "friend")!.id;
  ownerViewer = addToken(db, "owner", true).token;
  ownerFull = addToken(db, "owner").token;
  addPerson(db, "owner", "colin");
  registerAgent(db, OWNER_ACCOUNT, "bob", "x");
  registerAgent(db, OWNER_ACCOUNT, "carol", "x");
  await start();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await http.close();
  db.close();
});

const base = () => `http://127.0.0.1:${http.port}`;
const auth = (token: string | null): Record<string, string> => (token === null ? {} : { Authorization: `Bearer ${token}` });
const send = (path: string, token: string | null, body: unknown, method = "POST") =>
  fetch(`${base()}${path}`, {
    method,
    headers: { ...auth(token), "Content-Type": "application/json" },
    body: method === "GET" || method === "HEAD" ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
const ok = async <T>(path: string, token: string, body: unknown): Promise<T> => {
  const res = await send(path, token, body);
  expect(res.status, await res.clone().text()).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/json");
  return (await res.json()) as T;
};
const error = async (res: Response) => ((await res.json()) as { error: { message: string } }).error.message;
const member = (account: AccountId, name: string): Member => ({ ...identityOf(db, account, name)!, name });
const stored = () =>
  JSON.stringify([
    db.prepare("SELECT * FROM messages ORDER BY id").all(),
    db.prepare("SELECT * FROM channel_posts ORDER BY id").all(),
    db.prepare("SELECT * FROM mentions ORDER BY post_id").all(),
    db.prepare("SELECT * FROM webhook_deliveries ORDER BY id").all(),
    db.prepare("SELECT * FROM channels ORDER BY id").all(),
  ]);

describe("POST /api/send", () => {
  it("sends as the person: read_inbox shows it from them, /wait fires and the agent's webhook gets a delivery", async () => {
    const hook = addWebhook(db, "owner", "https://example.com/", "agent:bob", true);
    await http.close();
    await start({ waitHoldMs: 3000 });
    const waiting = fetch(`${base()}/wait?agent=bob`, { headers: auth(OWNER_TOKEN) });
    await new Promise((r) => setTimeout(r, 200));
    // The person's stored name is the sender, whatever case `as` is given in.
    expect(await ok("/api/send", ownerFull, { as: "Colin", to: "BOB", body: "hello bob" })).toEqual({ delivered: 1, recipients: ["bob"] });
    const woke = await waiting;
    expect(woke.status).toBe(200);
    expect(await woke.text()).toBe("1 unread message from colin\n");
    const deliveries = db.prepare("SELECT id, webhook_id FROM webhook_deliveries").all() as { id: number; webhook_id: number }[];
    expect(deliveries.map((d) => [d.webhook_id, deliveryBody(db, d.id)?.event])).toEqual([[hook.id, "agent"]]);
    expect(readInbox(db, OWNER_ACCOUNT, "bob")).toEqual([{ from: "colin", sentAt: expect.any(String), body: "hello bob", broadcast: false }]);
  });

  it("broadcasts to every other agent and person of the account, and only that account", async () => {
    addPerson(db, "owner", "dana");
    registerAgent(db, friend, "erin", "x");
    expect(await ok("/api/send", OWNER_TOKEN, { as: "colin", to: "all", body: "hi all" })).toEqual({
      delivered: 3,
      recipients: ["bob", "carol", "dana"],
    });
    expect(readInbox(db, OWNER_ACCOUNT, "carol").map((m) => [m.from, m.body])).toEqual([["colin", "hi all"]]);
    expect(readInbox(db, friend, "erin")).toEqual([]);
  });
});

describe("POST /api/post", () => {
  it("posts as the person: a mention wakes the agent, and the channel and mention webhooks get deliveries", async () => {
    const channelHook = addWebhook(db, "owner", "https://example.com/", "#general", true);
    const mentionHook = addWebhook(db, "owner", "https://example.com/", "mention:bob", true);
    await http.close();
    await start({ waitHoldMs: 3000 });
    const waiting = fetch(`${base()}/wait?agent=bob`, { headers: auth(OWNER_TOKEN) });
    await new Promise((r) => setTimeout(r, 200));
    const result = await ok<{ channel: string; id: number; sentAt: string }>("/api/post", ownerFull, {
      as: "colin",
      channel: "general",
      body: "@bob and @colin, look",
    });
    expect(result).toEqual({ channel: "general", id: expect.any(Number), sentAt: expect.any(String) });
    const woke = await waiting;
    expect(woke.status).toBe(200);
    expect(await woke.text()).toContain("mention");
    // The person mentioning themselves gets no mention, as an agent would not.
    const colin = db.prepare("SELECT id FROM agents WHERE name = 'colin'").pluck().get();
    const bob = db.prepare("SELECT id FROM agents WHERE name = 'bob'").pluck().get();
    expect(db.prepare("SELECT agent_id FROM mentions").pluck().all()).toEqual([bob]);
    expect(db.prepare("SELECT sender_id, sender FROM channel_posts").all()).toEqual([{ sender_id: colin, sender: "colin" }]);
    const deliveries = db.prepare("SELECT id, webhook_id FROM webhook_deliveries ORDER BY id").all() as { id: number; webhook_id: number }[];
    expect(deliveries.map((d) => [d.webhook_id, deliveryBody(db, d.id)?.event])).toEqual([
      [channelHook.id, "channel"],
      [mentionHook.id, "mention"],
    ]);

    const posts = await fetch(`${base()}/api/channel-posts?channel=general`, { headers: auth(ownerViewer) });
    expect(((await posts.json()) as { posts: { from: string; id: number }[] }).posts).toEqual([
      { id: result.id, from: "colin", sentAt: result.sentAt, body: "@bob and @colin, look" },
    ]);
    expect(readChannel(db, OWNER_ACCOUNT, member(OWNER_ACCOUNT, "carol"), "general").posts.map((p) => p.from)).toEqual(["colin"]);
    expect(readInbox(db, OWNER_ACCOUNT, "bob").map((m) => m.from)).toEqual(["colin"]);
  });

  it("wakes an agent that joined the channel", async () => {
    joinChannel(db, OWNER_ACCOUNT, member(OWNER_ACCOUNT, "carol"), "general");
    await ok("/api/post", OWNER_TOKEN, { as: "colin", channel: "general", body: "no mention" });
    const res = await fetch(`${base()}/wait?agent=carol`, { headers: auth(OWNER_TOKEN) });
    expect(await res.text()).toBe("1 unread post in #general\n");
  });
});

describe.each([
  ["/api/send", { to: "bob" }],
  ["/api/post", { channel: "general" }],
] as const)("%s", (path, target) => {
  const body = (fields: Record<string, unknown>) => ({ as: "colin", ...target, body: "hi", ...fields });

  it("answers 404 for an agent's name, a removed person, an unknown name or another account's person, storing nothing", async () => {
    addPerson(db, "friend", "dana");
    registerAgent(db, OWNER_ACCOUNT, "gone", "x");
    db.prepare("UPDATE agents SET person = 1 WHERE name = 'gone'").run();
    db.prepare("UPDATE agents SET removed_at = 1, name = 'removed:x', removed_name = 'gone' WHERE name = 'gone'").run();
    const before = stored();
    for (const as of ["bob", "gone", "removed:x", "nobody", "dana", "all"]) {
      const res = await send(path, OWNER_TOKEN, body({ as }));
      expect(res.status, as).toBe(404);
      expect(await error(res)).toBe("No such person");
    }
    expect(stored()).toBe(before);
  });

  it("keeps accounts apart: another account's token reaches neither this account's person nor its agents or channels", async () => {
    addPerson(db, "friend", "dana");
    await ok("/api/post", OWNER_TOKEN, { as: "colin", channel: "general", body: "owner's post" });
    const before = stored();
    // This account's person is unknown to the friend's token.
    expect((await send(path, friendToken, body({}))).status).toBe(404);
    expect(stored()).toBe(before);
    // The friend's person cannot reach this account's agent by name.
    if (path === "/api/send") {
      const res = await send(path, friendToken, { as: "dana", to: "bob", body: "hi" });
      expect(res.status).toBe(400);
      expect(await error(res)).toBe("No agent named 'bob'.");
      expect(stored()).toBe(before);
      expect(await ok(path, friendToken, { as: "dana", to: "all", body: "hi" })).toEqual({ delivered: 0, recipients: [] });
    } else {
      // A channel of the same name is the friend's own, and this account's channel is untouched.
      await ok(path, friendToken, { as: "dana", channel: "general", body: "friend's post" });
      const owner = readChannel(db, OWNER_ACCOUNT, member(OWNER_ACCOUNT, "bob"), "general", false).posts.map((p) => p.body);
      expect(owner).toEqual(["owner's post"]);
      expect(db.prepare("SELECT COUNT(*) FROM channels WHERE name = 'general'").pluck().get()).toBe(2);
    }
    expect(readInbox(db, OWNER_ACCOUNT, "bob").map((m) => m.body)).not.toContain("hi");
  });

  it("refuses a read-only token with 403, no token or a wrong or revoked one with 401", async () => {
    const before = stored();
    const viewer = addToken(db, "owner", true).token;
    for (const token of [ownerViewer, viewer]) {
      const res = await send(path, token, body({}));
      expect(res.status).toBe(403);
    }
    for (const token of [null, "wrong"]) {
      const res = await send(path, token, body({}));
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe("Bearer");
    }
    const full = addToken(db, "owner");
    revokeToken(db, full.id);
    expect((await send(path, full.token, body({}))).status).toBe(401);
    expect(stored()).toBe(before);
  });

  it("answers 405 with Allow: POST to any other method", async () => {
    for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
      const res = await send(path, OWNER_TOKEN, body({}), method);
      expect(res.status, method).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
    }
  });

  it("answers 400 for a body that is not JSON or lacks a string field, without echoing it", async () => {
    const before = stored();
    for (const raw of ["not json secret", "", "null", "[]", '"x"', "42"]) {
      const res = await send(path, OWNER_TOKEN, raw);
      expect(res.status, raw).toBe(400);
      expect(await res.text()).not.toContain("secret");
    }
    for (const key of ["as", ...Object.keys(target), "body"]) {
      for (const value of [undefined, 1, null, ["x"]]) {
        const res = await send(path, OWNER_TOKEN, body({ [key]: value }));
        expect(res.status, `${key}=${JSON.stringify(value)}`).toBe(400);
      }
    }
    expect(stored()).toBe(before);
  });

  it("answers 400 with the tool's error for an invalid name, an empty or too long body or an unknown recipient", async () => {
    const before = stored();
    const kind = path === "/api/send" ? "Message" : "Post";
    const cases: [Record<string, unknown>, string][] = [
      [{ body: "  " }, `${kind} body is empty.`],
      [{ body: "secret ".repeat(1000) }, `${kind} is too long: at most 4000 characters.`],
      path === "/api/send"
        ? [{ to: "nobody" }, "No agent named 'nobody'."]
        : [{ channel: "no spaces" }, "Invalid channel name: use 1-32 characters from letters, digits, '-' and '_'."],
    ];
    for (const [fields, message] of cases) {
      const res = await send(path, OWNER_TOKEN, body(fields));
      expect(res.status).toBe(400);
      expect(await error(res)).toBe(message);
    }
    expect(stored()).toBe(before);
  });

  it("answers 413 for a body over the 64 KiB limit, and takes a longest body of escaped astral characters", async () => {
    const res = await send(path, OWNER_TOKEN, body({ body: "x".repeat(64 * 1024 + 1) }));
    expect(res.status).toBe(413);
    // 4000 characters of U+1F600, each escaped as \ud83d\ude00, is 48000 bytes of body text.
    const longest = JSON.stringify(body({ body: "\u{1F600}".repeat(4000) })).replace(/[\u{10000}-\u{10FFFF}]/gu, (c) =>
      c.split("").map((u) => "\\u" + u.charCodeAt(0).toString(16)).join(""),
    );
    expect(longest.length).toBeGreaterThan(48000);
    expect((await send(path, OWNER_TOKEN, longest)).status).toBe(200);
  });

  it("answers 503 with Retry-After when the database is busy, and 500 for any other failure", async () => {
    const prepare = db.prepare.bind(db);
    const fail = (code: string) => {
      vi.restoreAllMocks();
      let thrown = false;
      vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
        if (thrown || !sql.includes("person = 1")) return prepare(sql);
        thrown = true;
        throw Object.assign(new Error("database is locked"), { code });
      }) as typeof db.prepare);
    };
    fail("SQLITE_BUSY");
    const res = await send(path, OWNER_TOKEN, body({}));
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("1");
    fail("SQLITE_CORRUPT");
    expect((await send(path, OWNER_TOKEN, body({}))).status).toBe(500);
    vi.restoreAllMocks();
    expect((await send(path, OWNER_TOKEN, body({}))).status).toBe(200);
  });

  it("takes a slot per request before reading its body, capped at maxSessions, and gives it back", async () => {
    await http.close();
    await start({ maxSessions: 1 });
    // A request whose body has not arrived yet holds the only slot.
    const held = request(`${base()}${path}`, {
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
    for (const p of ["/api/send", "/api/post"]) {
      const refused = await send(p, OWNER_TOKEN, body({}));
      expect(refused.status).toBe(503);
      expect(refused.headers.get("connection")).toBe("close");
    }
    // Answers that need no body come before the cap.
    expect((await send(path, ownerViewer, body({}))).status).toBe(403);
    expect((await send(path, null, body({}))).status).toBe(401);
    expect((await send(path, OWNER_TOKEN, body({}), "GET")).status).toBe(405);
    held.end(" ".repeat(999));
    expect(await answered).toBe(400);
    expect((await send(path, OWNER_TOKEN, body({}))).status).toBe(200);
  });
});

describe("nothing acts as a person but these routes", () => {
  it("leaves a person with no identity, so no session or channel member can act as one", () => {
    expect(identityOf(db, OWNER_ACCOUNT, "colin")).toBeUndefined();
    expect(() => removeAgent(db, OWNER_ACCOUNT, "colin")).toThrow(/belongs to a person/);
  });
});
