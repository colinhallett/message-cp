import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addAccount, addToken, listAccounts } from "../src/accounts.js";
import { addPerson, setPersonAdmin } from "../src/agents.js";
import { OWNER_ACCOUNT, openDb, type AccountId, type Db } from "../src/db.js";
import { startHttp, type HttpServer } from "../src/http.js";
import { NotAdminError, addWebhookBy, listWebhooksBy, removeWebhookBy } from "../src/login.js";
import { sendMessage } from "../src/messages.js";
import { WebhookError, addWebhook, listWebhooks, sendPending } from "../src/webhooks.js";

// An admin person's token lists its account's webhooks (GET /api/webhooks), adds one (POST /api/webhooks) and removes
// one (DELETE /api/webhooks?id=), on a server with the owner's account and a friend's.
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
const add = (body: unknown, token = ana) =>
  fetch(`http://127.0.0.1:${http.port}/api/webhooks`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const routes = [() => list(), () => remove(1), () => add({ url: "https://example.com/new", on: "#general" })] as const;

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

describe("POST /api/webhooks", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  });
  /** A local listener that records each request it gets and answers 200. */
  const receiver = async () => {
    const got: { headers: IncomingHttpHeaders; body: string }[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        got.push({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
        res.end();
      });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return { got, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook/secret-path` };
  };

  it("adds a webhook with only url and on, answering it with its secret, never cached", async () => {
    const res = await add({ url: "https://example.com/hook/secret-path", on: "#general" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const [made] = listWebhooks(db, "owner");
    const secret = db.prepare("SELECT secret FROM webhooks WHERE id = ?").pluck().get(made.id) as string;
    expect(await res.json()).toEqual({
      id: made.id,
      on: "#general",
      origin: "https://example.com",
      includeText: true,
      headerName: null,
      maxPerHour: null,
      fixedBody: false,
      secret,
    });
    expect(made).toMatchObject({ account: "owner", url: "https://example.com/hook/secret-path", event: "channel", name: "general", includeText: true });
  });

  it("adds a webhook with each optional field, answering the header's name but never its value or the body", async () => {
    const res = await add({
      url: "https://hooks.example.org:8443/p/tok",
      on: "mention:alice",
      includeText: true,
      header: "X-Key: header-value",
      maxPerHour: 50,
      body: '{"text":"fixed-body {{delivery}}"}',
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    const answer = JSON.parse(text) as { id: number; secret: string };
    expect(answer).toEqual({
      id: answer.id,
      on: "mention:alice",
      origin: "https://hooks.example.org:8443",
      includeText: true,
      headerName: "X-Key",
      maxPerHour: 50,
      fixedBody: true,
      secret: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    for (const leak of ["header-value", "fixed-body", "/p/tok"]) expect(text).not.toContain(leak);
    expect(rows("SELECT header_name, header_value, max_per_hour, fixed_body FROM webhooks WHERE id = ?", answer.id)).toEqual([
      { header_name: "X-Key", header_value: "header-value", max_per_hour: 50, fixed_body: '{"text":"fixed-body {{delivery}}"}' },
    ]);
    // includeText false, without a body.
    const quiet = await add({ url: "https://example.com/q", on: "agent:bob", includeText: false });
    expect(await quiet.json()).toMatchObject({ on: "agent:bob", includeText: false, fixedBody: false });
  });

  it("lists the new webhook and fires it as one webhook add made", async () => {
    const r = await receiver();
    for (const name of ["alice", "bob"]) addPerson(db, "owner", name);
    const res = await add({ url: r.url, on: "agent:bob", header: "X-Key: header-value" });
    const made = (await res.json()) as { id: number; secret: string };
    expect(((await (await list()).json()) as { id: number }[]).map((w) => w.id)).toEqual([made.id]);
    expect(listWebhooks(db, "owner").map((w) => w.id)).toEqual([made.id]);
    sendMessage(db, OWNER_ACCOUNT, "alice", "bob", "hello bob");
    expect(await sendPending(db)).toEqual({ delivered: 1, failed: 0 });
    const [got] = r.got;
    expect(JSON.parse(got!.body)).toMatchObject({ event: "agent", recipient: "bob", sender: "alice", text: "hello bob" });
    expect(got!.headers["x-key"]).toBe("header-value");
    expect(got!.headers["x-message-cp-signature"]).toBe(`sha256=${createHmac("sha256", made.secret).update(got!.body).digest("hex")}`);
  });

  it("answers 400 with addWebhook's refusal, never repeating the URL or header value, and adds nothing", async () => {
    hooks();
    const before = snapshot();
    const cases: [Record<string, unknown>, string][] = [
      [{ url: "not a url", on: "#general" }, "Invalid --url: give an absolute https URL."],
      [{ url: "http://example.com/x", on: "#general" }, "--url must be https (plain http only for 127.x.x.x or [::1]): deliveries would cross the network in the clear."],
      [{ url: "http://localhost@evil/", on: "#general" }, "--url must be https (plain http only for 127.x.x.x or [::1]): deliveries would cross the network in the clear."],
      [{ url: "https://@/", on: "#general" }, "Invalid --url: give an absolute https URL."],
      [{ url: "https://h/?x=/o/", on: "#general" }, "--url must not carry a username, password, query or fragment."],
      [{ url: "https://h/#/o/", on: "#general" }, "--url must not carry a username, password, query or fragment."],
      [{ url: "https://user:pw@h/", on: "#general" }, "--url must not carry a username, password, query or fragment."],
      [{ url: "https://h/", on: "general" }, "Invalid --on: use #<channel>, mention:<agent> or agent:<agent>, names of 1-32 letters, digits, '-' and '_'."],
      [{ url: "https://h/", on: "agent:all" }, "Invalid --on: 'all' is reserved and names no agent."],
      [{ url: "https://h/", on: "#general", header: "no colon header-value" }, "Invalid header: give one line '<Name>: <value>'."],
      [{ url: "https://h/", on: "#general", header: "Host: header-value" }, "Invalid header: message-cp controls Host itself; choose another header."],
      [{ url: "https://h/", on: "#general", header: "X-Key: header-value\r\nX-Other: 1" }, "Invalid header: its value contains a control character."],
      [{ url: "https://h/", on: "#general", maxPerHour: 0 }, "Invalid --max-per-hour: give a whole number from 1 to 10000."],
      [{ url: "https://h/", on: "#general", maxPerHour: 1.5 }, "Invalid --max-per-hour: give a whole number from 1 to 10000."],
      [{ url: "https://h/", on: "#general", maxPerHour: 10001 }, "Invalid --max-per-hour: give a whole number from 1 to 10000."],
      [{ url: "https://h/", on: "#general", body: "fixed-body" }, "Invalid --body: it is not JSON."],
      [{ url: "https://h/", on: "#general", body: '{"a":"fixed-body"}' }, "Invalid --body: put {{delivery}} exactly once, inside a JSON string value."],
      [
        { url: "https://h/", on: "#general", includeText: false, body: '{"a":"{{delivery}}"}' },
        "--body and --no-text cannot go together: a fixed body never carries the text.",
      ],
    ];
    for (const [body, expected] of cases) {
      const res = await add(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      const text = await message(res);
      expect(text).toBe(expected);
      expect(text).not.toContain("header-value");
      expect(text).not.toContain("evil");
    }
    expect(snapshot()).toEqual(before);
  });

  it("answers 400, adding nothing, for a missing or wrongly typed field, an unknown field, or JSON that is not an object", async () => {
    const before = snapshot();
    const typed = "Give url and on as strings, and optionally includeText as true or false, header and body as strings and maxPerHour as a number";
    const only = "Give a JSON object with only url, on, includeText, header, maxPerHour, body";
    const cases: [unknown, string][] = [
      [{ on: "#general" }, typed],
      [{ url: "https://h/" }, typed],
      [{ url: 1, on: "#general" }, typed],
      [{ url: "https://h/", on: ["#general"] }, typed],
      [{ url: "https://h/", on: "#general", includeText: "yes" }, typed],
      [{ url: "https://h/", on: "#general", includeText: null }, typed],
      [{ url: "https://h/", on: "#general", header: 1 }, typed],
      [{ url: "https://h/", on: "#general", maxPerHour: "50" }, typed],
      [{ url: "https://h/", on: "#general", body: { a: "{{delivery}}" } }, typed],
      [{ url: "https://h/", on: "#general", account: "friend" }, only],
      [["https://h/", "#general"], only],
      ["null", typed],
      ['"https://h/"', typed],
      ["3", typed],
    ];
    for (const [body, expected] of cases) {
      const res = await add(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await message(res)).toBe(expected);
    }
    const bad = await add("{not json");
    expect(bad.status).toBe(400);
    expect(await message(bad)).toBe("Invalid JSON");
    expect(snapshot()).toEqual(before);
  });

  it("answers 413 for a body over 64 KB, adding nothing", async () => {
    const res = await add({ url: "https://h/", on: "#general", body: `{"a":"{{delivery}}","pad":"${"x".repeat(70 * 1024)}"}` });
    expect(res.status).toBe(413);
    expect(listWebhooks(db)).toEqual([]);
  });

  it("adds to the token's own account only, leaving the other account's webhooks unchanged", async () => {
    const { theirs } = hooks();
    addPerson(db, "friend", "fay", true);
    const fay = personToken("friend", "fay");
    const owners = rows("SELECT * FROM webhooks WHERE account_id = ? ORDER BY id", OWNER_ACCOUNT);
    const res = await add({ url: "https://friend.example/new", on: "#general" }, fay);
    const made = (await res.json()) as { id: number };
    expect(listWebhooks(db, "friend").map((w) => w.id)).toEqual([theirs.id, made.id]);
    expect(rows("SELECT * FROM webhooks WHERE account_id = ? ORDER BY id", OWNER_ACCOUNT)).toEqual(owners);
    // And the owner's admin adds to the owner's, never the friend's.
    const friends = rows("SELECT * FROM webhooks WHERE account_id = ? ORDER BY id", friend);
    expect((await add({ url: "https://example.com/new", on: "#general" })).status).toBe(200);
    expect(rows("SELECT * FROM webhooks WHERE account_id = ? ORDER BY id", friend)).toEqual(friends);
  });

  it("refuses with 503 and Connection: close, reading no body, once every slot is taken", async () => {
    await http.close();
    http = await startHttp(db, { token: OWNER_TOKEN, port: 0, waitHoldMs: 0, maxSessions: 1 });
    // A POST whose body never ends holds the one slot.
    const held = new AbortController();
    const holding = fetch(`http://127.0.0.1:${http.port}/api/webhooks`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ana}`, "Content-Type": "application/json" },
      body: new ReadableStream({ start: (c) => c.enqueue(new TextEncoder().encode("{")) }),
      duplex: "half",
      signal: held.signal,
    } as RequestInit).catch(() => undefined);
    await vi.waitFor(async () => {
      const res = await add({ url: "https://example.com/new", on: "#general" });
      expect(res.status).toBe(503);
      expect(res.headers.get("connection")).toBe("close");
      expect(await message(res)).toBe("Too many requests");
    });
    held.abort();
    await holding;
    expect(listWebhooks(db)).toEqual([]);
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
      [OWNER_TOKEN, /^A full token cannot list, add or remove webhooks over the API\. Run message-cp webhook list, webhook add or webhook remove on the server/],
    ] as const;
    const before = snapshot();
    for (const [token, expected] of tokens) {
      for (const res of [await list("", token), await remove(1, token), await add({ url: "https://example.com/new", on: "#general" }, token)]) {
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
    for (const route of routes) {
      const res = await route();
      expect(res.status).toBe(403);
      expect(await message(res)).toBe("A person token only reads, sends and posts");
    }
  });

  it("refuses with 403, changing nothing, an admin unmarked or removed between the token check and the work", async () => {
    hooks();
    const before = snapshot();
    for (const change of ["UPDATE agents SET admin = 0 WHERE name = 'ana'", "UPDATE agents SET removed_at = 1 WHERE name = 'ana'"]) {
      for (const route of routes) {
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

  it("refuses listWebhooksBy, addWebhookBy and removeWebhookBy for anyone who is not a live admin of the account", async () => {
    const { first } = hooks();
    addPerson(db, "owner", "ben");
    addPerson(db, "friend", "fay", true);
    const before = snapshot();
    for (const by of [idOf(OWNER_ACCOUNT, "ben"), idOf(friend, "fay"), 9999]) {
      expect(() => listWebhooksBy(db, OWNER_ACCOUNT, by, 10, 0)).toThrow(NotAdminError);
      expect(() => removeWebhookBy(db, OWNER_ACCOUNT, by, first.id)).toThrow(NotAdminError);
      expect(() => addWebhookBy(db, OWNER_ACCOUNT, by, { url: "https://example.com/new", on: "#general", includeText: true })).toThrow(NotAdminError);
    }
    // A live admin still gets addWebhook's refusal, the savepoint it runs in rolled back with the rest.
    expect(() => addWebhookBy(db, OWNER_ACCOUNT, idOf(OWNER_ACCOUNT, "ana"), { url: "https://h/", on: "#general", includeText: true, body: "{}" })).toThrow(WebhookError);
    expect(snapshot()).toEqual(before);
  });

  it("answers 503 with Retry-After when the database is busy, changing nothing", async () => {
    hooks();
    const before = snapshot();
    for (const route of routes) {
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

  it("answers 405 with Allow: GET, POST, DELETE for another method", async () => {
    for (const method of ["PUT", "PATCH"]) {
      const res = await call("/api/webhooks", ana, method);
      expect(res.status, method).toBe(405);
      expect(res.headers.get("allow")).toBe("GET, POST, DELETE");
    }
  });
});

describe("the plans of listing, adding and removing webhooks", () => {
  it("finds the account's webhooks, a webhook's deliveries and the account's name by index, and cascades through webhook_deliveries_by_webhook, never scanning", () => {
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
    addWebhookBy(db, OWNER_ACCOUNT, by, { url: "https://example.com/new", on: "#general", includeText: true });
    spy.mockRestore();
    const plans = [...new Set(sql)].map((s) =>
      (db.prepare(`EXPLAIN QUERY PLAN ${s}`).all(...Array.from(s.matchAll(/\?/g), () => null)) as { detail: string }[]).map((r) => r.detail),
    );
    for (const plan of plans) expect(plan.filter((d) => d.startsWith("SCAN"))).toEqual([]);
    const at = (start: string) => plans.find((p) => p[0].startsWith(start))!;
    expect(at("SEARCH webhooks USING INDEX webhooks_by_name")).toEqual(["SEARCH webhooks USING INDEX webhooks_by_name (account_id=?)", "USE TEMP B-TREE FOR ORDER BY"]);
    const searches = plans.filter((p) => p.includes("SEARCH webhook_deliveries USING COVERING INDEX webhook_deliveries_by_webhook (webhook_id=?)"));
    // The count, the delete, whose ON DELETE CASCADE finds the webhook's deliveries through the same index, and the
    // insert, whose foreign key check looks there for deliveries naming the new id.
    expect(searches).toEqual([
      ["SEARCH webhook_deliveries USING COVERING INDEX webhook_deliveries_by_webhook (webhook_id=?)"],
      ["SEARCH webhooks USING INTEGER PRIMARY KEY (rowid=?)", "SEARCH webhook_deliveries USING COVERING INDEX webhook_deliveries_by_webhook (webhook_id=?)"],
      ["SEARCH webhook_deliveries USING COVERING INDEX webhook_deliveries_by_webhook (webhook_id=?)"],
    ]);
    // addWebhookBy's account lookups: by id for its name, then addWebhook's by that name.
    expect(at("SEARCH accounts USING INTEGER PRIMARY KEY")).toEqual(["SEARCH accounts USING INTEGER PRIMARY KEY (rowid=?)"]);
    expect(at("SEARCH accounts USING COVERING INDEX")).toEqual(["SEARCH accounts USING COVERING INDEX sqlite_autoindex_accounts_1 (name=?)"]);
  });
});
