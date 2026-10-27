import { mkdtempSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { accountForToken, addAccount, addToken, listAccounts } from "../src/accounts.js";
import { addPerson, registerAgent, removePerson, setPersonAdmin } from "../src/agents.js";
import { OWNER_ACCOUNT, openDb, type AccountId, type Db } from "../src/db.js";
import { startHttp, type HttpServer } from "../src/http.js";
import {
  INVITE_TTL_MS,
  LOGIN_CODE_TTL_MS,
  LoginError,
  LoginRefused,
  MAX_INVITES_PER_ACCOUNT,
  MAX_LOGIN_CODES,
  NotAdminError,
  addInvitedPerson,
  cancelInvite,
  makeInvite,
  makeLoginCode,
  redeemLoginCode,
} from "../src/login.js";

// Invites: an admin person's token adds people (POST /api/people) and makes (POST /api/invites), lists (GET) and cancels
// (DELETE) one-time sign-in links lasting INVITE_TTL_MS, on a server with the owner's account and a friend's.
const OWNER_TOKEN = "owner-token";
const PUBLIC_URL = "https://h.example/base/mcp";
let db: Db;
let http: HttpServer;
let friend: AccountId;
let ana: string;

const start = async (options: { maxSessions?: number; publicUrl?: string } = {}) => {
  http = await startHttp(db, { token: OWNER_TOKEN, port: 0, waitHoldMs: 0, ...options });
};

beforeEach(async () => {
  db = openDb(join(mkdtempSync(join(tmpdir(), "message-cp-invites-")), "db.sqlite"));
  addAccount(db, "friend");
  friend = listAccounts(db).find((a) => a.name === "friend")!.id;
  addPerson(db, "owner", "ana", true);
  ana = personToken("owner", "ana");
  await start({ publicUrl: PUBLIC_URL });
});

afterEach(async () => {
  await http.close();
  db.close();
});

const personToken = (account: string, name: string) => addToken(db, account, false, false, undefined, name).token;
const base = () => `http://127.0.0.1:${http.port}`;
const call = (path: string, token: string | null, method = "GET", body?: unknown) =>
  fetch(`${base()}${path}`, {
    method,
    headers: { ...(token !== null && { Authorization: `Bearer ${token}` }), "Content-Type": "application/json" },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
const login = (code: string) => call("/api/login", null, "POST", { code });
const message = async (res: Response) => ((await res.json()) as { error: { message: string } }).error.message;
/** A live admin of `account`'s row, adding one named boss if it has none, as a token's person is passed to makeInvite. */
const adminOf = (account: AccountId): number => {
  const find = () =>
    db.prepare("SELECT id FROM agents WHERE account_id = ? AND person = 1 AND admin = 1 AND removed_at IS NULL ORDER BY id").pluck().get(account) as
      | number
      | undefined;
  const found = find();
  if (found !== undefined) return found;
  addPerson(db, listAccounts(db).find((a) => a.id === account)!.name, "boss", true);
  return find()!;
};
const mkInvite = (account: AccountId, person: string, now?: number) => makeInvite(db, account, adminOf(account), person, now);
const codes = () => db.prepare("SELECT * FROM login_codes ORDER BY id").all() as Record<string, unknown>[];
const people = () => db.prepare("SELECT account_id, name, person, admin FROM agents WHERE removed_at IS NULL ORDER BY id").all();
const sha256 = async (text: string) => (await import("node:crypto")).createHash("sha256").update(text).digest("hex");

interface Answer {
  name: string;
  admin: boolean;
  invite: { id: number; code: string; expiresAt: string; link?: string };
}

describe("POST /api/people", () => {
  it("adds a person and their invite in one go, storing only the code's hash, and the invite signs in as them once", async () => {
    const before = Date.now();
    const res = await call("/api/people", ana, "POST", { name: "Ben", admin: false });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const answer = (await res.json()) as Answer;
    expect(answer).toMatchObject({ name: "Ben", admin: false, invite: { id: expect.any(Number) } });
    expect(answer.invite.code).toMatch(/^[0-9a-f]{64}$/);
    expect(answer.invite.link).toBe(`https://h.example/base/#code=${answer.invite.code}`);
    const expires = Date.parse(answer.invite.expiresAt);
    expect(expires).toBeGreaterThanOrEqual(before + INVITE_TTL_MS);
    expect(expires).toBeLessThanOrEqual(Date.now() + INVITE_TTL_MS);
    expect(people()).toContainEqual({ account_id: OWNER_ACCOUNT, name: "Ben", person: 1, admin: 0 });
    const [row] = codes();
    const ben = db.prepare("SELECT id FROM agents WHERE name = 'Ben'").pluck().get();
    expect(row).toMatchObject({ id: answer.invite.id, account_id: OWNER_ACCOUNT, person_id: ben, invite: 1, used_at: null, cancelled_at: null });
    expect(row.code_hash).toBe(await sha256(answer.invite.code));
    expect(JSON.stringify(codes())).not.toContain(answer.invite.code);

    const signed = await login(answer.invite.code);
    expect(signed.status).toBe(200);
    const token = ((await signed.json()) as { token: string }).token;
    expect(accountForToken(db, token, OWNER_TOKEN)?.person).toEqual({ id: ben, name: "Ben", admin: false });
    const again = await login(answer.invite.code);
    expect(again.status).toBe(400);
    expect(await again.json()).toEqual({ reason: "used", message: "This link was already used." });
  });

  it("adds an admin with admin true, and leaves out the link without a public URL", async () => {
    await http.close();
    await start();
    const answer = (await (await call("/api/people", ana, "POST", { name: "cy", admin: true })).json()) as Answer;
    expect(answer.admin).toBe(true);
    expect(answer.invite).not.toHaveProperty("link");
    expect(people()).toContainEqual({ account_id: OWNER_ACCOUNT, name: "cy", person: 1, admin: 1 });
  });

  it("refuses a name addPerson refuses, or a bad body, with 400 and stores nothing", async () => {
    registerAgent(db, OWNER_ACCOUNT, "bob", "x");
    const before = { people: people(), codes: codes() };
    for (const [body, expected] of [
      [{ name: "BOB", admin: false }, "The name 'bob' is already used by an agent in account 'owner'."],
      [{ name: "ANA", admin: false }, "The name 'ana' is already used by a person in account 'owner'."],
      [{ name: "all", admin: false }, /all/],
      [{ name: "no spaces", admin: false }, /./],
      [{ name: "dee" }, "Give name as a string and admin as true or false"],
      [{ name: "dee", admin: "yes" }, "Give name as a string and admin as true or false"],
      [[], "Give name as a string and admin as true or false"],
    ] as const) {
      const res = await call("/api/people", ana, "POST", body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      const text = await message(res);
      if (typeof expected === "string") expect(text).toBe(expected);
      else expect(text).toMatch(expected);
    }
    const bad = await fetch(`${base()}/api/people`, { method: "POST", headers: { Authorization: `Bearer ${ana}` }, body: "{" });
    expect(bad.status).toBe(400);
    expect({ people: people(), codes: codes() }).toEqual(before);
  });

  it("adds the person into the token's own account only, a name another account has included", async () => {
    addPerson(db, "friend", "ben");
    const res = await call("/api/people", ana, "POST", { name: "ben", admin: false });
    expect(res.status).toBe(200);
    expect(people()).toContainEqual({ account_id: OWNER_ACCOUNT, name: "ben", person: 1, admin: 0 });
    expect(codes().map((c) => c.account_id)).toEqual([OWNER_ACCOUNT]);
  });

  it("stores neither the person nor the invite past MAX_INVITES_PER_ACCOUNT", async () => {
    for (let i = 0; i < MAX_INVITES_PER_ACCOUNT; i++) mkInvite(OWNER_ACCOUNT, "ana");
    const before = { people: people(), codes: codes() };
    const res = await call("/api/people", ana, "POST", { name: "dee", admin: false });
    expect(res.status).toBe(503);
    expect(await message(res)).toBe(`This account has made ${MAX_INVITES_PER_ACCOUNT} invites in the last 7 days; try again once some expire.`);
    expect({ people: people(), codes: codes() }).toEqual(before);
  });
});

describe("POST /api/invites", () => {
  it("makes a new invite for a live person in any case, and keeps their earlier invites valid", async () => {
    addPerson(db, "owner", "ben");
    const first = (await (await call("/api/invites", ana, "POST", { person: "ben" })).json()) as Answer;
    const res = await call("/api/invites", ana, "POST", { person: "BEN" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const second = (await res.json()) as Answer;
    expect(second).toMatchObject({ name: "ben", admin: false });
    expect(second.invite.link).toBe(`https://h.example/base/#code=${second.invite.code}`);
    expect(second.invite.id).not.toBe(first.invite.id);
    expect(codes().map((c) => [c.invite, c.used_at])).toEqual([
      [1, null],
      [1, null],
    ]);
    expect((await login(first.invite.code)).status).toBe(200);
    expect((await login(second.invite.code)).status).toBe(200);
  });

  it("answers 404 for an agent's name, an unknown or removed person, or another account's person, storing nothing", async () => {
    registerAgent(db, OWNER_ACCOUNT, "bob", "x");
    addPerson(db, "owner", "gone");
    removePerson(db, "owner", "gone");
    addPerson(db, "friend", "fay");
    for (const person of ["bob", "nobody", "gone", "fay"]) {
      const res = await call("/api/invites", ana, "POST", { person });
      expect(res.status, person).toBe(404);
    }
    expect((await call("/api/invites", ana, "POST", { person: 3 })).status).toBe(400);
    expect(codes()).toEqual([]);
  });

  it("gives no token for an invite whose person was removed before it was redeemed", async () => {
    addPerson(db, "owner", "ben");
    const { invite } = (await (await call("/api/invites", ana, "POST", { person: "ben" })).json()) as Answer;
    removePerson(db, "owner", "ben");
    const res = await login(invite.code);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { reason: string }).reason).toBe("invalid");
    expect(db.prepare("SELECT count(*) FROM tokens WHERE person_id IS NOT NULL").pluck().get()).toBe(1);
  });
});

describe("invites and login-link codes", () => {
  it("expires an invite after 7 days, and leaves a login-link code at 5 minutes", () => {
    addPerson(db, "owner", "ben");
    const now = 1_000_000;
    const invite = mkInvite(OWNER_ACCOUNT, "ben", now)!.invite;
    expect(invite.expiresAt).toBe(now + 7 * 24 * 60 * 60 * 1000);
    const link = makeLoginCode(db, "owner", "ben", now);
    expect(link.expiresAt).toBe(now + LOGIN_CODE_TTL_MS);
    expect(codes().map((c) => [c.invite, c.created_at])).toEqual([
      [1, now],
      [0, now],
    ]);
    const refused = (fn: () => unknown) => {
      try {
        fn();
      } catch (err) {
        if (err instanceof LoginRefused) return err.reason;
        throw err;
      }
      return "redeemed";
    };
    expect(refused(() => redeemLoginCode(db, link.code, now + LOGIN_CODE_TTL_MS))).toBe("invalid");
    expect(refused(() => redeemLoginCode(db, invite.code, now + INVITE_TTL_MS))).toBe("invalid");
    const later = mkInvite(OWNER_ACCOUNT, "ben", now)!.invite;
    expect(refused(() => redeemLoginCode(db, later.code, now + INVITE_TTL_MS - 1))).toBe("redeemed");
  });
});

describe("the invite cap", () => {
  it("counts each account's invites apart, cancelled ones included, so a full account blocks no other account or login-link", () => {
    addPerson(db, "friend", "fay");
    for (let i = 0; i < MAX_INVITES_PER_ACCOUNT; i++) {
      const { invite } = mkInvite(OWNER_ACCOUNT, "ana")!;
      if (i % 2 === 0) cancelInvite(db, OWNER_ACCOUNT, invite.id);
    }
    expect(() => mkInvite(OWNER_ACCOUNT, "ana")).toThrow(LoginError);
    expect(mkInvite(friend, "fay")).toMatchObject({ name: "fay" });
    expect(makeLoginCode(db, "owner", "ana")).toMatchObject({ person: "ana" });
    // Expired invites stop counting, and are deleted when the next code is made.
    expect(mkInvite(OWNER_ACCOUNT, "ana", Date.now() + INVITE_TTL_MS)).toMatchObject({ name: "ana" });
    expect(db.prepare("SELECT count(*) FROM login_codes WHERE account_id = ? AND invite = 1").pluck().get(OWNER_ACCOUNT)).toBe(1);
  });

  it("leaves login-link's MAX_LOGIN_CODES counting only login-link codes", () => {
    const insert = db.prepare("INSERT INTO login_codes (code_hash, account_id, expires_at) VALUES (?, ?, ?)");
    for (let i = 0; i < MAX_LOGIN_CODES; i++) insert.run(`h${i}`, OWNER_ACCOUNT, Date.now() + 60_000);
    expect(() => makeLoginCode(db, "owner")).toThrow(LoginError);
    expect(mkInvite(OWNER_ACCOUNT, "ana")).toMatchObject({ name: "ana" });
  });
});

describe("GET /api/invites", () => {
  it("lists the account's unused invites newest first, paged, never a code, leaving out login-link codes and other accounts'", async () => {
    addPerson(db, "owner", "ben");
    addPerson(db, "owner", "cy");
    addPerson(db, "owner", "gone");
    addPerson(db, "friend", "fay");
    const used = mkInvite(OWNER_ACCOUNT, "ben")!.invite;
    redeemLoginCode(db, used.code);
    const expired = mkInvite(OWNER_ACCOUNT, "ben", Date.now() - INVITE_TTL_MS)!.invite;
    const ben = mkInvite(OWNER_ACCOUNT, "ben")!.invite;
    mkInvite(OWNER_ACCOUNT, "gone");
    removePerson(db, "owner", "gone");
    makeLoginCode(db, "owner", "cy");
    const cy = mkInvite(OWNER_ACCOUNT, "cy")!.invite;
    mkInvite(friend, "fay");
    const cancelled = mkInvite(OWNER_ACCOUNT, "cy")!.invite;
    expect((await call(`/api/invites?id=${cancelled.id}`, ana, "DELETE")).status).toBe(200);

    const res = await call("/api/invites", ana);
    expect(res.status).toBe(200);
    const text = await res.text();
    for (const c of [used, expired, ben, cy]) expect(text).not.toContain(c.code);
    const list = JSON.parse(text) as { id: number; person: string; createdAt: string; expiresAt: string }[];
    expect(list.map((i) => [i.id, i.person])).toEqual([
      [cy.id, "cy"],
      [ben.id, "ben"],
    ]);
    expect(Object.keys(list[0]).sort()).toEqual(["createdAt", "expiresAt", "id", "person"]);
    expect(list[0].expiresAt).toBe(new Date(cy.expiresAt).toISOString());
    expect(Date.parse(list[0].expiresAt) - Date.parse(list[0].createdAt)).toBe(INVITE_TTL_MS);
    expect((await (await call("/api/invites?limit=1&offset=1", ana)).json()) as unknown[]).toEqual([list[1]]);
    expect((await call("/api/invites?limit=0", ana)).status).toBe(400);
    expect((await call("/api/invites?limit=201", ana)).status).toBe(400);
  });
});

describe("DELETE /api/invites", () => {
  it("cancels an unused invite once, after which it answers cancelled at POST /api/login", async () => {
    addPerson(db, "owner", "ben");
    const { invite } = mkInvite(OWNER_ACCOUNT, "ben")!;
    const res = await call(`/api/invites?id=${invite.id}`, ana, "DELETE");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cancelled: true });
    const [row] = codes();
    expect(row.cancelled_at).toEqual(expect.any(Number));
    // Set too, so a server from before cancelled_at refuses it as used.
    expect(row.used_at).toBe(row.cancelled_at);
    const signed = await login(invite.code);
    expect(signed.status).toBe(400);
    expect(await signed.json()).toEqual({ reason: "cancelled", message: "This link was cancelled." });
    expect((await call(`/api/invites?id=${invite.id}`, ana, "DELETE")).status).toBe(404);
    expect(db.prepare("SELECT count(*) FROM tokens WHERE person_id IS NOT NULL").pluck().get()).toBe(1);
  });

  it("answers the same 404 for a used, expired, removed person's, login-link, unknown or other account's id, changing nothing", async () => {
    addPerson(db, "owner", "ben");
    addPerson(db, "friend", "fay");
    const used = mkInvite(OWNER_ACCOUNT, "ben")!.invite;
    redeemLoginCode(db, used.code);
    const expired = mkInvite(OWNER_ACCOUNT, "ben", Date.now() - INVITE_TTL_MS)!.invite;
    const theirs = mkInvite(friend, "fay")!.invite;
    addPerson(db, "owner", "gone");
    const gone = mkInvite(OWNER_ACCOUNT, "gone")!.invite;
    removePerson(db, "owner", "gone");
    makeLoginCode(db, "owner", "ben");
    const link = db.prepare("SELECT id FROM login_codes WHERE invite = 0").pluck().get() as number;
    const before = codes();
    for (const id of [used.id, expired.id, theirs.id, gone.id, link, 9999]) {
      const res = await call(`/api/invites?id=${id}`, ana, "DELETE");
      expect(res.status, String(id)).toBe(404);
      expect(await message(res)).toBe("No such invite");
    }
    for (const q of ["", "?id=x", "?id=1&id=2", "?id=0", "?id=99999999999999999999"]) {
      expect((await call(`/api/invites${q}`, ana, "DELETE")).status, q).not.toBe(200);
    }
    expect(codes()).toEqual(before);
    expect((await login(theirs.code)).status).toBe(200);
  });
});

describe("invite ids", () => {
  it("never hands out an expired invite's id again, so a stale DELETE cannot cancel a later invite", async () => {
    addPerson(db, "owner", "ben");
    const old = mkInvite(OWNER_ACCOUNT, "ben", Date.now() - INVITE_TTL_MS)!.invite;
    // Making the next invite deletes the expired one, the highest row of the table.
    const later = mkInvite(OWNER_ACCOUNT, "ben")!.invite;
    expect(codes().map((c) => c.id)).toEqual([later.id]);
    expect(later.id).toBeGreaterThan(old.id);
    expect((await call(`/api/invites?id=${old.id}`, ana, "DELETE")).status).toBe(404);
    expect((await login(later.code)).status).toBe(200);
  });

  it("rebuilds a login_codes table from before AUTOINCREMENT, keeping every code, its id and its indexes", () => {
    const file = join(mkdtempSync(join(tmpdir(), "message-cp-invites-old-")), "db.sqlite");
    openDb(file).close();
    const raw = new Database(file);
    raw.exec(`
      DROP TABLE login_codes;
      CREATE TABLE login_codes (
        id INTEGER PRIMARY KEY,
        code_hash TEXT NOT NULL UNIQUE,
        account_id INTEGER NOT NULL REFERENCES accounts(id),
        person_id INTEGER REFERENCES agents(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL,
        used_at INTEGER
      );
      CREATE INDEX login_codes_by_expiry ON login_codes (expires_at);
      CREATE INDEX login_codes_by_person ON login_codes (person_id);
      INSERT INTO login_codes (id, code_hash, account_id, person_id, expires_at, used_at) VALUES
        (4, 'a', 1, NULL, 10, NULL),
        (9, 'b', 1, NULL, 20, 15);
    `);
    raw.close();
    const indexes = (d: Database.Database) =>
      d.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'login_codes' AND sql IS NOT NULL ORDER BY name").pluck().all();
    const reopened = openDb(file);
    openDb(file).close(); // a second open is harmless
    expect(reopened.prepare("SELECT sql FROM sqlite_master WHERE name = 'login_codes'").pluck().get()).toMatch(/id INTEGER PRIMARY KEY AUTOINCREMENT/);
    expect(reopened.prepare("SELECT id, code_hash, expires_at, used_at, invite, created_at, cancelled_at FROM login_codes ORDER BY id").all()).toEqual([
      { id: 4, code_hash: "a", expires_at: 10, used_at: null, invite: 0, created_at: null, cancelled_at: null },
      { id: 9, code_hash: "b", expires_at: 20, used_at: 15, invite: 0, created_at: null, cancelled_at: null },
    ]);
    expect(indexes(reopened)).toEqual(["login_codes_by_expiry", "login_codes_by_person", "login_codes_invites", "login_codes_unused_links"]);
    // Both rows have expired: the next code deletes them and still takes a new id.
    addPerson(reopened, "owner", "boss", true);
    const boss = reopened.prepare("SELECT id FROM agents WHERE name = 'boss'").pluck().get() as number;
    expect(makeInvite(reopened, OWNER_ACCOUNT, boss, "boss")!.invite.id).toBe(10);
    reopened.close();
  });
});

describe("who reaches the invite routes", () => {
  const routes = [
    ["/api/people", "POST", { name: "dee", admin: false }],
    ["/api/invites", "POST", { person: "ana" }],
    ["/api/invites", "GET", undefined],
    ["/api/invites?id=1", "DELETE", undefined],
  ] as const;

  it("refuses a plain person, read-only, agent and full token with 403, closing the connection, and stores nothing", async () => {
    addPerson(db, "owner", "ben");
    mkInvite(OWNER_ACCOUNT, "ana");
    const tokens = [
      [personToken("owner", "ben"), "A person token only reads, sends and posts"],
      [addToken(db, "owner", true).token, "This token is read-only"],
      [addToken(db, "owner", false, true).token, "Agent tokens cannot use the dashboard API"],
      [OWNER_TOKEN, /^A full token cannot add, mark or remove people or make invites\. Sign in as an admin person/],
    ] as const;
    const before = { people: people(), codes: codes() };
    for (const [token, expected] of tokens) {
      for (const [path, method, body] of routes) {
        const res = await call(path, token, method, body);
        expect(res.status, `${method} ${path}`).toBe(403);
        expect(res.headers.get("connection"), `${method} ${path}`).toBe("close");
        const text = await message(res);
        if (typeof expected === "string") expect(text).toBe(expected);
        else expect(text).toMatch(expected);
      }
    }
    expect({ people: people(), codes: codes() }).toEqual(before);
  });

  it("refuses an admin's token with 403 from the request after they are marked not admin, and 401 once removed", async () => {
    expect((await call("/api/invites", ana)).status).toBe(200);
    setPersonAdmin(db, "owner", "ana", false);
    const res = await call("/api/invites", ana);
    expect(res.status).toBe(403);
    expect(await message(res)).toBe("A person token only reads, sends and posts");
    expect((await call("/api/people", ana, "POST", { name: "dee", admin: false })).status).toBe(403);
    setPersonAdmin(db, "owner", "ana", true);
    expect((await call("/api/invites", ana)).status).toBe(200);
    removePerson(db, "owner", "ana");
    for (const [path, method, body] of routes) expect((await call(path, ana, method, body)).status, `${method} ${path}`).toBe(401);
    expect(people()).not.toContainEqual(expect.objectContaining({ name: "dee" }));
  });

  it("refuses an admin removed or unmarked while their POST body was still arriving, storing nothing", async () => {
    addPerson(db, "owner", "ben");
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
      for (const [path, body] of [
        ["/api/people", { name: "dee", admin: true }],
        ["/api/invites", { person: "ben" }],
      ] as const) {
        const text = JSON.stringify(body);
        const held = request(`${base()}${path}`, {
          method: "POST",
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
        expect(res.status, path).toBe(403);
        expect(res.body).toContain("This person is no longer an admin of the account");
        expect(codes()).toEqual([]);
        expect(people()).not.toContainEqual(expect.objectContaining({ name: "dee" }));
        undo();
      }
    }
  });

  it("refuses makeInvite and addInvitedPerson for a person who is not a live admin of the account", () => {
    addPerson(db, "owner", "ben");
    addPerson(db, "friend", "fay", true);
    const id = (account: AccountId, name: string) =>
      db.prepare("SELECT id FROM agents WHERE account_id = ? AND name = ?").pluck().get(account, name) as number;
    const agent = registerAgent(db, OWNER_ACCOUNT, "bot", "b");
    for (const by of [id(OWNER_ACCOUNT, "ben"), id(friend, "fay"), id(OWNER_ACCOUNT, agent.name), 9999]) {
      expect(() => makeInvite(db, OWNER_ACCOUNT, by, "ben")).toThrow(NotAdminError);
      expect(() => addInvitedPerson(db, OWNER_ACCOUNT, by, "dee", false)).toThrow(NotAdminError);
    }
    expect(codes()).toEqual([]);
    expect(people()).not.toContainEqual(expect.objectContaining({ name: "dee" }));
  });

  it("keeps a second account's admin out of the first account entirely", async () => {
    addPerson(db, "friend", "fay", true);
    const fay = personToken("friend", "fay");
    addPerson(db, "owner", "ben");
    const ours = mkInvite(OWNER_ACCOUNT, "ben")!.invite;
    expect(await (await call("/api/invites", fay)).json()).toEqual([]);
    expect((await call(`/api/invites?id=${ours.id}`, fay, "DELETE")).status).toBe(404);
    expect((await call("/api/invites", fay, "POST", { person: "ben" })).status).toBe(404);
    const added = (await (await call("/api/people", fay, "POST", { name: "ben", admin: true })).json()) as Answer;
    expect(people()).toContainEqual({ account_id: friend, name: "ben", person: 1, admin: 1 });
    expect(codes().filter((c) => c.account_id === OWNER_ACCOUNT)).toHaveLength(1);
    expect(codes()[0].used_at).toBeNull();
    const token = ((await (await login(added.invite.code)).json()) as { token: string }).token;
    expect(accountForToken(db, token, OWNER_TOKEN)?.account).toBe(friend);
    expect((await login(ours.code)).status).toBe(200);
  });

  it("answers 405 for another method", async () => {
    expect((await call("/api/people", ana)).status).toBe(405);
    expect((await call("/api/invites", ana, "PUT")).status).toBe(405);
  });

  it("takes a slot for each POST before reading its body, shared with /api/send, and answers what it can before the cap", async () => {
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
    for (const [path, , body] of routes.filter(([, method]) => method === "POST")) {
      const refused = await call(path, ana, "POST", body);
      expect(refused.status, path).toBe(503);
      expect(refused.headers.get("connection")).toBe("close");
    }
    expect((await call("/api/invites", ana)).status).toBe(200);
    expect((await call("/api/people", OWNER_TOKEN, "POST", {})).status).toBe(403);
    expect((await call("/api/people", null, "POST", {})).status).toBe(401);
    expect((await call("/api/people", ana)).status).toBe(405);
    held.end(" ".repeat(999));
    expect(await answered).toBe(400);
    expect((await call("/api/invites", ana, "POST", { person: "ana" })).status).toBe(200);
    expect(codes()).toHaveLength(1);
  });
});

describe("the invite list's plan", () => {
  it("pages an account's unused invites through login_codes_invites, without scanning or sorting other codes", () => {
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT login_codes.id, agents.name, login_codes.created_at, login_codes.expires_at
         FROM login_codes JOIN agents ON agents.id = login_codes.person_id AND agents.account_id = login_codes.account_id
           AND agents.removed_at IS NULL AND agents.person = 1
         WHERE login_codes.account_id = ? AND login_codes.invite = 1 AND login_codes.used_at IS NULL
           AND login_codes.cancelled_at IS NULL AND login_codes.expires_at > ?
         ORDER BY login_codes.id DESC LIMIT ? OFFSET ?`,
      )
      .all(1, 0, 50, 0)
      .map((r) => (r as { detail: string }).detail);
    expect(plan).toEqual(["SEARCH login_codes USING INDEX login_codes_invites (account_id=? AND used_at=?)", "SEARCH agents USING INTEGER PRIMARY KEY (rowid=?)"]);
  });

  it("counts invites and login-link codes for the cap through their indexes, not by scanning the table", () => {
    const detail = (sql: string, ...p: unknown[]) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...p).map((r) => (r as { detail: string }).detail);
    expect(detail("SELECT count(*) FROM login_codes WHERE invite = 1 AND account_id = ?", 1)).toEqual([
      "SEARCH login_codes USING COVERING INDEX login_codes_invites (account_id=?)",
    ]);
    expect(detail("SELECT count(*) FROM login_codes WHERE invite = 0 AND used_at IS NULL")).toEqual([
      "SEARCH login_codes USING COVERING INDEX login_codes_unused_links (used_at=?)",
    ]);
  });
});
