import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addAccount, addToken, listAccounts } from "../src/accounts.js";
import { addPerson, setPersonAdmin } from "../src/agents.js";
import { OWNER_ACCOUNT, openDb, type AccountId, type Db } from "../src/db.js";
import { startHttp, type HttpServer } from "../src/http.js";
import { NotAdminError, listWebhooksBy, removeWebhookBy } from "../src/login.js";
import { sendMessage } from "../src/messages.js";
import { addWebhook, listWebhooks } from "../src/webhooks.js";

// An admin person's token lists its account's webhooks (GET /api/webhooks) and removes one (DELETE /api/webhooks?id=),
// on a server with the owner's account and a friend's.
const OWNER_TOKEN = "owner-token";
let db: Db;
let http: HttpServer;
let friend: AccountId;
let ana: string;

beforeEach(async () => {
  db = openDb(join(mkdtempSync(join(tmpdir(), "message-cp-webhooks-api-")), "db.sqlite"));
  addAccount(db, "friend");
  friend = listAccounts(db).find((a) => a.name === "friend")!.id;
  addPerson(db, "owner", "ana", true);
  ana = personToken("owner", "ana");
  http = await startHttp(db, { token: OWNER_TOKEN, port: 0, waitHoldMs: 0 });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await http.close();
  db.close();
});

const personToken = (account: string, name: string) => addToken(db, account, false, false, undefined, name).token;
const call = (path: string, token: string, method = "GET") =>
  fetch(`http://127.0.0.1:${http.port}${path}`, { method, headers: { Authorization: `Bearer ${token}` } });
const list = (query = "", token = ana) => call(`/api/webhooks${query}`, token);
const remove = (id: number | string, token = ana) => call(`/api/webhooks?id=${id}`, token, "DELETE");
const message = async (res: Response) => ((await res.json()) as { error: { message: string } }).error.message;
const rows = (sql: string, ...p: unknown[]) => db.prepare(sql).all(...p);
const snapshot = () => ({ webhooks: rows("SELECT * FROM webhooks ORDER BY id"), deliveries: rows("SELECT * FROM webhook_deliveries ORDER BY id") });
const idOf = (account: AccountId, name: string) =>
  db.prepare("SELECT id FROM agents WHERE account_id = ? AND name = ?").pluck().get(account, name) as number;
const both = [() => list(), () => remove(1)] as const;

/** The owner's three webhooks, the second with a header and a fixed body, and the friend's one. */
function hooks() {
  const first = addWebhook(db, "owner", "https://example.com/hook/secret-path", "#general", true);
  const second = addWebhook(db, "owner", "https://hooks.example.org:8443/p/tok", "mention:alice", true, "X-Key: header-value", 50, '{"text":"fixed-body {{delivery}}"}');
  const third = addWebhook(db, "owner", "http://127.0.0.1:9/x", "agent:bob", false);
  const theirs = addWebhook(db, "friend", "https://friend.example/theirs", "agent:fay", true);
  return { first, second, third, theirs };
}

describe("GET /api/webhooks", () => {
  it("lists the account's webhooks oldest first, with the URL's origin only and no secret, header value or body", async () => {
    const { first, second, third, theirs } = hooks();
    const res = await list();
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual([
      { id: first.id, on: "#general", origin: "https://example.com", includeText: true, headerName: null, maxPerHour: null, fixedBody: false },
      { id: second.id, on: "mention:alice", origin: "https://hooks.example.org:8443", includeText: true, headerName: "X-Key", maxPerHour: 50, fixedBody: true },
      { id: third.id, on: "agent:bob", origin: "http://127.0.0.1:9", includeText: false, headerName: null, maxPerHour: null, fixedBody: false },
    ]);
    for (const leak of [first.secret, second.secret, third.secret, theirs.secret, "secret-path", "/p/tok", "header-value", "fixed-body", "friend"]) {
      expect(text).not.toContain(leak);
    }
  });

  it("pages with limit and offset", async () => {
    const { first, second, third } = hooks();
    const ids = async (query: string) => ((await (await list(query)).json()) as { id: number }[]).map((w) => w.id);
    expect(await ids("?limit=2")).toEqual([first.id, second.id]);
    expect(await ids("?limit=2&offset=2")).toEqual([third.id]);
    expect(await ids("?offset=3")).toEqual([]);
    for (const query of ["?limit=0", "?limit=201", "?offset=-1", "?limit=1&limit=2", "?limit=x"]) {
      const res = await list(query);
      expect(res.status, query).toBe(400);
    }
  });

  it("answers an empty list for an account with no webhooks", async () => {
    addWebhook(db, "friend", "https://friend.example/theirs", "agent:fay", true);
    expect(await (await list()).json()).toEqual([]);
  });
});

describe("DELETE /api/webhooks", () => {
  it("removes the webhook with its deliveries and answers how many went", async () => {
    const { first, second } = hooks();
    for (const name of ["alice", "bob"]) addPerson(db, "owner", name);
    sendMessage(db, OWNER_ACCOUNT, "bob", "alice", "one");
    sendMessage(db, OWNER_ACCOUNT, "carol", "bob", "two");
    sendMessage(db, OWNER_ACCOUNT, "carol", "bob", "three");
    const third = listWebhooks(db, "owner")[2];
    expect(rows("SELECT * FROM webhook_deliveries WHERE webhook_id = ?", third.id)).toHaveLength(2);
    const others = rows("SELECT * FROM webhook_deliveries WHERE webhook_id <> ? ORDER BY id", third.id);

    const res = await remove(third.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: third.id, deliveries: 2 });
    expect(rows("SELECT * FROM webhook_deliveries WHERE webhook_id = ?", third.id)).toEqual([]);
    expect(rows("SELECT * FROM webhook_deliveries WHERE webhook_id <> ? ORDER BY id", third.id)).toEqual(others);
    expect(listWebhooks(db, "owner").map((w) => w.id)).toEqual([first.id, second.id]);
    // Gone, so a second delete finds nothing.
    expect((await remove(third.id)).status).toBe(404);
  });

  it("answers 404, changing nothing, for another account's webhook and for an unknown id", async () => {
    const { theirs } = hooks();
    const before = snapshot();
    for (const id of [theirs.id, 9999, 0]) {
      const res = await remove(id);
      expect(res.status, String(id)).toBe(404);
      expect(await message(res)).toBe("No such webhook");
    }
    expect(snapshot()).toEqual(before);
    expect(listWebhooks(db, "friend").map((w) => w.id)).toEqual([theirs.id]);
  });

  it("keeps a second account's admin out of the first account, with the same 404 as an unknown id", async () => {
    const { first } = hooks();
    addPerson(db, "friend", "fay", true);
    const fay = personToken("friend", "fay");
    const before = snapshot();
    expect((await remove(first.id, fay)).status).toBe(404);
    expect(((await (await list("", fay)).json()) as { id: number }[]).map((w) => w.id)).toEqual([listWebhooks(db, "friend")[0].id]);
    expect(snapshot()).toEqual(before);
  });

  it("answers 400 for a missing, repeated or not whole-number id", async () => {
    hooks();
    const before = snapshot();
    for (const query of ["", "?id=", "?id=1&id=2", "?id=x", "?id=-1", "?id=1.5", "?id=1e3", "?id=99999999999999999"]) {
      const res = await call(`/api/webhooks${query}`, ana, "DELETE");
      expect(res.status, query).toBe(400);
    }
    expect(snapshot()).toEqual(before);
  });
});

describe("/api/webhooks", () => {
  it("refuses a plain person, read-only, agent and full token with 403, closing the connection, and changes nothing", async () => {
    hooks();
    addPerson(db, "owner", "ben");
    const tokens = [
      [personToken("owner", "ben"), "A person token only reads, sends and posts"],
      [addToken(db, "owner", true).token, "This token is read-only"],
      [addToken(db, "owner", false, true).token, "Agent tokens cannot use the dashboard API"],
      [OWNER_TOKEN, /^A full token cannot list or remove webhooks over the API\. Run message-cp webhook list or webhook remove on the server/],
    ] as const;
    const before = snapshot();
    for (const [token, expected] of tokens) {
      for (const res of [await list("", token), await remove(1, token)]) {
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
    hooks();
    setPersonAdmin(db, "owner", "ana", false);
    for (const route of both) {
      const res = await route();
      expect(res.status).toBe(403);
      expect(await message(res)).toBe("A person token only reads, sends and posts");
    }
  });

  it("refuses with 403, changing nothing, an admin unmarked or removed between the token check and the work", async () => {
    hooks();
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
        expect(rows("SELECT admin, removed_at FROM agents WHERE name = 'ana'")).toEqual([{ admin: 1, removed_at: null }]);
      }
    }
  });

  it("refuses listWebhooksBy and removeWebhookBy for anyone who is not a live admin of the account", async () => {
    const { first } = hooks();
    addPerson(db, "owner", "ben");
    addPerson(db, "friend", "fay", true);
    const before = snapshot();
    for (const by of [idOf(OWNER_ACCOUNT, "ben"), idOf(friend, "fay"), 9999]) {
      expect(() => listWebhooksBy(db, OWNER_ACCOUNT, by, 10, 0)).toThrow(NotAdminError);
      expect(() => removeWebhookBy(db, OWNER_ACCOUNT, by, first.id)).toThrow(NotAdminError);
    }
    expect(snapshot()).toEqual(before);
  });

  it("answers 503 with Retry-After when the database is busy, changing nothing", async () => {
    hooks();
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
      const res = await call("/api/webhooks", ana, method);
      expect(res.status, method).toBe(405);
      expect(res.headers.get("allow")).toBe("GET, DELETE");
    }
  });
});

describe("the plans of listing and removing webhooks", () => {
  it("finds the account's webhooks and a webhook's deliveries by index, and cascades through webhook_deliveries_by_webhook, never scanning", () => {
    const prepare = db.prepare.bind(db);
    const sql: string[] = [];
    const spy = vi.spyOn(db, "prepare").mockImplementation(((s: string) => {
      sql.push(s);
      return prepare(s);
    }) as typeof db.prepare);
    const { first } = hooks();
    sql.length = 0;
    const by = idOf(OWNER_ACCOUNT, "ana");
    listWebhooksBy(db, OWNER_ACCOUNT, by, 10, 0);
    removeWebhookBy(db, OWNER_ACCOUNT, by, first.id);
    spy.mockRestore();
    const plans = [...new Set(sql)].map((s) =>
      (db.prepare(`EXPLAIN QUERY PLAN ${s}`).all(...Array.from(s.matchAll(/\?/g), () => null)) as { detail: string }[]).map((r) => r.detail),
    );
    for (const plan of plans) expect(plan.filter((d) => d.startsWith("SCAN"))).toEqual([]);
    const at = (start: string) => plans.find((p) => p[0].startsWith(start))!;
    expect(at("SEARCH webhooks USING INDEX webhooks_by_name")).toEqual(["SEARCH webhooks USING INDEX webhooks_by_name (account_id=?)", "USE TEMP B-TREE FOR ORDER BY"]);
    const searches = plans.filter((p) => p.includes("SEARCH webhook_deliveries USING COVERING INDEX webhook_deliveries_by_webhook (webhook_id=?)"));
    // The count, and the delete, whose ON DELETE CASCADE finds the webhook's deliveries through the same index.
    expect(searches).toEqual([
      ["SEARCH webhook_deliveries USING COVERING INDEX webhook_deliveries_by_webhook (webhook_id=?)"],
      ["SEARCH webhooks USING INTEGER PRIMARY KEY (rowid=?)", "SEARCH webhook_deliveries USING COVERING INDEX webhook_deliveries_by_webhook (webhook_id=?)"],
    ]);
  });
});
