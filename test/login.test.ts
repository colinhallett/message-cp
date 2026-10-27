import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { accountForToken, addAccount, listAccounts, listTokens, revokeToken } from "../src/accounts.js";
import { addPerson, registerAgent, removePerson } from "../src/agents.js";
import { OWNER_ACCOUNT, openDb, type AccountId, type Db } from "../src/db.js";
import { startHttp, type HttpServer } from "../src/http.js";
import { LOGIN_CODE_TTL_MS, LoginError, LoginRefused, MAX_LOGIN_CODES, dashboardUrl, loginLink, makeLoginCode, redeemLoginCode } from "../src/login.js";

// `message-cp login-link`: a one-time code in a dashboard link's fragment, redeemed once with POST /api/login for a token.
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
const everything = () => ({ codes: rows("SELECT * FROM login_codes ORDER BY id"), tokens: rows("SELECT * FROM tokens ORDER BY id") });

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
  it("gives a full token of the account once, and stores only the code's hash", () => {
    const c = makeLoginCode(db, "owner");
    expect(c.code).toMatch(/^[0-9a-f]{64}$/);
    expect(c.person).toBeUndefined();
    expect(JSON.stringify(everything())).not.toContain(c.code);
    const token = redeemLoginCode(db, c.code);
    expect(accountForToken(db, token, OWNER_TOKEN)).toEqual({ account: OWNER_ACCOUNT, readOnly: false, agentOnly: false });
    expect(refusal(() => redeemLoginCode(db, c.code))).toBe("used");
    expect(listTokens(db).filter((t) => t.kind === "full")).toHaveLength(2);
  });

  it("with a person, gives a person token of that person, which token list shows and token revoke stops", () => {
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
  });

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
  });

  it("is in help and in the unknown command list", () => {
    expect(cli("help").stdout).toContain("message-cp login-link --url <public url> [--account <name>] [--person <name>]");
    expect(cli("nope").stderr).toContain("login-link");
  });
});

describe("POST /api/login", () => {
  const base = () => `http://127.0.0.1:${http!.port}`;
  const login = (body: string) => fetch(`${base()}/api/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body });

  it("takes no token, answers a new token once, then says the link was already used", async () => {
    http = await startHttp(db, { token: OWNER_TOKEN, port: 0 });
    const { code } = makeLoginCode(db, "owner", "maria");
    const res = await login(JSON.stringify({ code }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { token } = (await res.json()) as { token: string };
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
});
