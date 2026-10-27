import { mkdtempSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accountForToken, addAccount, addToken, listAccounts } from "../src/accounts.js";
import { addPerson, registerAgent, removePerson, setPersonAdmin } from "../src/agents.js";
import { postAsPerson } from "../src/channels.js";
import { OWNER_ACCOUNT, openDb, type AccountId, type Db } from "../src/db.js";
import { startHttp, type HttpServer } from "../src/http.js";
import { NotAdminError, OwnPersonError, listInvites, makeInvite, redeemLoginCode, removePersonBy, setAdminBy, LoginRefused } from "../src/login.js";
import { sendAsPerson } from "../src/messages.js";

// PATCH and DELETE /api/people: an admin person's token marks, unmarks and removes the other people of its own account,
// on a server with the owner's account and a friend's.
const OWNER_TOKEN = "owner-token";
let db: Db;
let http: HttpServer;
let friend: AccountId;
let ana: string;

const start = async (options: { maxSessions?: number } = {}) => {
  http = await startHttp(db, { token: OWNER_TOKEN, port: 0, waitHoldMs: 0, ...options });
};

beforeEach(async () => {
  db = openDb(join(mkdtempSync(join(tmpdir(), "message-cp-people-api-")), "db.sqlite"));
  addAccount(db, "friend");
  friend = listAccounts(db).find((a) => a.name === "friend")!.id;
  addPerson(db, "owner", "ana", true);
  addPerson(db, "owner", "ben");
  ana = personToken("owner", "ana");
  await start();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await http.close();
  db.close();
});

const personToken = (account: string, name: string) => addToken(db, account, false, false, undefined, name).token;
const base = () => `http://127.0.0.1:${http.port}`;
const call = (path: string, token: string | null, method = "GET", body?: unknown) =>
  fetch(`${base()}${path}`, {
    method,
    headers: { ...(token !== null && { Authorization: `Bearer ${token}` }), "Content-Type": "application/json" },
    ...(body !== undefined && { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
const mark = (name: string, admin: unknown, token = ana) => call(`/api/people?name=${encodeURIComponent(name)}`, token, "PATCH", { admin });
const remove = (name: string, token = ana) => call(`/api/people?name=${encodeURIComponent(name)}`, token, "DELETE");
const message = async (res: Response) => ((await res.json()) as { error: { message: string } }).error.message;
const people = () => db.prepare("SELECT account_id, name, person, admin FROM agents WHERE removed_at IS NULL ORDER BY id").all();
const messages = () => db.prepare("SELECT * FROM messages ORDER BY id").all();
const idOf = (account: AccountId, name: string) =>
  db.prepare("SELECT id FROM agents WHERE account_id = ? AND name = ? AND removed_at IS NULL").pluck().get(account, name) as number;
const OWN = "An admin cannot unmark or remove themselves. Ask another admin, or run message-cp person on the server";

describe("PATCH /api/people", () => {
  it("marks and unmarks a person in any case, and their existing token follows from its next request", async () => {
    const ben = personToken("owner", "ben");
    expect((await call("/api/invites", ben)).status).toBe(403);
    const res = await mark("BEN", true);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ name: "ben", admin: true });
    expect(await (await call("/api/token", ben)).json()).toMatchObject({ admin: true });
    expect((await call("/api/invites", ben)).status).toBe(200);
    expect(await (await mark("ben", false)).json()).toEqual({ name: "ben", admin: false });
    expect(await (await call("/api/token", ben)).json()).not.toHaveProperty("admin");
    expect((await call("/api/invites", ben)).status).toBe(403);
    // Marking an admin again, or ana as an admin, changes nothing and is no refusal.
    expect(await (await mark("ana", true)).json()).toEqual({ name: "ana", admin: true });
  });

  it("refuses the admin unmarking themselves with 403, changing nothing", async () => {
    const before = people();
    const res = await mark("ANA", false);
    expect(res.status).toBe(403);
    expect(await message(res)).toBe(OWN);
    expect(people()).toEqual(before);
  });

  it("answers 400 to a bad body or query, changing nothing", async () => {
    const before = people();
    for (const body of [{}, { admin: "true" }, { admin: 1 }, { admin: null }, [], null]) {
      const sent = await call("/api/people?name=ben", ana, "PATCH", body);
      expect(sent.status, JSON.stringify(body)).toBe(400);
      expect(await message(sent)).toBe("Give admin as true or false");
    }
    expect((await call("/api/people?name=ben", ana, "PATCH", "{")).status).toBe(400);
    for (const query of ["", "?name=", "?name=ben&name=ben", "?who=ben"]) {
      const res = await call(`/api/people${query}`, ana, "PATCH", { admin: true });
      expect(res.status, query).toBe(400);
      expect(res.headers.get("connection"), query).toBe("close");
    }
    expect(people()).toEqual(before);
  });
});

describe("DELETE /api/people", () => {
  it("removes a person with their direct messages and mentions, answering the counts and no message text", async () => {
    registerAgent(db, OWNER_ACCOUNT, "bot", "b");
    sendAsPerson(db, OWNER_ACCOUNT, "ana", "ben", "secret to ben");
    sendAsPerson(db, OWNER_ACCOUNT, "ben", "bot", "secret from ben");
    sendAsPerson(db, OWNER_ACCOUNT, "ana", "bot", "stays");
    postAsPerson(db, OWNER_ACCOUNT, "ana", "general", "@ben look");
    const res = await remove("Ben");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ name: "ben", messages: 2, mentions: 1 });
    expect(text).not.toContain("secret");
    expect(people()).not.toContainEqual(expect.objectContaining({ name: "ben" }));
    expect((messages() as { body: string }[]).map((m) => m.body)).toEqual(["stays"]);
    expect(db.prepare("SELECT count(*) FROM mentions").pluck().get()).toBe(0);
    // The name is free again.
    addPerson(db, "owner", "ben");
  });

  it("counts a message they sent themselves once", async () => {
    sendAsPerson(db, OWNER_ACCOUNT, "ben", "ben", "note to self");
    sendAsPerson(db, OWNER_ACCOUNT, "ben", "ana", "hi");
    expect(await (await remove("ben")).json()).toEqual({ name: "ben", messages: 2, mentions: 0 });
    expect(messages()).toEqual([]);
  });

  it("leaves their tokens refused with 401 and their unused invites unlisted and unredeemable", async () => {
    const ben = personToken("owner", "ben");
    const invite = makeInvite(db, OWNER_ACCOUNT, idOf(OWNER_ACCOUNT, "ana"), "ben")!.invite;
    expect(listInvites(db, OWNER_ACCOUNT, 50, 0)).toHaveLength(1);
    expect((await remove("ben")).status).toBe(200);
    expect((await call("/api/token", ben)).status).toBe(401);
    expect(listInvites(db, OWNER_ACCOUNT, 50, 0)).toEqual([]);
    expect(await (await call("/api/invites", ana)).json()).toEqual([]);
    expect(() => redeemLoginCode(db, invite.code)).toThrow(LoginRefused);
    const login = await call("/api/login", null, "POST", { code: invite.code });
    expect(login.status).toBe(400);
  });

  it("refuses the admin removing themselves with 403, changing nothing", async () => {
    sendAsPerson(db, OWNER_ACCOUNT, "ben", "ana", "x");
    const before = { people: people(), messages: messages() };
    const res = await remove("ana");
    expect(res.status).toBe(403);
    expect(await message(res)).toBe(OWN);
    expect({ people: people(), messages: messages() }).toEqual(before);
    expect((await call("/api/token", ana)).status).toBe(200);
  });

  it("answers 400 to a missing, empty or repeated name", async () => {
    for (const query of ["", "?name=", "?name=ben&name=ben", "?who=ben"]) expect((await call(`/api/people${query}`, ana, "DELETE")).status, query).toBe(400);
    expect(people()).toContainEqual(expect.objectContaining({ name: "ben" }));
  });
});

describe("who PATCH and DELETE /api/people reach", () => {
  it("answer the same 404 for an unknown, removed, agent's or another account's name, changing nothing", async () => {
    registerAgent(db, OWNER_ACCOUNT, "bot", "b");
    addPerson(db, "owner", "gone");
    removePerson(db, "owner", "gone");
    addPerson(db, "friend", "fay", true);
    sendAsPerson(db, friend, "fay", "fay", "x");
    const before = { people: people(), messages: messages() };
    for (const name of ["nobody", "gone", "bot", "fay"]) {
      for (const res of [await mark(name, true), await mark(name, false), await remove(name)]) {
        expect(res.status, name).toBe(404);
        expect(await message(res)).toBe("No such person");
      }
    }
    // Nor can another account's admin reach the owner's people.
    const fay = personToken("friend", "fay");
    expect((await mark("ben", true, fay)).status).toBe(404);
    expect((await remove("ben", fay)).status).toBe(404);
    expect((await remove("ana", fay)).status).toBe(404);
    expect({ people: people(), messages: messages() }).toEqual(before);
  });

  it("refuse a plain person, read-only, agent and full token with 403, closing the connection, before a body is read", async () => {
    const tokens = [
      [personToken("owner", "ben"), "A person token only reads, sends and posts"],
      [addToken(db, "owner", true).token, "This token is read-only"],
      [addToken(db, "owner", false, true).token, "Agent tokens cannot use the dashboard API"],
      [OWNER_TOKEN, /^A full token cannot add, mark or remove people or make invites\. Sign in as an admin person/],
    ] as const;
    const before = people();
    for (const [token, expected] of tokens) {
      for (const res of [await mark("ben", true, token), await mark("ana", false, token), await remove("ben", token)]) {
        expect(res.status).toBe(403);
        expect(res.headers.get("connection")).toBe("close");
        const text = await message(res);
        if (typeof expected === "string") expect(text).toBe(expected);
        else expect(text).toMatch(expected);
      }
    }
    expect(people()).toEqual(before);
  });

  it("refuse an admin removed or unmarked while their PATCH body was still arriving, changing nothing", async () => {
    for (const [change, undo] of [
      [() => setPersonAdmin(db, "owner", "ana", false), () => setPersonAdmin(db, "owner", "ana", true)],
      [
        () => removePerson(db, "owner", "ana"),
        () => {
          addPerson(db, "owner", "ana", true);
          ana = personToken("owner", "ana");
        },
      ],
    ] as const) {
      const text = JSON.stringify({ admin: true });
      const held = request(`${base()}/api/people?name=ben`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${ana}`, "Content-Type": "application/json", "Content-Length": String(text.length) },
      });
      const answered = new Promise<{ status: number; body: string }>((resolve, reject) => {
        held.on("response", (r) => {
          let got = "";
          r.on("data", (c) => (got += c));
          r.on("end", () => resolve({ status: r.statusCode!, body: got }));
        });
        held.on("error", reject);
      });
      held.write(text.slice(0, 1));
      await new Promise((r) => setTimeout(r, 100));
      change();
      held.end(text.slice(1));
      const res = await answered;
      expect(res.status).toBe(403);
      expect(res.body).toContain("This person is no longer an admin of the account");
      expect(people()).toContainEqual({ account_id: OWNER_ACCOUNT, name: "ben", person: 1, admin: 0 });
      undo();
    }
  });

  it("refuse setAdminBy and removePersonBy for anyone not a live admin of the account, and their own row", () => {
    addPerson(db, "friend", "fay", true);
    const agent = registerAgent(db, OWNER_ACCOUNT, "bot", "b");
    const before = people();
    for (const by of [idOf(OWNER_ACCOUNT, "ben"), idOf(friend, "fay"), idOf(OWNER_ACCOUNT, agent.name), 9999]) {
      expect(() => setAdminBy(db, OWNER_ACCOUNT, by, "ben", true)).toThrow(NotAdminError);
      expect(() => removePersonBy(db, OWNER_ACCOUNT, by, "ben")).toThrow(NotAdminError);
    }
    const self = idOf(OWNER_ACCOUNT, "ana");
    expect(() => setAdminBy(db, OWNER_ACCOUNT, self, "ana", false)).toThrow(OwnPersonError);
    expect(() => removePersonBy(db, OWNER_ACCOUNT, self, "ana")).toThrow(OwnPersonError);
    expect(people()).toEqual(before);
  });

  it("answer 503 with Retry-After when the database is busy, and 500 for any other failure, changing nothing", async () => {
    const prepare = db.prepare.bind(db);
    const fail = (code: string, statement: string) => {
      vi.restoreAllMocks();
      let thrown = false;
      vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
        if (thrown || !sql.includes(statement)) return prepare(sql);
        thrown = true;
        throw Object.assign(new Error("database is locked"), { code });
      }) as typeof db.prepare);
    };
    sendAsPerson(db, OWNER_ACCOUNT, "ana", "ben", "x");
    sendAsPerson(db, OWNER_ACCOUNT, "ben", "ana", "y");
    const before = { people: people(), messages: messages() };
    for (const [send, statement] of [
      [() => mark("ben", true), "UPDATE agents SET admin"],
      [() => remove("ben"), "DELETE FROM messages WHERE recipient_id"],
      // The second delete failing rolls back the first.
      [() => remove("ben"), "DELETE FROM messages WHERE sender"],
    ] as const) {
      fail("SQLITE_BUSY", statement);
      const res = await send();
      expect(res.status, statement).toBe(503);
      expect(res.headers.get("retry-after")).toBe("1");
      fail("SQLITE_CORRUPT", statement);
      expect((await send()).status, statement).toBe(500);
    }
    vi.restoreAllMocks();
    expect({ people: people(), messages: messages() }).toEqual(before);
  });

  it("answer 405 with Allow to another method", async () => {
    for (const method of ["GET", "PUT"]) {
      const res = await call("/api/people?name=ben", ana, method);
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST, PATCH, DELETE");
    }
  });

  it("take a slot for a PATCH before reading its body, shared with /api/send, but none for a DELETE", async () => {
    await http.close();
    await start({ maxSessions: 1 });
    const held = request(`${base()}/api/send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ana}`, "Content-Type": "application/json", "Content-Length": "1000" },
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
    const refused = await mark("ben", true);
    expect(refused.status).toBe(503);
    expect(refused.headers.get("connection")).toBe("close");
    // What can be answered at once is answered before the cap.
    expect((await mark("ben", true, OWNER_TOKEN)).status).toBe(403);
    expect((await call("/api/people?name=ben", null, "PATCH", { admin: true })).status).toBe(401);
    expect((await remove("ben")).status).toBe(200);
    held.end(" ".repeat(999));
    expect(await answered).toBe(400);
    expect(accountForToken(db, ana, OWNER_TOKEN)?.person?.admin).toBe(true);
  });
});

describe("removePerson's plan", () => {
  it("deletes a person's messages through messages_history and messages_by_pair, without scanning messages", () => {
    const plan = (sql: string) =>
      (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]).map((p) => p.detail);
    const toThem = plan("DELETE FROM messages WHERE recipient_id = 1");
    expect(toThem[0]).toBe("SEARCH messages USING COVERING INDEX messages_history (recipient_id=?)");
    const fromThem = plan(
      `DELETE FROM messages WHERE sender = 'a' COLLATE NOCASE AND created_at >= 0
       AND recipient_id IN (SELECT id FROM agents WHERE account_id = 1)`,
    );
    expect(fromThem[0]).toMatch(/^SEARCH messages USING COVERING INDEX messages_by_pair \(recipient_id=\? AND sender=\? AND created_at>\?\)$/);
    for (const lines of [toThem, fromThem]) {
      expect(lines.join("\n")).not.toMatch(/SCAN messages/);
      expect(lines).toContain("SEARCH webhook_deliveries USING COVERING INDEX webhook_deliveries_by_message (message_id=?)");
    }
    expect(plan("DELETE FROM mentions WHERE agent_id = 1")).toEqual(["SEARCH mentions USING COVERING INDEX sqlite_autoindex_mentions_1 (agent_id=?)"]);
  });
});
