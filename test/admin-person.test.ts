import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { accountForToken, addAccount, addToken, listAccounts } from "../src/accounts.js";
import { PersonError, addPerson, listPeople, registerAgent, removePerson, setPersonAdmin } from "../src/agents.js";
import { OWNER_ACCOUNT, openDb, type AccountId, type Db } from "../src/db.js";
import { startHttp, type HttpServer } from "../src/http.js";
import { makeLoginCode, redeemLoginCode } from "../src/login.js";
import { sendMessage } from "../src/messages.js";

// Admin persons (`person add --admin`, `person admin`): their person tokens also delete the account's conversations,
// as the full token does, and still send and post only as themselves. On a server with the owner's account and a friend's.
const OWNER_TOKEN = "owner-token";
let dbFile: string;
let db: Db;
let http: HttpServer;
let friend: AccountId;

beforeEach(async () => {
  dbFile = join(mkdtempSync(join(tmpdir(), "message-cp-admin-person-")), "db.sqlite");
  db = openDb(dbFile);
  addAccount(db, "friend");
  friend = listAccounts(db).find((a) => a.name === "friend")!.id;
  for (const account of [OWNER_ACCOUNT, friend]) {
    registerAgent(db, account, "bob", "x");
    registerAgent(db, account, "carol", "x");
    sendMessage(db, account, "bob", "carol", `hello carol ${account}`);
  }
  http = await startHttp(db, { token: OWNER_TOKEN, port: 0, waitHoldMs: 0 });
});

afterEach(async () => {
  await http.close();
  db.close();
});

const base = () => `http://127.0.0.1:${http.port}`;
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });
const call = (path: string, token: string, method = "GET") => fetch(`${base()}${path}`, { method, headers: auth(token) });
const send = (path: string, token: string, body: unknown) =>
  fetch(`${base()}${path}`, { method: "POST", headers: { ...auth(token), "Content-Type": "application/json" }, body: JSON.stringify(body) });
const del = (token: string) => call("/api/conversation?a=bob&b=carol", token, "DELETE");
const messagesOf = (account: AccountId) =>
  db
    .prepare("SELECT m.sender, m.body FROM messages m JOIN agents a ON a.id = m.recipient_id WHERE a.account_id = ? ORDER BY m.id")
    .all(account);
const adminRow = (account: AccountId, name: string) =>
  db.prepare("SELECT admin FROM agents WHERE account_id = ? AND name = ? AND removed_at IS NULL").pluck().get(account, name);
const personToken = (account: string, name: string) => addToken(db, account, false, false, undefined, name).token;

describe("person add --admin and setPersonAdmin", () => {
  it("stores admin 1 only for a person added or marked admin, and 0 for everyone else", () => {
    expect(addPerson(db, "owner", "maria", true)).toMatchObject({ name: "maria", account: "owner", admin: true });
    expect(addPerson(db, "owner", "dana")).toMatchObject({ name: "dana", admin: false });
    expect(db.prepare("SELECT name, person, admin FROM agents WHERE account_id = ? ORDER BY name").all(OWNER_ACCOUNT)).toEqual([
      { name: "bob", person: 0, admin: 0 },
      { name: "carol", person: 0, admin: 0 },
      { name: "dana", person: 1, admin: 0 },
      { name: "maria", person: 1, admin: 1 },
    ]);
    expect(setPersonAdmin(db, "owner", "DANA", true)).toEqual({ name: "dana", account: "owner", admin: true });
    expect(adminRow(OWNER_ACCOUNT, "dana")).toBe(1);
    expect(setPersonAdmin(db, "owner", "maria", false)).toEqual({ name: "maria", account: "owner", admin: false });
    expect(adminRow(OWNER_ACCOUNT, "maria")).toBe(0);
    expect(listPeople(db).map((p) => [p.name, p.admin])).toEqual([
      ["dana", true],
      ["maria", false],
    ]);
  });

  it("refuses an agent, an unknown name, a removed person, another account's person and an unknown account, changing nothing", () => {
    addPerson(db, "owner", "maria");
    addPerson(db, "friend", "dana", true);
    addPerson(db, "owner", "gone");
    removePerson(db, "owner", "gone");
    const before = db.prepare("SELECT * FROM agents ORDER BY id").all();
    for (const [account, name, message] of [
      ["owner", "bob", "The name 'bob' belongs to an agent, not a person."],
      ["owner", "nobody", "No person named 'nobody' in account 'owner'."],
      ["owner", "gone", "No person named 'gone' in account 'owner'."],
      ["owner", "dana", "No person named 'dana' in account 'owner'."],
      ["friend", "maria", "No person named 'maria' in account 'friend'."],
      ["nobody", "maria", "No account named 'nobody'."],
    ] as const) {
      for (const admin of [true, false]) {
        expect(() => setPersonAdmin(db, account, name, admin)).toThrow(PersonError);
        expect(() => setPersonAdmin(db, account, name, admin)).toThrow(message);
      }
    }
    expect(db.prepare("SELECT * FROM agents ORDER BY id").all()).toEqual(before);
  });

  it("is read from the person's row on every accountForToken, so a held token follows the mark", () => {
    const maria = addPerson(db, "owner", "maria");
    const token = personToken("owner", "maria");
    const id = db.prepare("SELECT id FROM agents WHERE name = 'maria'").pluck().get() as number;
    expect(maria.admin).toBe(false);
    expect(accountForToken(db, token, OWNER_TOKEN)?.person).toEqual({ id, name: "maria", admin: false });
    setPersonAdmin(db, "owner", "maria", true);
    expect(accountForToken(db, token, OWNER_TOKEN)?.person).toEqual({ id, name: "maria", admin: true });
    setPersonAdmin(db, "owner", "maria", false);
    expect(accountForToken(db, token, OWNER_TOKEN)?.person).toEqual({ id, name: "maria", admin: false });
  });
});

describe("an admin person's token", () => {
  it("deletes a conversation in its own account as the full token does, where a plain person token gets 403", async () => {
    addPerson(db, "owner", "maria", true);
    addPerson(db, "owner", "dana");
    const admin = personToken("owner", "maria");
    const plain = personToken("owner", "dana");
    const res = await del(plain);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe("A person token only reads, sends and posts");
    expect(messagesOf(OWNER_ACCOUNT)).toHaveLength(1);

    const ok = await del(admin);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ deleted: 1 });
    expect(messagesOf(OWNER_ACCOUNT)).toEqual([]);
    // The friend's conversation between agents of the same names is untouched.
    expect(messagesOf(friend)).toEqual([{ sender: "bob", body: `hello carol ${friend}` }]);
  });

  it("follows marking and unmarking at its next request, with no new token", async () => {
    addPerson(db, "owner", "maria");
    const token = personToken("owner", "maria");
    expect((await del(token)).status).toBe(403);
    expect(await (await call("/api/token", token)).json()).toEqual({ readOnly: false, agentOnly: false, person: "maria" });
    setPersonAdmin(db, "owner", "maria", true);
    expect(await (await call("/api/token", token)).json()).toEqual({ readOnly: false, agentOnly: false, person: "maria", admin: true });
    setPersonAdmin(db, "owner", "maria", false);
    expect(await (await call("/api/token", token)).json()).toEqual({ readOnly: false, agentOnly: false, person: "maria" });
    expect((await del(token)).status).toBe(403);
    expect(messagesOf(OWNER_ACCOUNT)).toHaveLength(1);
    setPersonAdmin(db, "owner", "maria", true);
    expect((await del(token)).status).toBe(200);
    expect(messagesOf(OWNER_ACCOUNT)).toEqual([]);
  });

  it("passes the person check on /api/conversation only, so a GET there gets 405, and a login link's token is the same", async () => {
    addPerson(db, "owner", "maria", true);
    expect((await call("/api/conversation?a=bob&b=carol", personToken("owner", "maria"))).status).toBe(405);
    const linked = redeemLoginCode(db, makeLoginCode(db, "owner", "maria").code);
    expect(await (await call("/api/token", linked)).json()).toEqual({ readOnly: false, agentOnly: false, person: "maria", admin: true });
    expect((await del(linked)).status).toBe(200);
    expect(messagesOf(OWNER_ACCOUNT)).toEqual([]);
  });

  it("leaves a read-only token unable to delete while a person of its account is an admin", async () => {
    addPerson(db, "owner", "maria", true);
    const viewer = addToken(db, "owner", true).token;
    expect(await (await call("/api/token", viewer)).json()).toEqual({ readOnly: true, agentOnly: false });
    expect((await del(viewer)).status).toBe(403);
    expect(messagesOf(OWNER_ACCOUNT)).toHaveLength(1);
  });

  it("still gets 403 on /mcp, /wait and any other path, and changes nothing", async () => {
    addPerson(db, "owner", "maria", true);
    const token = personToken("owner", "maria");
    const before = db.prepare("SELECT * FROM messages ORDER BY id").all();
    for (const [path, method] of [
      ["/mcp", "POST"],
      ["/mcp", "GET"],
      ["/mcp", "DELETE"],
      ["/wait?agent=carol", "GET"],
      ["/api/nothing-here", "GET"],
      ["/api/conversation/x?a=bob&b=carol", "DELETE"],
    ]) {
      const res = await call(path, token, method);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(res.headers.get("connection"), `${method} ${path}`).toBe("close");
      expect(((await res.json()) as { error: { message: string } }).error.message).toBe("An admin person token only reads, sends, posts, deletes, invites and manages agents");
    }
    expect(db.prepare("SELECT * FROM messages ORDER BY id").all()).toEqual(before);
  });

  it.each([
    ["/api/send", { to: "bob" }],
    ["/api/post", { channel: "general" }],
  ] as const)("%s only as its own person: anyone else gets 403 and nothing is stored", async (path, target) => {
    addPerson(db, "owner", "maria", true);
    addPerson(db, "owner", "dana");
    const token = personToken("owner", "maria");
    for (const as of ["dana", "bob", "nobody"]) {
      const res = await send(path, token, { as, ...target, body: "not maria" });
      expect(res.status, as).toBe(403);
      expect(((await res.json()) as { error: { message: string } }).error.message).toBe("This token sends and posts only as its own person");
    }
    expect(db.prepare("SELECT COUNT(*) FROM messages WHERE body = 'not maria'").pluck().get()).toBe(0);
    expect(db.prepare("SELECT COUNT(*) FROM channel_posts WHERE body = 'not maria'").pluck().get()).toBe(0);
    expect((await send(path, token, { as: "maria", ...target, body: "from maria" })).status).toBe(200);
    const table = path === "/api/send" ? "messages" : "channel_posts";
    expect(db.prepare(`SELECT sender FROM ${table} WHERE body = 'from maria'`).all()).toEqual([{ sender: "maria" }]);
  });

  it("gets 401 once the admin person is removed, and a later person of that name is not theirs", async () => {
    addPerson(db, "owner", "maria", true);
    const token = personToken("owner", "maria");
    removePerson(db, "owner", "maria");
    addPerson(db, "owner", "maria", true);
    expect((await call("/api/token", token)).status).toBe(401);
    expect((await del(token)).status).toBe(401);
    expect(messagesOf(OWNER_ACCOUNT)).toHaveLength(1);
  });

  it("of another account deletes only in that account", async () => {
    addPerson(db, "friend", "maria", true);
    const token = personToken("friend", "maria");
    expect((await del(token)).status).toBe(200);
    expect(messagesOf(friend)).toEqual([]);
    expect(messagesOf(OWNER_ACCOUNT)).toEqual([{ sender: "bob", body: `hello carol ${OWNER_ACCOUNT}` }]);
  });

  it("leaves every other token's GET /api/token answer unchanged", async () => {
    addPerson(db, "owner", "dana");
    expect(await (await call("/api/token", OWNER_TOKEN)).json()).toEqual({ readOnly: false, agentOnly: false });
    expect(await (await call("/api/token", addToken(db, "owner", true).token)).json()).toEqual({ readOnly: true, agentOnly: false });
    expect(await (await call("/api/token", addToken(db, "owner", false, true).token)).json()).toEqual({ readOnly: false, agentOnly: true });
    expect(await (await call("/api/token", personToken("owner", "dana"))).json()).toEqual({ readOnly: false, agentOnly: false, person: "dana" });
  });
});

describe("an existing database", () => {
  it("gains the admin column with every existing person not an admin", () => {
    addPerson(db, "owner", "maria");
    const token = personToken("owner", "maria");
    db.close();
    const raw = new Database(dbFile);
    raw.exec("ALTER TABLE agents DROP COLUMN admin");
    const before = raw.prepare("SELECT * FROM agents ORDER BY id").all();
    raw.close();
    db = openDb(dbFile);
    expect(db.prepare("SELECT * FROM agents ORDER BY id").all()).toEqual(before.map((r) => ({ ...(r as object), admin: 0 })));
    expect(accountForToken(db, token, OWNER_TOKEN)?.person).toMatchObject({ name: "maria", admin: false });
  });
});

describe("message-cp person", () => {
  const root = resolve(import.meta.dirname, "..");
  const cli = (...args: string[]) =>
    spawnSync(join(root, "node_modules/.bin/tsx"), [join(root, "src/cli.ts"), ...args], {
      env: { ...process.env, MESSAGE_CP_DB: dbFile },
      encoding: "utf8",
    });

  it("adds an admin with --admin, marks and unmarks with person admin, and lists admins with a tab and admin", () => {
    const added = cli("person", "add", "maria", "--admin");
    expect(added.status).toBe(0);
    expect(added.stderr).toBe("message-cp: person 'maria', an admin, in account 'owner'. Agents there can message and @mention them.\n");
    expect(cli("person", "add", "dana", "--account", "friend").status).toBe(0);
    expect(cli("person", "add", "lee", "--admin", "--account", "friend").status).toBe(0);
    expect(cli("person", "add", "kim").stderr).toBe("message-cp: person 'kim' in account 'owner'. Agents there can message and @mention them.\n");
    expect(adminRow(OWNER_ACCOUNT, "maria")).toBe(1);
    expect(adminRow(OWNER_ACCOUNT, "kim")).toBe(0);
    expect(adminRow(friend, "lee")).toBe(1);
    expect(adminRow(friend, "dana")).toBe(0);

    const list = cli("person", "list");
    expect(list.status).toBe(0);
    expect(list.stdout.trim().split("\n").map((l) => l.replace(/\tadded [^\t]*/, ""))).toEqual([
      "dana\tfriend",
      "lee\tfriend\tadmin",
      "kim\towner",
      "maria\towner\tadmin",
    ]);

    const marked = cli("person", "admin", "Dana", "--account", "friend");
    expect(marked.status).toBe(0);
    expect(marked.stdout).toBe("");
    expect(marked.stderr).toBe("message-cp: person 'dana' of account 'friend' is now an admin.\n");
    expect(adminRow(friend, "dana")).toBe(1);
    const unmarked = cli("person", "admin", "maria", "--off");
    expect(unmarked.status).toBe(0);
    expect(unmarked.stderr).toBe("message-cp: person 'maria' of account 'owner' is no longer an admin.\n");
    expect(adminRow(OWNER_ACCOUNT, "maria")).toBe(0);
    expect(cli("person", "admin", "lee", "--account", "friend", "--off").status).toBe(0);
    expect(adminRow(friend, "lee")).toBe(0);
    for (const out of [added, list, marked, unmarked]) expect(out.stdout + out.stderr).not.toMatch(/[0-9a-f]{32}/);
  }, 120_000);

  it("fails person admin with exit 1 and a reason for an agent, an unknown name, the wrong account or an unknown account", () => {
    addPerson(db, "friend", "lee", true);
    addPerson(db, "owner", "maria");
    const before = db.prepare("SELECT * FROM agents ORDER BY id").all();
    for (const [args, message] of [
      [["person", "admin", "bob"], "The name 'bob' belongs to an agent, not a person."],
      [["person", "admin", "nobody", "--off"], "No person named 'nobody' in account 'owner'."],
      [["person", "admin", "lee", "--off"], "No person named 'lee' in account 'owner'."],
      [["person", "admin", "maria", "--account", "friend"], "No person named 'maria' in account 'friend'."],
      [["person", "admin", "maria", "--account", "nobody"], "No account named 'nobody'."],
    ] as const) {
      const res = cli(...args);
      expect(res.status, args.join(" ")).toBe(1);
      expect(res.stdout).toBe("");
      expect(res.stderr).toBe(`message-cp: ${message}\n`);
    }
    expect(db.prepare("SELECT * FROM agents ORDER BY id").all()).toEqual(before);
  }, 120_000);

  it("prints its usage and exits 2 for a misused flag", () => {
    for (const args of [
      ["person", "admin"],
      ["person", "admin", "--off"],
      ["person", "admin", "maria", "--admin"],
      ["person", "admin", "maria", "--off", "--off"],
      ["person", "add", "maria", "--off"],
      ["person", "add", "maria", "--admin", "--admin"],
      ["person", "remove", "maria", "--admin"],
      ["person", "list", "--admin"],
    ]) {
      const res = cli(...args);
      expect(res.status, args.join(" ")).toBe(2);
      expect(res.stderr).toContain("message-cp person admin <name> [--off] [--account <name>]");
    }
    expect(listPeople(db)).toEqual([]);
  }, 120_000);
});
