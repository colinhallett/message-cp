import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addAccount, addToken, listAccounts, listTokens, recordClient, revokeToken } from "../src/accounts.js";
import { addPerson, purgeAgent, registerAgent, removePerson, setPersonAdmin } from "../src/agents.js";
import { OWNER_ACCOUNT, openDb, type AccountId, type Db } from "../src/db.js";
import { startHttp, type HttpServer } from "../src/http.js";
import { NotAdminError, listTokensBy, revokeTokenBy } from "../src/login.js";

// An admin person's token lists its account's tokens (GET /api/tokens) and revokes one (DELETE /api/tokens?id=), on a
// server with the owner's account and a friend's.
const OWNER_TOKEN = "owner-token";
let db: Db;
let http: HttpServer;
let friend: AccountId;
let friendFull: { id: number; token: string };
let ana: string;
let anaId: number;

beforeEach(async () => {
  db = openDb(join(mkdtempSync(join(tmpdir(), "message-cp-tokens-api-")), "db.sqlite"));
  friendFull = addAccount(db, "friend");
  friend = listAccounts(db).find((a) => a.name === "friend")!.id;
  addPerson(db, "owner", "ana", true);
  const made = addToken(db, "owner", false, false, undefined, "ana");
  ana = made.token;
  anaId = made.id;
  http = await startHttp(db, { token: OWNER_TOKEN, port: 0, waitHoldMs: 0 });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await http.close();
  db.close();
});

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const call = (path: string, token: string, method = "GET") =>
  fetch(`http://127.0.0.1:${http.port}${path}`, { method, headers: { Authorization: `Bearer ${token}` } });
const list = (query = "", token = ana) => call(`/api/tokens${query}`, token);
const revoke = (id: number | string, token = ana) => call(`/api/tokens?id=${id}`, token, "DELETE");
const message = async (res: Response) => ((await res.json()) as { error: { message: string } }).error.message;
const snapshot = () => db.prepare("SELECT * FROM tokens ORDER BY id").all();
const idOf = (account: AccountId, name: string) =>
  db.prepare("SELECT id FROM agents WHERE account_id = ? AND name = ?").pluck().get(account, name) as number;
const both = [() => list(), () => revoke(anaId)] as const;

/** One token of each kind in the owner's account, after ana's, and a full and a person token in the friend's, after `addAccount`'s. */
function tokens() {
  const full = addToken(db, "owner");
  const readOnly = addToken(db, "owner", true);
  const agentOnly = addToken(db, "owner", false, true);
  registerAgent(db, OWNER_ACCOUNT, "bob");
  const bound = addToken(db, "owner", false, true, idOf(OWNER_ACCOUNT, "bob"));
  const registering = addToken(db, "owner", false, true, undefined, undefined, true);
  recordClient(db, registering.id, { name: "Claude", host: "claude.ai" });
  addPerson(db, "friend", "fay", true);
  const theirs = addToken(db, "friend");
  const theirPerson = addToken(db, "friend", false, false, undefined, "fay");
  return { full, readOnly, agentOnly, bound, registering, theirs, theirPerson };
}

interface TokenJson {
  id: number;
  kind: string;
  createdAt: string;
}

describe("GET /api/tokens", () => {
  it("lists the account's unrevoked tokens oldest first, with each kind and who it is for, and never a token or hash", async () => {
    const made = tokens();
    const revoked = addToken(db, "owner", true);
    revokeToken(db, revoked.id);
    const res = await list();
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as TokenJson[];
    for (const t of body) expect(t.createdAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(body.map(({ createdAt, ...rest }) => rest)).toEqual([
      { id: anaId, kind: "person", person: "ana" },
      { id: made.full.id, kind: "full" },
      { id: made.readOnly.id, kind: "read-only" },
      { id: made.agentOnly.id, kind: "agent" },
      { id: made.bound.id, kind: "agent", agent: "bob" },
      { id: made.registering.id, kind: "agent", registers: true, client: { name: "Claude", host: "claude.ai" } },
    ]);
    // The kinds agree with `token list`.
    const cli = new Map(listTokens(db).map((t) => [t.id, t.kind]));
    for (const t of body) expect(t.kind).toBe(cli.get(t.id));
    const all = [ana, made.full, made.readOnly, made.agentOnly, made.bound, made.registering, made.theirs, made.theirPerson, friendFull, revoked].map((t) =>
      typeof t === "string" ? t : t.token,
    );
    for (const leak of [...all, ...all.map(hashToken), OWNER_TOKEN, hashToken(OWNER_TOKEN), "fay", "friend"]) {
      expect(text).not.toContain(leak);
    }
  });

  it("lists a bound token whose agent or person was removed with a null name", async () => {
    tokens();
    addPerson(db, "owner", "ben");
    const ben = addToken(db, "owner", false, false, undefined, "ben");
    purgeAgent(db, "owner", "bob");
    removePerson(db, "owner", "ben");
    const body = (await (await list()).json()) as (TokenJson & { agent?: string | null; person?: string | null })[];
    expect(body.find((t) => t.agent !== undefined)).toMatchObject({ kind: "agent", agent: null });
    expect(body.find((t) => t.id === ben.id)).toMatchObject({ kind: "person", person: null });
  });

  it("pages with limit and offset", async () => {
    const made = tokens();
    const ids = async (query: string) => ((await (await list(query)).json()) as TokenJson[]).map((t) => t.id);
    expect(await ids("?limit=2")).toEqual([anaId, made.full.id]);
    expect(await ids("?limit=2&offset=4")).toEqual([made.bound.id, made.registering.id]);
    expect(await ids("?offset=6")).toEqual([]);
    for (const query of ["?limit=0", "?limit=201", "?offset=-1", "?limit=1&limit=2", "?limit=x"]) {
      expect((await list(query)).status, query).toBe(400);
    }
  });

  it("lists only the second account's tokens to that account's admin", async () => {
    const made = tokens();
    const fay = made.theirPerson.token;
    const body = (await (await list("", fay)).json()) as TokenJson[];
    expect(body.map((t) => t.id)).toEqual([friendFull.id, made.theirs.id, made.theirPerson.id]);
  });
});

describe("DELETE /api/tokens", () => {
  it("revokes a token, which gets 401 from its next request, and changes no other", async () => {
    const made = tokens();
    expect((await call("/api/agents", made.readOnly.token)).status).toBe(200);
    const others = db.prepare("SELECT * FROM tokens WHERE id <> ? ORDER BY id").all(made.readOnly.id);
    const res = await revoke(made.readOnly.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: made.readOnly.id });
    expect((await call("/api/agents", made.readOnly.token)).status).toBe(401);
    expect(db.prepare("SELECT * FROM tokens WHERE id <> ? ORDER BY id").all(made.readOnly.id)).toEqual(others);
    expect(listTokens(db).map((t) => t.id)).not.toContain(made.readOnly.id);
    // Gone, so a second revoke finds nothing.
    expect((await revoke(made.readOnly.id)).status).toBe(404);
  });

  it("revokes the token the request carries, which gets 401 next, keeping its person", async () => {
    const res = await revoke(anaId);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: anaId });
    expect((await list()).status).toBe(401);
    expect(db.prepare("SELECT admin, removed_at FROM agents WHERE name = 'ana'").all()).toEqual([{ admin: 1, removed_at: null }]);
  });

  it("answers 404, changing nothing, for another account's token, one already revoked and an unknown id", async () => {
    const made = tokens();
    const revoked = addToken(db, "owner", true);
    revokeToken(db, revoked.id);
    const before = snapshot();
    for (const id of [friendFull.id, made.theirs.id, made.theirPerson.id, revoked.id, 9999, 0]) {
      const res = await revoke(id);
      expect(res.status, String(id)).toBe(404);
      expect(await message(res)).toBe("No such token");
    }
    expect(snapshot()).toEqual(before);
    expect((await call("/api/agents", made.theirs.token)).status).toBe(200);
  });

  it("answers 400 for a missing, repeated or not whole-number id", async () => {
    tokens();
    const before = snapshot();
    for (const query of ["", "?id=", "?id=1&id=2", "?id=x", "?id=-1", "?id=1.5", "?id=1e3", "?id=99999999999999999"]) {
      const res = await call(`/api/tokens${query}`, ana, "DELETE");
      expect(res.status, query).toBe(400);
    }
    expect(snapshot()).toEqual(before);
  });
});

describe("/api/tokens", () => {
  it("refuses a plain person, read-only, agent and full token with 403, closing the connection, and changes nothing", async () => {
    const made = tokens();
    addPerson(db, "owner", "ben");
    const refused = [
      [addToken(db, "owner", false, false, undefined, "ben").token, "A person token only reads, sends and posts"],
      [made.readOnly.token, "This token is read-only"],
      [made.agentOnly.token, "Agent tokens cannot use the dashboard API"],
      [made.full.token, /^A full token cannot list or revoke tokens over the API\. Run message-cp token list or token revoke <id> on the server/],
      [OWNER_TOKEN, /^A full token cannot list or revoke tokens over the API\./],
    ] as const;
    const before = snapshot();
    for (const [token, expected] of refused) {
      for (const res of [await list("", token), await revoke(made.full.id, token)]) {
        expect(res.status).toBe(403);
        expect(res.headers.get("connection")).toBe("close");
        const text = await message(res);
        if (typeof expected === "string") expect(text).toBe(expected);
        else expect(text).toMatch(expected);
      }
    }
    expect((await list("", "wrong")).status).toBe(401);
    expect(snapshot()).toEqual(before);
  });

  it("refuses an admin's token with 403 once they are marked not admin", async () => {
    setPersonAdmin(db, "owner", "ana", false);
    for (const route of both) {
      const res = await route();
      expect(res.status).toBe(403);
      expect(await message(res)).toBe("A person token only reads, sends and posts");
    }
  });

  it("refuses with 403, changing nothing, an admin unmarked or removed between the token check and the work", async () => {
    tokens();
    const before = snapshot();
    for (const change of ["UPDATE agents SET admin = 0 WHERE name = 'ana'", "UPDATE agents SET removed_at = 1 WHERE name = 'ana'"]) {
      for (const route of both) {
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
        expect(db.prepare("SELECT admin, removed_at FROM agents WHERE name = 'ana'").all()).toEqual([{ admin: 1, removed_at: null }]);
      }
    }
  });

  it("refuses listTokensBy and revokeTokenBy for anyone who is not a live admin of the account", () => {
    const made = tokens();
    addPerson(db, "owner", "ben");
    const before = snapshot();
    for (const by of [idOf(OWNER_ACCOUNT, "ben"), idOf(friend, "fay"), 9999]) {
      expect(() => listTokensBy(db, OWNER_ACCOUNT, by, 10, 0)).toThrow(NotAdminError);
      expect(() => revokeTokenBy(db, OWNER_ACCOUNT, by, made.full.id)).toThrow(NotAdminError);
    }
    expect(snapshot()).toEqual(before);
  });

  it("answers 503 with Retry-After when the database is busy, changing nothing", async () => {
    tokens();
    const before = snapshot();
    for (const route of both) {
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
    for (const method of ["POST", "PUT", "PATCH"]) {
      const res = await call("/api/tokens", ana, method);
      expect(res.status, method).toBe(405);
      expect(res.headers.get("allow")).toBe("GET, DELETE");
    }
  });
});
