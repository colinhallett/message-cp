import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addAccount, addToken, listAccounts } from "../src/accounts.js";
import { addPerson, listServerAgents, purgeAgent, registerAgent, removeAgent } from "../src/agents.js";
import { OWNER_ACCOUNT, openDb, type AccountId, type Db } from "../src/db.js";

// `message-cp agent list`: every account's current agents, or one account's, with no key, hash or token.
let dbFile: string;
let db: Db;
let friend: AccountId;
const keys: string[] = [];

beforeEach(() => {
  dbFile = join(mkdtempSync(join(tmpdir(), "message-cp-agent-list-")), "db.sqlite");
  db = openDb(dbFile);
  addAccount(db, "friend");
  friend = listAccounts(db).find((a) => a.name === "friend")!.id;
  keys.length = 0;
  keys.push(registerAgent(db, OWNER_ACCOUNT, "zed", "x").key!);
  keys.push(registerAgent(db, OWNER_ACCOUNT, "alice", "x").key!);
  keys.push(registerAgent(db, friend, "bob", "x").key!);
  keys.push(registerAgent(db, friend, "alice", "x").key!);
  removeAgent(db, OWNER_ACCOUNT, "erin", registerAgent(db, OWNER_ACCOUNT, "erin", "x").key);
  registerAgent(db, friend, "gone", "x");
  purgeAgent(db, "friend", "gone");
  addPerson(db, "owner", "colin");
  addPerson(db, "friend", "dana");
});

afterEach(() => db.close());

const iso = expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);

describe("listServerAgents", () => {
  it("returns every account's current agents by account then name, without people or removed agents", () => {
    expect(listServerAgents(db)).toEqual([
      { name: "alice", account: "friend", registeredAt: iso, lastSeen: iso },
      { name: "bob", account: "friend", registeredAt: iso, lastSeen: iso },
      { name: "alice", account: "owner", registeredAt: iso, lastSeen: iso },
      { name: "zed", account: "owner", registeredAt: iso, lastSeen: iso },
    ]);
  });

  it("returns only the named account's agents", () => {
    expect(listServerAgents(db, "owner").map((a) => a.name)).toEqual(["alice", "zed"]);
    expect(listServerAgents(db, "friend").map((a) => a.name)).toEqual(["alice", "bob"]);
    addAccount(db, "empty");
    expect(listServerAgents(db, "empty")).toEqual([]);
  });

  it("refuses an unknown account", () => {
    expect(() => listServerAgents(db, "nobody")).toThrow("No account named 'nobody'.");
  });
});

describe("message-cp agent list", () => {
  const root = resolve(import.meta.dirname, "..");
  const cli = (...args: string[]) =>
    spawnSync(join(root, "node_modules/.bin/tsx"), [join(root, "src/cli.ts"), ...args], {
      env: { ...process.env, MESSAGE_CP_DB: dbFile },
      encoding: "utf8",
    });
  const line = (name: string, account: string) => new RegExp(`^${name}\\t${account}\\tregistered \\S+Z\\tlast seen \\S+Z$`);

  it("prints one line per current agent, and only one account's with --account, and no secret", () => {
    const token = addToken(db, "owner").token;
    const all = cli("agent", "list");
    expect(all.status).toBe(0);
    expect(all.stderr).toBe("");
    const lines = all.stdout.trimEnd().split("\n");
    expect(lines).toHaveLength(4);
    [
      ["alice", "friend"],
      ["bob", "friend"],
      ["alice", "owner"],
      ["zed", "owner"],
    ].forEach(([name, account], i) => expect(lines[i]).toMatch(line(name!, account!)));
    for (const secret of [...keys, token]) expect(all.stdout).not.toContain(secret);
    expect(all.stdout).not.toMatch(/[0-9a-f]{32}/);

    const one = cli("agent", "list", "--account", "friend");
    expect(one.status).toBe(0);
    const friendLines = one.stdout.trimEnd().split("\n");
    expect(friendLines).toHaveLength(2);
    expect(friendLines[0]).toMatch(line("alice", "friend"));
    expect(friendLines[1]).toMatch(line("bob", "friend"));
  }, 60_000);

  it("fails with exit 1 for an unknown account, changing nothing", () => {
    const before = db.prepare("SELECT * FROM agents ORDER BY id").all();
    const res = cli("agent", "list", "--account", "nobody");
    expect(res.status).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toBe("message-cp: No account named 'nobody'.\n");
    expect(db.prepare("SELECT * FROM agents ORDER BY id").all()).toEqual(before);
  }, 60_000);

  it("prints the usage and exits 2 for a bad option or a stray argument", () => {
    for (const args of [["list", "alice"], ["list", "--account"], ["list", "--account", "owner", "--account", "friend"], ["list", "--bogus", "x"]]) {
      const res = cli("agent", ...args);
      expect(res.status).toBe(2);
      expect(res.stdout).toBe("");
      expect(res.stderr).toMatch(/^usage: message-cp agent list \[--account <name>\] \| /);
    }
  }, 60_000);
});
