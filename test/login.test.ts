import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { accountForToken, addAccount, listAccounts, listTokens, revokeToken } from "../src/accounts.js";
import { addPerson, registerAgent, removePerson } from "../src/agents.js";
import { OWNER_ACCOUNT, openDb, type AccountId, type Db } from "../src/db.js";
import { startHttp, type HttpServer } from "../src/http.js";
import { LOGIN_CODE_TTL_MS, LoginError, LoginRefused, MAX_LOGIN_CODES, dashboardUrl, loginLink, makeLoginCode, redeemLoginCode } from "../src/login.js";

// `message-cp login-link`: a one-time code in a dashboard link's fragment, redeemed once with POST /api/login for a
// dashboard sign-in session of a new token.
const OWNER_TOKEN = "owner-token";
let dbFile: string;
let db: Db;
let friend: AccountId;
let http: HttpServer | undefined;

beforeEach(() => {
  dbFile = join(mkdtempSync(join(tmpdir(), "message-cp-login-")), "db.sqlite");
  db = openDb(dbFile);
  addAccount(db, "friend");
  friend = listAccounts(db).find((a) => a.name === "friend")!.id;
  addPerson(db, "owner", "maria");
});

afterEach(async () => {
  await http?.close();
  http = undefined;
  db.close();
});

const rows = (sql: string, ...p: unknown[]) => db.prepare(sql).all(...p);
const everything = () => ({
  codes: rows("SELECT * FROM login_codes ORDER BY id"),
  tokens: rows("SELECT * FROM tokens ORDER BY id"),
  sessions: rows("SELECT * FROM dashboard_sessions ORDER BY id"),
});
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    if (err instanceof LoginRefused) return err.reason;
    throw err;
  }
  throw new Error("not refused");
};

describe("makeLoginCode and redeemLoginCode", () => {
  it("gives a session of a full token of the account once, and stores only the code's hash", () => {
    const c = makeLoginCode(db, "owner");
    expect(c.code).toMatch(/^[0-9a-f]{64}$/);
    expect(c.person).toBeUndefined();
    expect(JSON.stringify(everything())).not.toContain(c.code);
    const session = redeemLoginCode(db, c.code);
    const row = db.prepare("SELECT id FROM dashboard_sessions").get() as { id: number };
    expect(accountForToken(db, session, OWNER_TOKEN)).toEqual({ account: OWNER_ACCOUNT, readOnly: false, agentOnly: false, session: row.id });
    expect(refusal(() => redeemLoginCode(db, c.code))).toBe("used");
    expect(listTokens(db).filter((t) => t.kind === "full")).toHaveLength(2);
  });

  it("with a person, gives a session of a person token of that person, which token list shows and token revoke stops", () => {
    const c = makeLoginCode(db, "owner", "MARIA");
    expect(c.person).toBe("maria");
    const token = redeemLoginCode(db, c.code);
    const access = accountForToken(db, token, OWNER_TOKEN)!;
    expect(access.person?.name).toBe("maria");
    const listed = listTokens(db).at(-1)!;
    expect(listed).toMatchObject({ account: "owner", kind: "person" });
    revokeToken(db, listed.id);
    expect(accountForToken(db, token, OWNER_TOKEN)).toBeUndefined();
  });

  it("works only for its own account", () => {
    addPerson(db, "friend", "maria");
    const token = redeemLoginCode(db, makeLoginCode(db, "friend", "maria").code);
    const access = accountForToken(db, token, OWNER_TOKEN)!;
    expect(access.account).toBe(friend);
    expect(access.person?.id).toBe((db.prepare("SELECT id FROM agents WHERE account_id = ? AND name = 'maria'").get(friend) as { id: number }).id);
    expect(accountForToken(db, redeemLoginCode(db, makeLoginCode(db, "friend").code), OWNER_TOKEN)?.account).toBe(friend);
  });

  it("refuses an unknown account, a person that is unknown, removed or an agent, storing nothing", () => {
    registerAgent(db, OWNER_ACCOUNT, "bot");
    removePerson(db, "owner", "maria");
    const before = everything();
    expect(() => makeLoginCode(db, "nobody")).toThrow(new LoginError("No account named 'nobody'."));
    expect(() => makeLoginCode(db, "owner", "zed")).toThrow(new LoginError("No person named 'zed' in account 'owner'."));
    expect(() => makeLoginCode(db, "owner", "maria")).toThrow(LoginError);
    expect(() => makeLoginCode(db, "owner", "bot")).toThrow(new LoginError("The name 'bot' belongs to an agent, not a person."));
    expect(() => makeLoginCode(db, "friend", "maria")).toThrow(new LoginError("No person named 'maria' in account 'friend'."));
    expect(everything()).toEqual(before);
  });

  it("expires 5 minutes after it was made", () => {
    const now = Date.now();
    const c = makeLoginCode(db, "owner", undefined, now);
    expect(c.expiresAt).toBe(now + LOGIN_CODE_TTL_MS);
    expect(LOGIN_CODE_TTL_MS).toBe(5 * 60 * 1000);
    const before = everything();
    expect(refusal(() => redeemLoginCode(db, c.code, now + LOGIN_CODE_TTL_MS))).toBe("invalid");
    expect(everything()).toEqual(before);
    expect(redeemLoginCode(db, c.code, now + LOGIN_CODE_TTL_MS - 1)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("gives no token for a person removed after the link was made, even if the name is a person's again", () => {
    const c = makeLoginCode(db, "owner", "maria");
    removePerson(db, "owner", "maria");
    addPerson(db, "owner", "maria");
    const before = listTokens(db);
    expect(refusal(() => redeemLoginCode(db, c.code))).toBe("invalid");
    expect(listTokens(db)).toEqual(before);
  });

  it("refuses an unknown code or one that is not a code, and never quotes it", () => {
    for (const code of ["0".repeat(64), "", "x".repeat(10_000), makeLoginCode(db, "owner").code.toUpperCase()]) {
      try {
        redeemLoginCode(db, code);
        throw new Error("not refused");
      } catch (err) {
        expect((err as LoginRefused).reason).toBe("invalid");
        expect((err as Error).message).toBe("This link has expired or is not valid.");
      }
    }
  });

  it("deletes expired codes, and refuses past MAX_LOGIN_CODES unused ones", () => {
    const now = Date.now();
    makeLoginCode(db, "owner", undefined, now - LOGIN_CODE_TTL_MS);
    const insert = db.prepare("INSERT INTO login_codes (code_hash, account_id, expires_at) VALUES (?, 1, ?)");
    for (let i = 0; i < MAX_LOGIN_CODES - 1; i++) insert.run(`h${i}`, now + 60_000);
    makeLoginCode(db, "owner", undefined, now);
    expect(rows("SELECT * FROM login_codes WHERE expires_at <= ?", now)).toHaveLength(0);
    expect(() => makeLoginCode(db, "owner", undefined, now)).toThrow(LoginError);
    // A used code no longer counts.
    db.prepare("UPDATE login_codes SET used_at = ? WHERE code_hash = 'h0'").run(now);
    expect(() => makeLoginCode(db, "owner", undefined, now)).not.toThrow();
  });

  it("finds codes by index in its transactions, without scanning the table", () => {
    const plan = (sql: string, ...p: unknown[]) =>
      (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...p) as { detail: string }[]).map((r) => r.detail).join("\n");
    expect(plan("DELETE FROM login_codes WHERE expires_at <= ?", 0)).toMatch(/USING (COVERING )?INDEX login_codes_by_expiry/);
    expect(plan("SELECT id, account_id, person_id, expires_at, used_at FROM login_codes WHERE code_hash = ?", "x")).toMatch(/USING INDEX sqlite_autoindex_login_codes_1/);
    expect(plan("UPDATE login_codes SET used_at = ? WHERE id = ?", 0, 1)).toMatch(/USING INTEGER PRIMARY KEY/);
  });
});

describe("dashboardUrl and loginLink", () => {
  it("puts the code in the fragment of the dashboard's address, keeping the path", () => {
    expect(loginLink(dashboardUrl("https://h.example"), "ab").href).toBe("https://h.example/#code=ab");
    expect(loginLink(dashboardUrl("https://h.example/cp/mcp/"), "ab").href).toBe("https://h.example/cp/#code=ab");
    expect(loginLink(dashboardUrl("http://127.0.0.1:8787"), "ab").href).toBe("http://127.0.0.1:8787/#code=ab");
  });
});

const root = resolve(import.meta.dirname, "..");
const cli = (...args: string[]) =>
  spawnSync(join(root, "node_modules/.bin/tsx"), [join(root, "src/cli.ts"), ...args], {
    env: { ...process.env, MESSAGE_CP_DB: dbFile },
    encoding: "utf8",
  });

describe("message-cp login-link", () => {
  it("prints exactly one line, the link, and says on stderr what it signs in as and when it expires", () => {
    const out = cli("login-link", "--url", "https://message-cp.example.com", "--person", "maria");
    expect(out.status).toBe(0);
    const lines = out.stdout.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe("");
    const link = new URL(lines[0]!);
    expect(`${link.origin}${link.pathname}${link.search}`).toBe("https://message-cp.example.com/");
    const code = /^#code=([0-9a-f]{64})$/.exec(link.hash)![1]!;
    expect(out.stderr).toMatch(/as person 'maria' of account 'owner' \(a person token\)\. It works once, and expires in 5 minutes, at \d{4}-/);
    expect(out.stderr).not.toContain(code);
    expect(out.stderr).not.toMatch(/[0-9a-f]{64}/);
    expect(accountForToken(db, redeemLoginCode(db, code), OWNER_TOKEN)?.person?.name).toBe("maria");
  });

  it("defaults to the owner account and a full token, and takes --account", () => {
    const owner = cli("login-link", "--url", "http://127.0.0.1:8787");
    expect(owner.status).toBe(0);
    expect(owner.stderr).toContain("as the owner of account 'owner' (a full token)");
    const other = cli("login-link", "--account", "friend", "--url", "http://[::1]:8787/");
    expect(other.status).toBe(0);
    const code = new URL(other.stdout.trim()).hash.slice("#code=".length);
    expect(accountForToken(db, redeemLoginCode(db, code), OWNER_TOKEN)?.account).toBe(friend);
  });

  it("refuses an unsafe URL, including the bypasses, before opening the database", () => {
    const fresh = join(mkdtempSync(join(tmpdir(), "message-cp-login-")), "db.sqlite");
    for (const url of ["http://localhost@evil/", "https://@/", "https://h/?x=/o/", "https://h/#/o/", "http://example.com", "http://localhost:8787", "not a url"]) {
      const out = spawnSync(join(root, "node_modules/.bin/tsx"), [join(root, "src/cli.ts"), "login-link", "--url", url], {
        env: { ...process.env, MESSAGE_CP_DB: fresh },
        encoding: "utf8",
      });
      expect(out.status, url).toBe(1);
      expect(out.stdout).toBe("");
      expect(out.stderr).toMatch(/^message-cp: --url /);
    }
    expect(spawnSync("test", ["-e", fresh]).status).toBe(1);
  }, 60_000);

  it("refuses an unknown account or person, an agent's name and any other or repeated flag, storing nothing", () => {
    registerAgent(db, OWNER_ACCOUNT, "bot");
    const before = everything();
    for (const [args, status, message] of [
      [["--url", "https://h", "--account", "nobody"], 1, "message-cp: No account named 'nobody'.\n"],
      [["--url", "https://h", "--person", "zed"], 1, "message-cp: No person named 'zed' in account 'owner'.\n"],
      [["--url", "https://h", "--person", "bot"], 1, "message-cp: The name 'bot' belongs to an agent, not a person.\n"],
      [["--url", "https://h", "--url", "https://h"], 2, undefined],
      [["--url", "https://h", "--new-key"], 2, undefined],
      [["--url", "https://h", "--person"], 2, undefined],
      [["--url", "https://h", "extra"], 2, undefined],
      [["--account", "owner"], 2, undefined],
      [[], 2, undefined],
    ] as const) {
      const out = cli("login-link", ...args);
      expect(out.status, args.join(" ")).toBe(status);
      expect(out.stdout).toBe("");
      expect(out.stderr).toBe(message ?? "usage: message-cp login-link --url <public url> [--account <name>] [--person <name>]\n");
    }
    expect(everything()).toEqual(before);
  }, 60_000);

  it("is in help and in the unknown command list", () => {
    expect(cli("help").stdout).toContain("message-cp login-link --url <public url> [--account <name>] [--person <name>]");
    expect(cli("nope").stderr).toContain("login-link");
  }, 60_000);
});

describe("dashboard sign-in sessions", () => {
  const maria = () => (db.prepare("SELECT id FROM agents WHERE account_id = ? AND name = 'maria'").get(OWNER_ACCOUNT) as { id: number }).id;

  it("redeems to a session id whose hash is in dashboard_sessions, not in tokens, and acts as the code's account and person", () => {
    const session = redeemLoginCode(db, makeLoginCode(db, "owner", "maria").code);
    expect(session).toMatch(/^[0-9a-f]{64}$/);
    const stored = db.prepare("SELECT * FROM dashboard_sessions").all() as { id: number; hash: string; token_id: number }[];
    expect(stored).toHaveLength(1);
    expect(stored[0].hash).toBe(sha256(session));
    expect(db.prepare("SELECT 1 FROM tokens WHERE hash = ?").get(sha256(session))).toBeUndefined();
    expect(JSON.stringify(everything())).not.toContain(session);
    // Its token is the code's new person token, which token list shows like any other.
    expect(listTokens(db).at(-1)).toMatchObject({ id: stored[0].token_id, account: "owner", kind: "person" });
    expect(accountForToken(db, session, OWNER_TOKEN)).toEqual({
      account: OWNER_ACCOUNT,
      readOnly: false,
      agentOnly: false,
      person: { id: maria(), name: "maria", admin: false },
      session: stored[0].id,
    });
  });

  it("stops working once its token is revoked", () => {
    const session = redeemLoginCode(db, makeLoginCode(db, "owner").code);
    expect(accountForToken(db, session, OWNER_TOKEN)).toBeDefined();
    revokeToken(db, (db.prepare("SELECT token_id FROM dashboard_sessions").get() as { token_id: number }).token_id);
    expect(accountForToken(db, session, OWNER_TOKEN)).toBeUndefined();
  });

  it("stops working once its person is removed", () => {
    const session = redeemLoginCode(db, makeLoginCode(db, "owner", "maria").code);
    expect(accountForToken(db, session, OWNER_TOKEN)?.person?.name).toBe("maria");
    removePerson(db, "owner", "maria");
    expect(accountForToken(db, session, OWNER_TOKEN)).toBeUndefined();
  });

  it("reads whether its person is an admin afresh", () => {
    const session = redeemLoginCode(db, makeLoginCode(db, "owner", "maria").code);
    expect(accountForToken(db, session, OWNER_TOKEN)?.person?.admin).toBe(false);
    db.prepare("UPDATE agents SET admin = 1 WHERE id = ?").run(maria());
    expect(accountForToken(db, session, OWNER_TOKEN)?.person?.admin).toBe(true);
  });

  it("finds a session by its unique hash index, then its token by row id, without scanning", () => {
    const sessionPlan = db.prepare("EXPLAIN QUERY PLAN SELECT id, token_id FROM dashboard_sessions WHERE hash = ?").all("h") as { detail: string }[];
    expect(sessionPlan.map((r) => r.detail)).toEqual(["SEARCH dashboard_sessions USING INDEX sqlite_autoindex_dashboard_sessions_1 (hash=?)"]);
    const insertPlan = db
      .prepare("EXPLAIN QUERY PLAN INSERT INTO dashboard_sessions (hash, token_id, created_at) VALUES (?, ?, ?)")
      .all("h", 1, 0) as { detail: string }[];
    expect(insertPlan.map((r) => r.detail).join("\n")).not.toMatch(/SCAN/);
    const tokenPlan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT tokens.id FROM tokens LEFT JOIN agents ON agents.id = tokens.agent_id AND agents.account_id = tokens.account_id
           AND agents.removed_at IS NULL AND agents.person = 0
         LEFT JOIN agents people ON people.id = tokens.person_id AND people.account_id = tokens.account_id
           AND people.removed_at IS NULL AND people.person = 1
         WHERE tokens.id = ? AND tokens.revoked_at IS NULL`,
      )
      .all(1) as { detail: string }[];
    expect(tokenPlan.map((r) => r.detail).join("\n")).not.toMatch(/SCAN/);
    expect(tokenPlan[0].detail).toBe("SEARCH tokens USING INTEGER PRIMARY KEY (rowid=?)");
  });
});

describe("POST /api/login", () => {
  const base = () => `http://127.0.0.1:${http!.port}`;
  const login = (body: string) => fetch(`${base()}/api/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body });

  it("takes no token, answers a new session and no token once, then says the link was already used", async () => {
    http = await startHttp(db, { token: OWNER_TOKEN, port: 0 });
    const { code } = makeLoginCode(db, "owner", "maria");
    const res = await login(JSON.stringify({ code }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const answer = (await res.json()) as { session: string };
    expect(Object.keys(answer)).toEqual(["session"]);
    const token = answer.session;
    const me = await fetch(`${base()}/api/token`, { headers: { Authorization: `Bearer ${token}` } });
    expect(await me.json()).toMatchObject({ readOnly: false, agentOnly: false, person: "maria" });
    const again = await login(JSON.stringify({ code }));
    expect(again.status).toBe(400);
    const text = await again.text();
    expect(JSON.parse(text)).toEqual({ reason: "used", message: "This link was already used." });
    expect(text).not.toContain(code);
  });

  it("gives at most one token for two requests with the same code at once", async () => {
    http = await startHttp(db, { token: OWNER_TOKEN, port: 0 });
    const { code } = makeLoginCode(db, "owner");
    const answers = await Promise.all([1, 2, 3].map(() => login(JSON.stringify({ code })).then((r) => r.status)));
    expect(answers.sort()).toEqual([200, 400, 400]);
  });

  it("says an unknown or malformed code is not valid, never quoting it, and takes only POST", async () => {
    http = await startHttp(db, { token: OWNER_TOKEN, port: 0 });
    const unknown = "f".repeat(64);
    for (const body of [JSON.stringify({ code: unknown }), JSON.stringify({}), "null", "{", JSON.stringify({ code: 5 })]) {
      const res = await login(body);
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(JSON.parse(text).reason).toBe("invalid");
      expect(text).not.toContain(unknown);
    }
    expect((await fetch(`${base()}/api/login`)).status).toBe(405);
  });

  it("works with a public URL too", async () => {
    http = await startHttp(db, { token: OWNER_TOKEN, port: 0, publicUrl: "http://127.0.0.1:1" });
    const res = await login(JSON.stringify({ code: makeLoginCode(db, "owner").code }));
    expect(res.status).toBe(200);
  });

  it("counts against a cap checked before the body is read, answering 503 with Connection: close and Retry-After", async () => {
    http = await startHttp(db, { token: OWNER_TOKEN, port: 0, maxSessions: 1 });
    const { request } = await import("node:http");
    // One request holds the only slot by never finishing its body.
    const held = request(`${base()}/api/login`, { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": "100" } });
    held.on("error", () => {});
    held.write("{");
    await new Promise((r) => setTimeout(r, 100));
    const res = await login(JSON.stringify({ code: makeLoginCode(db, "owner").code }));
    expect(res.status).toBe(503);
    expect(res.headers.get("connection")).toBe("close");
    expect(res.headers.get("retry-after")).toBe("5");
    held.destroy();
    await new Promise((r) => setTimeout(r, 100));
    // The slot is given back once the held request ends.
    expect((await login(JSON.stringify({ code: makeLoginCode(db, "owner").code }))).status).toBe(200);
  });

  describe("a session's reach", () => {
    const auth = (bearer: string) => ({ Authorization: `Bearer ${bearer}` });
    const redeem = async (account: string, person?: string) => {
      const res = await login(JSON.stringify({ code: makeLoginCode(db, account, person).code }));
      expect(res.status).toBe(200);
      return ((await res.json()) as { session: string }).session;
    };
    const mcpInit = (bearer: string) =>
      fetch(`${base()}/mcp`, {
        method: "POST",
        headers: { ...auth(bearer), "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } }),
      });

    it("gets 403 on POST /mcp and GET /wait for a full token's session, which the token itself reaches", async () => {
      http = await startHttp(db, { token: OWNER_TOKEN, port: 0 });
      registerAgent(db, OWNER_ACCOUNT, "bot");
      const session = await redeem("owner");
      for (const res of [await mcpInit(session), await fetch(`${base()}/wait?agent=bot`, { headers: auth(session) })]) {
        expect(res.status).toBe(403);
        expect(res.headers.get("connection")).toBe("close");
        expect(((await res.json()) as { error: { message: string } }).error.message).toBe("A dashboard sign-in cannot use MCP or /wait");
      }
      // Everywhere else it reads as its full token does.
      expect((await fetch(`${base()}/api/agents`, { headers: auth(session) })).status).toBe(200);
      expect(await (await fetch(`${base()}/api/token`, { headers: auth(session) })).json()).toMatchObject({ readOnly: false, agentOnly: false });
    });

    it("gets the session's 403 on every /mcp method and /wait for a person's session too", async () => {
      http = await startHttp(db, { token: OWNER_TOKEN, port: 0 });
      const session = await redeem("owner", "maria");
      for (const res of [
        await mcpInit(session),
        await fetch(`${base()}/mcp`, { headers: auth(session) }),
        await fetch(`${base()}/mcp`, { method: "DELETE", headers: auth(session) }),
        await fetch(`${base()}/wait?agent=maria`, { headers: auth(session) }),
      ]) {
        expect(res.status).toBe(403);
        expect(((await res.json()) as { error: { message: string } }).error.message).toBe("A dashboard sign-in cannot use MCP or /wait");
      }
    });

    it("lists GET /api/tokens for an admin person's session, the link's own token among them", async () => {
      http = await startHttp(db, { token: OWNER_TOKEN, port: 0 });
      db.prepare("UPDATE agents SET admin = 1 WHERE name = 'maria'").run();
      const session = await redeem("owner", "maria");
      expect(await (await fetch(`${base()}/api/token`, { headers: auth(session) })).json()).toMatchObject({ person: "maria", admin: true });
      const res = await fetch(`${base()}/api/tokens`, { headers: auth(session) });
      expect(res.status).toBe(200);
      const own = (db.prepare("SELECT token_id FROM dashboard_sessions").get() as { token_id: number }).token_id;
      expect(((await res.json()) as { id: number }[]).map((t) => t.id)).toContain(own);
      expect(JSON.stringify(rows("SELECT * FROM tokens"))).not.toContain(session);
    });

    it("sends as its person only, and stops at its next request once its token is revoked", async () => {
      http = await startHttp(db, { token: OWNER_TOKEN, port: 0 });
      registerAgent(db, OWNER_ACCOUNT, "bot");
      const session = await redeem("owner", "maria");
      const send = await fetch(`${base()}/api/send`, {
        method: "POST",
        headers: { ...auth(session), "Content-Type": "application/json" },
        body: JSON.stringify({ as: "maria", to: "bot", body: "hi" }),
      });
      expect(send.status).toBe(200);
      expect(rows("SELECT messages.sender, agents.name FROM messages JOIN agents ON agents.id = messages.recipient_id")).toEqual([{ sender: "maria", name: "bot" }]);
      revokeToken(db, (db.prepare("SELECT token_id FROM dashboard_sessions").get() as { token_id: number }).token_id);
      expect((await fetch(`${base()}/api/token`, { headers: auth(session) })).status).toBe(401);
    });

    it("never reaches another account's data", async () => {
      http = await startHttp(db, { token: OWNER_TOKEN, port: 0 });
      registerAgent(db, OWNER_ACCOUNT, "ours");
      registerAgent(db, friend, "theirs");
      addPerson(db, "friend", "fay", true);
      const session = await redeem("friend", "fay");
      const agents = (await (await fetch(`${base()}/api/agents`, { headers: auth(session) })).json()) as { name: string }[];
      expect(agents.map((a) => a.name)).not.toContain("ours");
      expect(agents.map((a) => a.name)).toContain("theirs");
      const send = await fetch(`${base()}/api/send`, {
        method: "POST",
        headers: { ...auth(session), "Content-Type": "application/json" },
        body: JSON.stringify({ as: "fay", to: "ours", body: "hi" }),
      });
      expect(send.status).not.toBe(200);
      expect(rows("SELECT * FROM messages")).toEqual([]);
      const tokens = (await (await fetch(`${base()}/api/tokens`, { headers: auth(session) })).json()) as { id: number }[];
      const theirs = rows("SELECT id FROM tokens WHERE account_id = ? AND revoked_at IS NULL", friend).map((r) => (r as { id: number }).id);
      expect(tokens.map((t) => t.id).sort()).toEqual(theirs.sort());
    });
  });
});
