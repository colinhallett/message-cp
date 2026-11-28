import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addAccount, addToken, revokeToken } from "../src/accounts.js";
import { addPerson, removePerson } from "../src/agents.js";
import { openDb, type Db } from "../src/db.js";
import { startHttp, type HttpServer } from "../src/http.js";
import {
  COUNT_TOKEN_SESSIONS,
  END_OWN_SIGNIN,
  endOwnSignin,
  LoginError,
  MAX_SESSIONS_PER_TOKEN,
  makeLoginCode,
  redeemLoginCode,
  signInWithToken,
} from "../src/login.js";

// POST /api/session: a token pasted into the dashboard is exchanged for its own sign-in session, on a server with the
// owner's account and a friend's, each with an admin person.
const OWNER_TOKEN = "owner-token";
let db: Db;
let http: HttpServer;

beforeEach(async () => {
  db = openDb(join(mkdtempSync(join(tmpdir(), "message-cp-session-api-")), "db.sqlite"));
  addAccount(db, "friend");
  addPerson(db, "owner", "maria", true);
  addPerson(db, "friend", "fay", true);
  http = await startHttp(db, { token: OWNER_TOKEN, port: 0, waitHoldMs: 0 });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await http.close();
  db.close();
});

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const call = (path: string, token: string, method = "GET", body?: string) =>
  fetch(`http://127.0.0.1:${http.port}${path}`, { method, headers: { Authorization: `Bearer ${token}` }, body });
const exchange = (token: string) => call("/api/session", token, "POST");
const sessions = () => db.prepare("SELECT * FROM dashboard_sessions ORDER BY id").all();
const sessionRow = (session: string) =>
  db.prepare("SELECT id, token_id FROM dashboard_sessions WHERE hash = ?").get(sha256(session)) as { id: number; token_id: number } | undefined;

/** Exchanges `token` and answers the new session, checking the answer is 200, never cached, and carries no token. */
async function signIn(token: string): Promise<string> {
  const res = await exchange(token);
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  const text = await res.text();
  expect(text).not.toContain(token);
  const { session } = JSON.parse(text) as { session: string };
  expect(session).toMatch(/^[0-9a-f]{64}$/);
  return session;
}

interface SigninJson {
  id: number;
  tokenId: number;
  kind: string;
  person?: string;
}

describe("POST /api/session", () => {
  it("starts a new session for a full, read-only or person token's own row, stored only as its hash", async () => {
    const tokens = db.prepare("SELECT COUNT(*) FROM tokens").pluck().get();
    const made = [addToken(db, "owner"), addToken(db, "owner", true), addToken(db, "owner", false, false, undefined, "maria")];
    const given: string[] = [];
    for (const t of made) {
      const session = await signIn(t.token);
      expect(sessionRow(session)?.token_id).toBe(t.id);
      // A second paste of the same token is a second browser.
      const again = await signIn(t.token);
      expect(again).not.toBe(session);
      expect(sessionRow(again)?.token_id).toBe(t.id);
      given.push(session, again);
    }
    const stored = JSON.stringify(sessions());
    for (const secret of [...given, ...made.map((t) => t.token)]) expect(stored).not.toContain(secret);
    // No token is issued, unlike a login link.
    expect(db.prepare("SELECT COUNT(*) FROM tokens").pluck().get()).toBe(tokens + 3);
  });

  it("answers { session: null }, starting none, for the owner token and for a value already a session", async () => {
    const link = redeemLoginCode(db, makeLoginCode(db, "owner", "maria").code);
    const pasted = await signIn(addToken(db, "owner").token);
    const before = sessions();
    for (const token of [OWNER_TOKEN, link, pasted]) {
      const res = await exchange(token);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ session: null });
    }
    expect(sessions()).toEqual(before);
  });

  it("refuses agent, registering and unknown tokens as /api does, starting none", async () => {
    const agent = addToken(db, "owner", false, true).token;
    const registers = addToken(db, "owner", false, true, undefined, undefined, true).token;
    for (const token of [agent, registers]) expect((await exchange(token)).status).toBe(403);
    expect((await exchange("not-a-token")).status).toBe(401);
    expect(sessions()).toEqual([]);
  });

  it("gives a session that acts as its token, read-only staying read-only, refused on /mcp and /wait", async () => {
    const viewer = await signIn(addToken(db, "owner", true).token);
    expect((await call("/api/agents", viewer)).status).toBe(200);
    expect((await call("/api/conversation?a=x&b=y", viewer, "DELETE")).status).toBe(403);
    expect((await call("/api/token", viewer)).status).toBe(200);
    expect(await (await call("/api/token", viewer)).json()).toEqual({ readOnly: true, agentOnly: false });
    const full = await signIn(addToken(db, "owner").token);
    expect((await call("/mcp", full, "POST", "{}")).status).toBe(403);
    expect((await call("/wait?agent=x", full)).status).toBe(403);
  });

  it("lists the session in its own account's Sign-ins, which can end it, and never in another account's", async () => {
    const admin = addToken(db, "owner", false, false, undefined, "maria");
    const viewer = addToken(db, "owner", true);
    const mine = await signIn(viewer.token);
    const theirs = addToken(db, "friend", false, false, undefined, "fay").token;
    const listed = (await (await call("/api/signins", admin.token)).json()) as SigninJson[];
    expect(listed).toEqual([{ id: sessionRow(mine)?.id, tokenId: viewer.id, kind: "read-only", createdAt: expect.any(String) }]);
    expect(await (await call("/api/signins", theirs)).json()).toEqual([]);
    expect((await call(`/api/signins?id=${sessionRow(mine)?.id}`, theirs, "DELETE")).status).toBe(404);
    expect((await call("/api/agents", mine)).status).toBe(200);
    expect((await call(`/api/signins?id=${sessionRow(mine)?.id}`, admin.token, "DELETE")).status).toBe(200);
    expect((await call("/api/agents", mine)).status).toBe(401);
    expect((await call("/api/agents", viewer.token)).status).toBe(200);
  });

  it("ends the session when its token is revoked or its person removed", async () => {
    const full = addToken(db, "owner");
    addPerson(db, "owner", "ben");
    const ben = addToken(db, "owner", false, false, undefined, "ben").token;
    const fullSession = await signIn(full.token);
    const benSession = await signIn(ben);
    revokeToken(db, full.id);
    removePerson(db, "owner", "ben");
    expect((await call("/api/agents", fullSession)).status).toBe(401);
    expect((await call("/api/agents", benSession)).status).toBe(401);
  });

  it(`refuses a token's next session with 429 once it has ${MAX_SESSIONS_PER_TOKEN}, leaving other tokens' sign-ins working`, async () => {
    const full = addToken(db, "owner");
    for (let i = 0; i < MAX_SESSIONS_PER_TOKEN; i++) signInWithToken(db, full.id);
    const before = sessions();
    const res = await exchange(full.token);
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain(String(MAX_SESSIONS_PER_TOKEN));
    expect(sessions()).toEqual(before);
    expect(() => signInWithToken(db, full.id)).toThrow(LoginError);
    await signIn(addToken(db, "owner").token);
    // Ending one makes room again.
    db.prepare("DELETE FROM dashboard_sessions WHERE id = (SELECT MIN(id) FROM dashboard_sessions)").run();
    await signIn(full.token);
  });

  it("starts none for a token revoked between the token check and the work", () => {
    const full = addToken(db, "owner");
    revokeToken(db, full.id);
    expect(signInWithToken(db, full.id)).toBeUndefined();
    expect(sessions()).toEqual([]);
  });

  it("answers 503 with Retry-After when the database is busy, starting none", async () => {
    const full = addToken(db, "owner").token;
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
      if (sql === COUNT_TOKEN_SESSIONS) throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
      return prepare(sql);
    }) as typeof db.prepare);
    const res = await exchange(full);
    vi.restoreAllMocks();
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("1");
    expect(sessions()).toEqual([]);
  });

  it("answers 405 with Allow: POST, DELETE for another method", async () => {
    const full = addToken(db, "owner").token;
    for (const method of ["GET", "PUT", "PATCH"]) {
      const res = await call("/api/session", full, method);
      expect(res.status, method).toBe(405);
      expect(res.headers.get("allow")).toBe("POST, DELETE");
    }
    expect(sessions()).toEqual([]);
  });

  it("counts a token's sessions through dashboard_sessions_by_token, without scanning", () => {
    const full = addToken(db, "owner");
    signInWithToken(db, full.id);
    const plan = db
      .prepare(`EXPLAIN QUERY PLAN ${COUNT_TOKEN_SESSIONS}`)
      .all(full.id)
      .map((r) => (r as { detail: string }).detail);
    expect(plan).toEqual(["SEARCH dashboard_sessions USING COVERING INDEX dashboard_sessions_by_token (token_id=?)"]);
  });
});

describe("DELETE /api/session", () => {
  const end = (token: string) => call("/api/session", token, "DELETE");

  it("ends the bearer's own session of a full, read-only, plain person or admin person token, and that one only", async () => {
    addPerson(db, "owner", "ben");
    const admin = addToken(db, "owner", false, false, undefined, "maria");
    const made = [addToken(db, "owner"), addToken(db, "owner", true), addToken(db, "owner", false, false, undefined, "ben"), admin];
    for (const t of made) {
      const session = await signIn(t.token);
      const other = await signIn(t.token);
      const id = sessionRow(session)?.id;
      const res = await end(session);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const text = await res.text();
      expect(text).not.toContain(session);
      expect(JSON.parse(text)).toEqual({ ended: true });
      expect(sessionRow(session)).toBeUndefined();
      for (const path of ["/api/token", "/api/agents", "/api/signins", "/api/session"]) {
        expect((await call(path, session)).status, path).toBe(401);
      }
      expect((await end(session)).status).toBe(401);
      expect((await call("/api/session", session, "POST")).status).toBe(401);
      // Its token, and the token's other browser, stay signed in.
      expect((await call("/api/agents", t.token)).status).toBe(200);
      expect((await call("/api/agents", other)).status).toBe(200);
      const listed = (await (await call("/api/signins", admin.token)).json()) as SigninJson[];
      expect(listed.map((s) => s.id)).not.toContain(id);
      expect(listed.map((s) => s.id)).toContain(sessionRow(other)?.id);
    }
    expect(db.prepare("SELECT COUNT(*) FROM tokens WHERE revoked_at IS NOT NULL").pluck().get()).toBe(0);
  });

  it("answers { ended: false }, changing nothing, for the owner token and a token carried itself", async () => {
    addPerson(db, "owner", "ben");
    const made = [addToken(db, "owner"), addToken(db, "owner", true), addToken(db, "owner", false, false, undefined, "ben"), addToken(db, "owner", false, false, undefined, "maria")];
    for (const t of made) await signIn(t.token);
    const before = sessions();
    const tokensBefore = db.prepare("SELECT * FROM tokens ORDER BY id").all();
    for (const token of [OWNER_TOKEN, ...made.map((t) => t.token)]) {
      const res = await end(token);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ended: false });
      expect((await call("/api/agents", token)).status).toBe(200);
    }
    expect(sessions()).toEqual(before);
    expect(db.prepare("SELECT * FROM tokens ORDER BY id").all()).toEqual(tokensBefore);
  });

  it("refuses agent, registering and unknown tokens as /api does, ending nothing", async () => {
    await signIn(addToken(db, "owner").token);
    const before = sessions();
    const agent = addToken(db, "owner", false, true).token;
    const registers = addToken(db, "owner", false, true, undefined, undefined, true).token;
    for (const token of [agent, registers]) expect((await end(token)).status).toBe(403);
    expect((await end("not-a-token")).status).toBe(401);
    expect(sessions()).toEqual(before);
  });

  it("ends a session of another account's token only in that account, never touching this one's", async () => {
    const mine = await signIn(addToken(db, "owner").token);
    const theirs = await signIn(addToken(db, "friend", false, false, undefined, "fay").token);
    expect(await (await end(theirs)).json()).toEqual({ ended: true });
    expect(sessionRow(theirs)).toBeUndefined();
    expect((await call("/api/agents", mine)).status).toBe(200);
  });

  it("makes room for the token's next session once it is at its limit", async () => {
    const full = addToken(db, "owner");
    for (let i = 0; i < MAX_SESSIONS_PER_TOKEN - 1; i++) signInWithToken(db, full.id);
    const last = await signIn(full.token);
    expect((await exchange(full.token)).status).toBe(429);
    expect((await end(last)).status).toBe(200);
    await signIn(full.token);
  });

  it("answers false for a session already gone, as when two DELETEs race", () => {
    const full = addToken(db, "owner");
    signInWithToken(db, full.id);
    const id = (sessions()[0] as { id: number }).id;
    expect(endOwnSignin(db, id)).toBe(true);
    expect(endOwnSignin(db, id)).toBe(false);
  });

  it("answers 503 with Retry-After when the database is busy, ending none", async () => {
    const session = await signIn(addToken(db, "owner").token);
    const before = sessions();
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
      if (sql === END_OWN_SIGNIN) throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
      return prepare(sql);
    }) as typeof db.prepare);
    const res = await end(session);
    vi.restoreAllMocks();
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("1");
    expect(sessions()).toEqual(before);
  });

  it("deletes the one session through the primary key, without scanning", () => {
    const full = addToken(db, "owner");
    signInWithToken(db, full.id);
    const id = (sessions()[0] as { id: number }).id;
    const prepare = db.prepare.bind(db);
    const prepared: string[] = [];
    vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
      prepared.push(sql);
      return prepare(sql);
    }) as typeof db.prepare);
    endOwnSignin(db, id);
    vi.restoreAllMocks();
    expect(prepared).toEqual([END_OWN_SIGNIN]);
    const plan = db
      .prepare(`EXPLAIN QUERY PLAN ${prepared[0]}`)
      .all(id)
      .map((r) => (r as { detail: string }).detail);
    expect(plan).toEqual(["SEARCH dashboard_sessions USING INTEGER PRIMARY KEY (rowid=?)"]);
  });
});
