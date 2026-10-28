import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addAccount, addToken, revokeToken } from "../src/accounts.js";
import { addPerson, removePerson, setPersonAdmin } from "../src/agents.js";
import { OWNER_ACCOUNT, openDb, type Db } from "../src/db.js";
import { startHttp, type HttpServer } from "../src/http.js";
import { NotAdminError, endSigninBy, listSigninsBy, makeLoginCode, redeemLoginCode } from "../src/login.js";

// An admin person's token, or a sign-in of one, lists its account's dashboard sign-ins (GET /api/signins) and ends one
// (DELETE /api/signins?id=), on a server with the owner's account and a friend's. Sign-ins are made by redeeming real
// login codes, as a browser does.
const OWNER_TOKEN = "owner-token";
let file: string;
let db: Db;
let http: HttpServer;

beforeEach(async () => {
  file = join(mkdtempSync(join(tmpdir(), "message-cp-signins-api-")), "db.sqlite");
  db = openDb(file);
  addAccount(db, "friend");
  addPerson(db, "owner", "maria", true);
  http = await startHttp(db, { token: OWNER_TOKEN, port: 0, waitHoldMs: 0 });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await http.close();
  db.close();
});

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const call = (path: string, token: string, method = "GET") =>
  fetch(`http://127.0.0.1:${http.port}${path}`, { method, headers: { Authorization: `Bearer ${token}` } });
const list = (token: string, query = "") => call(`/api/signins${query}`, token);
const end = (token: string, id: number | string) => call(`/api/signins?id=${id}`, token, "DELETE");
const message = async (res: Response) => ((await res.json()) as { error: { message: string } }).error.message;
const snapshot = () => db.prepare("SELECT * FROM dashboard_sessions ORDER BY id").all();

/** A browser signed in with a login link for `person` of `account`, or for its owner with none: the session and its rows. */
function signIn(account = "owner", person?: string) {
  const session = redeemLoginCode(db, makeLoginCode(db, account, person).code);
  const row = db.prepare("SELECT id, token_id FROM dashboard_sessions WHERE hash = ?").get(sha256(session)) as { id: number; token_id: number };
  return { session, id: row.id, tokenId: row.token_id };
}

interface SigninJson {
  id: number;
  tokenId: number;
  kind: string;
  person?: string;
  createdAt: string;
  current?: true;
}

describe("GET /api/signins", () => {
  it("lists the account's live sign-ins oldest first, current only on the request's own, and never a session, token or hash", async () => {
    const first = signIn("owner", "maria");
    const full = signIn("owner");
    const second = signIn("owner", "maria");
    addPerson(db, "friend", "fay", true);
    const theirs = signIn("friend", "fay");
    signIn("friend");
    const res = await list(second.session);
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as SigninJson[];
    expect(body.map((s) => s.id)).toEqual([first.id, full.id, second.id]);
    expect(body[0]).toEqual({ id: first.id, tokenId: first.tokenId, kind: "person", person: "maria", createdAt: expect.any(String) });
    expect(body[1]).toEqual({ id: full.id, tokenId: full.tokenId, kind: "full", createdAt: expect.any(String) });
    expect(body[2]).toEqual({ id: second.id, tokenId: second.tokenId, kind: "person", person: "maria", createdAt: expect.any(String), current: true });
    expect(new Date(body[0].createdAt).toISOString()).toBe(body[0].createdAt);
    const hashes = db.prepare("SELECT hash FROM dashboard_sessions").pluck().all() as string[];
    for (const secret of [first.session, full.session, second.session, theirs.session, ...hashes]) expect(text).not.toContain(secret);
    for (const hash of db.prepare("SELECT hash FROM tokens").pluck().all() as string[]) expect(text).not.toContain(hash);
  });

  it("marks none current for the admin's pasted token", async () => {
    const signed = signIn("owner", "maria");
    const pasted = addToken(db, "owner", false, false, undefined, "maria").token;
    const body = (await (await list(pasted)).json()) as SigninJson[];
    expect(body.map((s) => s.id)).toEqual([signed.id]);
    expect(body[0].current).toBeUndefined();
  });

  it("leaves out a sign-in of a revoked token or of a removed person, as accountForToken refuses them", async () => {
    const admin = signIn("owner", "maria");
    addPerson(db, "owner", "ben");
    const ben = signIn("owner", "ben");
    const revoked = signIn("owner");
    const kept = signIn("owner");
    revokeToken(db, revoked.tokenId);
    removePerson(db, "owner", "ben");
    expect((await list(ben.session)).status).toBe(401);
    expect((await list(revoked.session)).status).toBe(401);
    const body = (await (await list(admin.session)).json()) as SigninJson[];
    expect(body.map((s) => s.id)).toEqual([admin.id, kept.id]);
  });

  it("pages with limit and offset", async () => {
    const made = [signIn("owner", "maria"), signIn("owner"), signIn("owner"), signIn("owner")];
    const ids = async (query: string) => ((await (await list(made[0].session, query)).json()) as SigninJson[]).map((s) => s.id);
    expect(await ids("?limit=2")).toEqual([made[0].id, made[1].id]);
    expect(await ids("?limit=2&offset=2")).toEqual([made[2].id, made[3].id]);
    expect(await ids("?offset=4")).toEqual([]);
  });

  it("answers 400 for a bad limit or offset", async () => {
    const admin = signIn("owner", "maria");
    for (const query of ["?limit=0", "?limit=201", "?offset=-1", "?limit=2&limit=3", "?limit=x"]) {
      expect((await list(admin.session, query)).status, query).toBe(400);
    }
  });

  it("lists only the second account's sign-ins to that account's admin", async () => {
    signIn("owner", "maria");
    addPerson(db, "friend", "fay", true);
    const fay = signIn("friend", "fay");
    const full = signIn("friend");
    const body = (await (await list(fay.session)).json()) as SigninJson[];
    expect(body.map((s) => s.id)).toEqual([fay.id, full.id]);
  });
});

describe("DELETE /api/signins", () => {
  it("ends that sign-in, whose next request gets 401, leaving its token unrevoked and every other sign-in and token working", async () => {
    const admin = signIn("owner", "maria");
    const other = signIn("owner");
    // redeemLoginCode makes one token per sign-in, so a second sign-in of the same token is made by hand.
    const sameToken = db.prepare("INSERT INTO dashboard_sessions (hash, token_id, created_at) VALUES (?, ?, ?) RETURNING id");
    const twin = "a".repeat(64);
    const twinId = sameToken.pluck().get(sha256(twin), other.tokenId, Date.now()) as number;
    const unrelated = addToken(db, "owner").token;
    const res = await end(admin.session, other.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: other.id });
    expect((await call("/api/token", other.session)).status).toBe(401);
    expect((await call("/api/token", twin)).status).toBe(200);
    expect((await call("/api/token", unrelated)).status).toBe(200);
    expect((await call("/api/token", admin.session)).status).toBe(200);
    const left = (await (await list(admin.session)).json()) as SigninJson[];
    expect(left.map((s) => s.id)).toEqual([admin.id, twinId]);
    expect(db.prepare("SELECT revoked_at FROM tokens WHERE id = ?").pluck().get(other.tokenId)).toBeNull();
  });

  it("ends the request's own sign-in, which gets 401 next", async () => {
    const admin = signIn("owner", "maria");
    const res = await end(admin.session, admin.id);
    expect(res.status).toBe(200);
    expect((await list(admin.session)).status).toBe(401);
  });

  it("never gives an ended sign-in's id to a later sign-in, so ending it again answers 404 and signs nobody out", async () => {
    const admin = signIn("owner", "maria");
    const highest = signIn("owner");
    expect((await end(admin.session, highest.id)).status).toBe(200);
    const later = signIn("owner");
    expect(later.id).toBeGreaterThan(highest.id);
    expect((await end(admin.session, highest.id)).status).toBe(404);
    expect((await call("/api/token", later.session)).status).toBe(200);
  });

  it("rebuilds a dashboard_sessions table from before AUTOINCREMENT, keeping every sign-in, its id and its index", () => {
    const file = join(mkdtempSync(join(tmpdir(), "message-cp-signins-old-")), "db.sqlite");
    openDb(file).close();
    const raw = new Database(file);
    raw.exec(`
      DROP TABLE dashboard_sessions;
      CREATE TABLE dashboard_sessions (
        id INTEGER PRIMARY KEY,
        hash TEXT NOT NULL UNIQUE,
        token_id INTEGER NOT NULL REFERENCES tokens(id),
        created_at INTEGER NOT NULL
      );
      CREATE INDEX dashboard_sessions_by_token ON dashboard_sessions (token_id);
      INSERT INTO tokens (id, hash, account_id, created_at) VALUES (7, 'h', 1, 1);
      INSERT INTO dashboard_sessions (id, hash, token_id, created_at) VALUES (3, 'a', 7, 10), (5, 'b', 7, 20);
    `);
    raw.close();
    const reopened = openDb(file);
    openDb(file).close(); // a second open is harmless
    expect(reopened.prepare("SELECT sql FROM sqlite_master WHERE name = 'dashboard_sessions'").pluck().get()).toMatch(/id INTEGER PRIMARY KEY AUTOINCREMENT/);
    expect(reopened.prepare("SELECT id, hash, token_id, created_at FROM dashboard_sessions ORDER BY id").all()).toEqual([
      { id: 3, hash: "a", token_id: 7, created_at: 10 },
      { id: 5, hash: "b", token_id: 7, created_at: 20 },
    ]);
    expect(
      reopened.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'dashboard_sessions' AND sql IS NOT NULL").pluck().all(),
    ).toEqual(["dashboard_sessions_by_token"]);
    // Ending the highest sign-in leaves its id taken: the next one gets 6.
    reopened.prepare("DELETE FROM dashboard_sessions WHERE id = 5").run();
    const session = redeemLoginCode(reopened, makeLoginCode(reopened, "owner").code);
    expect(reopened.prepare("SELECT id FROM dashboard_sessions WHERE hash = ?").pluck().get(sha256(session))).toBe(6);
    reopened.close();
  });

  it("answers 404, changing nothing, for another account's sign-in, one of a revoked token or removed person, and an unknown id", async () => {
    const admin = signIn("owner", "maria");
    addPerson(db, "friend", "fay", true);
    const theirs = signIn("friend", "fay");
    const theirFull = signIn("friend");
    const revoked = signIn("owner");
    revokeToken(db, revoked.tokenId);
    addPerson(db, "owner", "ben");
    const ben = signIn("owner", "ben");
    removePerson(db, "owner", "ben");
    const before = snapshot();
    for (const id of [theirs.id, theirFull.id, revoked.id, ben.id, 9999]) {
      const res = await end(admin.session, id);
      expect(res.status, String(id)).toBe(404);
      expect(await message(res)).toBe("No such sign-in");
    }
    expect(snapshot()).toEqual(before);
    expect((await call("/api/token", theirs.session)).status).toBe(200);
  });

  it("answers 400 for a missing, repeated or not whole-number id", async () => {
    const admin = signIn("owner", "maria");
    const before = snapshot();
    for (const [query, expected] of [
      ["", "Give id once"],
      ["?id=1&id=1", "Give id once"],
      ["?id=x", "Give id as a whole number"],
      ["?id=1.5", "Give id as a whole number"],
      ["?id=-1", "Give id as a whole number"],
      ["?id=99999999999999999", "Give id as a whole number"],
    ]) {
      const res = await call(`/api/signins${query}`, admin.session, "DELETE");
      expect(res.status, query).toBe(400);
      expect(await message(res)).toBe(expected);
    }
    expect(snapshot()).toEqual(before);
  });
});

describe("/api/signins", () => {
  it("refuses a plain person, read-only, agent and full token, and a full token's sign-in, with 403, closing the connection, and changes nothing", async () => {
    const admin = signIn("owner", "maria");
    addPerson(db, "owner", "ben");
    const fullSignin = signIn("owner");
    const refused = [
      [signIn("owner", "ben").session, "A person token only reads, sends and posts"],
      [addToken(db, "owner", false, false, undefined, "ben").token, "A person token only reads, sends and posts"],
      [addToken(db, "owner", true).token, "This token is read-only"],
      [addToken(db, "owner", false, true).token, "Agent tokens cannot use the dashboard API"],
      [addToken(db, "owner").token, /^A full token cannot list or end dashboard sign-ins over the API\. Sign in as an admin person: .*message-cp token revoke <id> on the server to end every sign-in of a token$/],
      [fullSignin.session, /^A full token cannot list or end dashboard sign-ins over the API\./],
      [OWNER_TOKEN, /^A full token cannot list or end dashboard sign-ins over the API\./],
    ] as const;
    const before = snapshot();
    for (const [token, expected] of refused) {
      for (const res of [await list(token), await end(token, admin.id)]) {
        expect(res.status).toBe(403);
        expect(res.headers.get("connection")).toBe("close");
        const text = await message(res);
        if (typeof expected === "string") expect(text).toBe(expected);
        else expect(text).toMatch(expected);
      }
    }
    expect((await list("wrong")).status).toBe(401);
    expect(snapshot()).toEqual(before);
  });

  it("refuses an admin's sign-in with 403 once they are marked not admin", async () => {
    const admin = signIn("owner", "maria");
    setPersonAdmin(db, "owner", "maria", false);
    for (const res of [await list(admin.session), await end(admin.session, admin.id)]) {
      expect(res.status).toBe(403);
      expect(await message(res)).toBe("A person token only reads, sends and posts");
    }
  });

  it("refuses with 403, changing nothing, an admin unmarked or removed between the token check and the work", async () => {
    const admin = signIn("owner", "maria");
    const other = signIn("owner");
    const before = snapshot();
    for (const change of ["UPDATE agents SET admin = 0 WHERE name = 'maria'", "UPDATE agents SET removed_at = 1 WHERE name = 'maria'"]) {
      for (const route of [() => list(admin.session), () => end(admin.session, other.id)]) {
        const prepare = db.prepare.bind(db);
        // Just before the admin's row is checked inside the transaction, as another process would between the two.
        const spy = vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
          if (sql.includes("person = 1 AND admin = 1")) prepare(change).run();
          return prepare(sql);
        }) as typeof db.prepare);
        const res = await route();
        spy.mockRestore();
        expect(res.status).toBe(403);
        expect(await message(res)).toBe("This person is no longer an admin of the account");
        // The transaction rolled back, the change above with it.
        expect(snapshot()).toEqual(before);
        expect(db.prepare("SELECT admin, removed_at FROM agents WHERE name = 'maria'").all()).toEqual([{ admin: 1, removed_at: null }]);
      }
    }
  });

  it("refuses listSigninsBy and endSigninBy for anyone who is not a live admin of the account", () => {
    const admin = signIn("owner", "maria");
    addPerson(db, "owner", "ben");
    addPerson(db, "friend", "fay", true);
    const idOf = (name: string) => db.prepare("SELECT id FROM agents WHERE name = ?").pluck().get(name) as number;
    const before = snapshot();
    for (const by of [idOf("ben"), idOf("fay"), 9999]) {
      expect(() => listSigninsBy(db, OWNER_ACCOUNT, by, undefined, 10, 0)).toThrow(NotAdminError);
      expect(() => endSigninBy(db, OWNER_ACCOUNT, by, admin.id)).toThrow(NotAdminError);
    }
    expect(snapshot()).toEqual(before);
  });

  it("answers 503 with Retry-After when the database is busy, changing nothing", async () => {
    const admin = signIn("owner", "maria");
    const other = signIn("owner");
    const before = snapshot();
    for (const route of [() => list(admin.session), () => end(admin.session, other.id)]) {
      const prepare = db.prepare.bind(db);
      const spy = vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
        if (sql.includes("person = 1 AND admin = 1")) throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
        return prepare(sql);
      }) as typeof db.prepare);
      const res = await route();
      spy.mockRestore();
      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe("1");
    }
    expect(snapshot()).toEqual(before);
  });

  it("answers 405 with Allow: GET, DELETE for another method", async () => {
    const admin = signIn("owner", "maria");
    for (const method of ["POST", "PUT", "PATCH"]) {
      const res = await call("/api/signins", admin.session, method);
      expect(res.status, method).toBe(405);
      expect(res.headers.get("allow")).toBe("GET, DELETE");
    }
  });

  it("finds the account's live tokens and their sign-ins by index, and the sign-in to end by primary key, without scanning", () => {
    const admin = signIn("owner", "maria");
    const by = db.prepare("SELECT id FROM agents WHERE name = 'maria'").pluck().get() as number;
    // The statements listSigninsBy and endSigninBy run, explained against this database made by openDb.
    const seen: string[] = [];
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
      if (sql.includes("dashboard_sessions")) seen.push(sql);
      return prepare(sql);
    }) as typeof db.prepare);
    listSigninsBy(db, OWNER_ACCOUNT, by, undefined, 10, 0);
    endSigninBy(db, OWNER_ACCOUNT, by, admin.id + 1);
    vi.restoreAllMocks();
    expect(seen).toHaveLength(2);
    const plan = (sql: string, ...args: unknown[]) =>
      db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map((r) => (r as { detail: string }).detail);
    // The sort covers only the account's live sign-ins, which are account-sized.
    expect(plan(seen[0], OWNER_ACCOUNT, 10, 0)).toEqual([
      "SEARCH tokens USING INDEX tokens_live_by_account (account_id=?)",
      "SEARCH dashboard_sessions USING INDEX dashboard_sessions_by_token (token_id=?)",
      "SEARCH people USING INTEGER PRIMARY KEY (rowid=?) LEFT-JOIN",
      "USE TEMP B-TREE FOR ORDER BY",
    ]);
    expect(plan(seen[1], admin.id, OWNER_ACCOUNT)).toEqual([
      "SEARCH dashboard_sessions USING INTEGER PRIMARY KEY (rowid=?)",
      "CORRELATED SCALAR SUBQUERY 1",
      "SEARCH tokens USING INTEGER PRIMARY KEY (rowid=?)",
      "SEARCH people USING INTEGER PRIMARY KEY (rowid=?) LEFT-JOIN",
    ]);
  });
});
