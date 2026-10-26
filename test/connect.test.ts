import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { accountForToken, addAccount, listAccounts, listTokens } from "../src/accounts.js";
import { addPerson, identityOf, registerAgent, removeAgent } from "../src/agents.js";
import { ConnectError, clientSetup, connectAgent, mcpEndpoint } from "../src/connect.js";
import { OWNER_ACCOUNT, openDb, type AccountId, type Db } from "../src/db.js";
import { startHttp, type HttpServer } from "../src/http.js";
import { restorableSession, saveSession } from "../src/sessions.js";

// `message-cp connect`: an agent, its key and an agent token in one step, printed as a ready client setup.
const TOKEN = "owner-token";
let dbFile: string;
let db: Db;
let friend: AccountId;
let http: HttpServer | undefined;
const clients: Client[] = [];

beforeEach(() => {
  dbFile = join(mkdtempSync(join(tmpdir(), "message-cp-connect-")), "db.sqlite");
  db = openDb(dbFile);
  addAccount(db, "friend");
  friend = listAccounts(db).find((a) => a.name === "friend")!.id;
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => {})));
  await http?.close();
  http = undefined;
  db.close();
});

const rows = (sql: string, ...p: unknown[]) => db.prepare(sql).all(...p);
const everything = () => ({
  agents: rows("SELECT * FROM agents ORDER BY id"),
  tokens: rows("SELECT * FROM tokens ORDER BY id"),
});

const root = resolve(import.meta.dirname, "..");
const cli = (...args: string[]) =>
  spawnSync(join(root, "node_modules/.bin/tsx"), [join(root, "src/cli.ts"), ...args], {
    env: { ...process.env, MESSAGE_CP_DB: dbFile },
    encoding: "utf8",
  });

/** The printed `claude mcp add` command, split back into its arguments, and the printed JSON. */
function parse(stdout: string) {
  const [command, json] = stdout.split("\n\n");
  const args = Array.from(command!.matchAll(/'((?:[^']|'\\'')*)'|(\S+)/g), (m) => (m[1] !== undefined ? m[1].replace(/'\\''/g, "'") : m[2]!));
  const headers = Object.fromEntries(
    args.flatMap((a, i) => (args[i - 1] === "--header" ? [a.split(/: (.*)/s).slice(0, 2) as [string, string]] : [])),
  );
  return { args, headers, json: JSON.parse(json!) };
}

describe("mcpEndpoint", () => {
  it("builds /mcp from the parsed URL, with a trailing /mcp the same as none", () => {
    expect(mcpEndpoint("https://message-cp.example.com").href).toBe("https://message-cp.example.com/mcp");
    expect(mcpEndpoint("https://message-cp.example.com/").href).toBe("https://message-cp.example.com/mcp");
    expect(mcpEndpoint("https://message-cp.example.com/mcp").href).toBe("https://message-cp.example.com/mcp");
    expect(mcpEndpoint("https://h.example/base//").href).toBe("https://h.example/base/mcp");
    expect(mcpEndpoint("https://h.example:8443/base/mcp/").href).toBe("https://h.example:8443/base/mcp");
    expect(mcpEndpoint("http://127.0.0.1:8787").href).toBe("http://127.0.0.1:8787/mcp");
    expect(mcpEndpoint("http://[::1]:8787/").href).toBe("http://[::1]:8787/mcp");
  });

  it("refuses plain http but to a literal loopback address, credentials, a query, a fragment and a non-URL", () => {
    for (const bad of [
      "http://localhost@evil/",
      "https://@/",
      "https://h/?x=/o/",
      "https://h/#/o/",
      "https://h.example/?",
      "https://h.example/#",
      "http://localhost:8787",
      "http://example.com",
      "http://10.0.0.1",
      "https://user@h.example",
      "https://user:pass@h.example",
      "ftp://h.example",
      "h.example",
      "",
    ]) {
      expect(() => mcpEndpoint(bad), bad).toThrow(ConnectError);
    }
  });
});

describe("connectAgent", () => {
  it("makes a new agent with a generated key and an agent token of the account", () => {
    const c = connectAgent(db, "owner", "Demo", false);
    expect(c).toEqual({
      name: "Demo",
      account: "owner",
      reset: false,
      key: expect.stringMatching(/^[0-9a-f]{64}$/),
      tokenId: expect.any(Number),
      token: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    const identity = identityOf(db, OWNER_ACCOUNT, "demo")!;
    expect(accountForToken(db, c.token, TOKEN)).toEqual({
      account: OWNER_ACCOUNT,
      readOnly: false,
      agentOnly: true,
      agent: { ...identity, name: "Demo" },
    });
    expect(listTokens(db).find((t) => t.id === c.tokenId)).toMatchObject({ account: "owner", kind: "agent" });
    expect(() => registerAgent(db, OWNER_ACCOUNT, "demo", undefined, c.key)).not.toThrow();
    // Neither the key nor the token is stored, only their hashes.
    expect(JSON.stringify(everything())).not.toContain(c.key);
    expect(JSON.stringify(everything())).not.toContain(c.token);
  });

  it("refuses an existing agent without newKey, saying why, and changes nothing", () => {
    const { key } = registerAgent(db, OWNER_ACCOUNT, "demo", "x");
    const before = everything();
    expect(() => connectAgent(db, "owner", "DEMO", false)).toThrow(
      "Agent 'demo' of account 'owner' already exists. Its key is stored only as a hash, so it cannot be shown again; pass --new-key to give it a new one, which ends its current sessions.",
    );
    expect(everything()).toEqual(before);
    expect(() => registerAgent(db, OWNER_ACCOUNT, "demo", undefined, key)).not.toThrow();
  });

  it("with newKey, resets the key as agent key reset does and ends the agent's sessions", () => {
    const { key } = registerAgent(db, OWNER_ACCOUNT, "demo", "x");
    const identity = identityOf(db, OWNER_ACCOUNT, "demo")!;
    saveSession(db, "s", OWNER_ACCOUNT, identity);
    const c = connectAgent(db, "owner", "demo", true);
    expect(c).toMatchObject({ name: "demo", reset: true });
    expect(() => registerAgent(db, OWNER_ACCOUNT, "demo", undefined, key)).toThrow(/has a key/);
    expect(restorableSession(db, "s", OWNER_ACCOUNT, 0)).toBeUndefined();
    expect(identityOf(db, OWNER_ACCOUNT, "demo")).toMatchObject({ id: identity.id, registeredAt: identity.registeredAt });
    expect(() => registerAgent(db, OWNER_ACCOUNT, "demo", undefined, c.key)).not.toThrow();
  });

  it("makes a removed agent's name a new agent", () => {
    removeAgent(db, OWNER_ACCOUNT, "demo", registerAgent(db, OWNER_ACCOUNT, "demo", "x").key);
    expect(connectAgent(db, "owner", "demo", false)).toMatchObject({ name: "demo", reset: false });
  });

  it("refuses a person, an invalid name and an unknown account, and changes nothing", () => {
    addPerson(db, "owner", "colin");
    const before = everything();
    for (const newKey of [false, true]) {
      expect(() => connectAgent(db, "owner", "Colin", newKey)).toThrow("The name 'colin' belongs to a person, not an agent.");
      expect(() => connectAgent(db, "owner", "no spaces", newKey)).toThrow(/Invalid name/);
      expect(() => connectAgent(db, "owner", "all", newKey)).toThrow(/reserved/);
      expect(() => connectAgent(db, "nobody", "demo", newKey)).toThrow("No account named 'nobody'.");
    }
    expect(everything()).toEqual(before);
  });

  it("leaves no agent or key change behind when making the token fails", () => {
    const { key } = registerAgent(db, OWNER_ACCOUNT, "old", "x");
    const before = everything();
    db.exec("CREATE TEMP TRIGGER fail_token BEFORE INSERT ON tokens BEGIN SELECT RAISE(ABORT, 'no tokens'); END");
    try {
      expect(() => connectAgent(db, "owner", "demo", false)).toThrow("no tokens");
      expect(() => connectAgent(db, "owner", "old", true)).toThrow("no tokens");
    } finally {
      db.exec("DROP TRIGGER fail_token");
    }
    expect(everything()).toEqual(before);
    expect(() => registerAgent(db, OWNER_ACCOUNT, "old", undefined, key)).not.toThrow();
  });

  it("leaves another account's agent of the same name, its key and its sessions untouched", () => {
    const theirs = registerAgent(db, friend, "demo", "theirs");
    const identity = identityOf(db, friend, "demo")!;
    saveSession(db, "friend-session", friend, identity);
    registerAgent(db, OWNER_ACCOUNT, "demo", "ours");
    const before = rows("SELECT * FROM agents WHERE account_id = ? ORDER BY id", friend);
    const friendTokens = rows("SELECT * FROM tokens WHERE account_id = ?", friend);

    const c = connectAgent(db, "owner", "demo", true);
    expect(accountForToken(db, c.token, TOKEN)?.account).toBe(OWNER_ACCOUNT);
    expect(rows("SELECT * FROM agents WHERE account_id = ? ORDER BY id", friend)).toEqual(before);
    expect(rows("SELECT * FROM tokens WHERE account_id = ?", friend)).toEqual(friendTokens);
    expect(restorableSession(db, "friend-session", friend, 0)).toEqual(identity);
    expect(() => registerAgent(db, friend, "demo", undefined, theirs.key)).not.toThrow();

    // And the other way: a new agent in friend leaves owner's agent of the same name alone.
    const ours = rows("SELECT * FROM agents WHERE account_id = ? ORDER BY id", OWNER_ACCOUNT);
    const fresh = connectAgent(db, "friend", "other", false);
    expect(accountForToken(db, fresh.token, TOKEN)?.account).toBe(friend);
    expect(rows("SELECT * FROM agents WHERE account_id = ? ORDER BY id", OWNER_ACCOUNT)).toEqual(ours);
  });

  it("finds the account and agent by index", () => {
    const plan = (sql: string) =>
      db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...Array.from(sql.matchAll(/\?/g), () => null))
        .map((r) => (r as { detail: string }).detail);
    expect(plan("SELECT id, name FROM accounts WHERE name = ?")).toEqual([expect.stringMatching(/^SEARCH accounts USING /)]);
    expect(plan("SELECT id, name, person FROM agents WHERE account_id = ? AND name = ? AND removed_at IS NULL")).toEqual([
      "SEARCH agents USING INDEX sqlite_autoindex_agents_1 (account_id=? AND name=?)",
    ]);
  });
});

describe("clientSetup", () => {
  it("shell-quotes every argument and gives the same URL and headers as JSON", () => {
    const out = clientSetup(new URL("https://h.example/a b/mcp"), { name: "o'k", key: "k$(x)", token: "t" });
    const { args, headers, json } = parse(out);
    expect(args.slice(0, 6)).toEqual(["claude", "mcp", "add", "--transport", "http", "message-cp"]);
    expect(args[6]).toBe("https://h.example/a%20b/mcp");
    expect(headers).toEqual({ Authorization: "Bearer t", "X-Message-CP-Agent": "o'k", "X-Message-CP-Agent-Key": "k$(x)" });
    expect(out).toContain(`--header 'X-Message-CP-Agent-Key: k$(x)'`);
    expect(json).toEqual({ mcpServers: { "message-cp": { type: "http", url: args[6], headers } } });
  });
});

describe("message-cp connect", () => {
  it("prints a setup that opens a session acting as the agent from its first request", async () => {
    http = await startHttp(db, { token: TOKEN, port: 0 });
    const res = cli("connect", "demo", "--url", `http://127.0.0.1:${http.port}`);
    expect(res.status).toBe(0);
    const { args, headers, json } = parse(res.stdout);
    expect(args[6]).toBe(`http://127.0.0.1:${http.port}/mcp`);
    expect(json.mcpServers["message-cp"]).toEqual({ type: "http", url: args[6], headers });
    expect(headers["X-Message-CP-Agent"]).toBe("demo");
    const token = headers.Authorization!.replace(/^Bearer /, "");
    const key = headers["X-Message-CP-Agent-Key"]!;

    // Nothing secret on stderr: it names the agent, the account, the token id and how to revoke it.
    const tokenId = listTokens(db).find((t) => t.kind === "agent")!.id;
    expect(res.stderr).toBe(
      "message-cp: agent 'demo' in account 'owner'.\n" +
        `message-cp: agent token ${tokenId} for account 'owner'. The output holds this token and the agent's key, shown only now; keep them. To revoke the token: message-cp token list, then message-cp token revoke ${tokenId}.\n`,
    );
    expect(res.stderr).not.toContain(token);
    expect(res.stderr).not.toContain(key);
    expect(res.stderr).not.toMatch(/[0-9a-f]{32}/);

    // Exactly the printed URL and headers, as a client configured from the JSON sends them.
    const client = new Client({ name: "test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(json.mcpServers["message-cp"].url), { requestInit: { headers } }));
    clients.push(client);
    const inbox = (await client.callTool({ name: "read_inbox", arguments: {} })) as { isError?: boolean };
    expect(inbox.isError).toBeFalsy();
    const status = (await client.callTool({ name: "set_status", arguments: { text: "here" } })) as { isError?: boolean };
    expect(status.isError).toBeFalsy();
    expect(rows("SELECT name, status FROM agents WHERE name = 'demo'")).toEqual([{ name: "demo", status: "here" }]);

    // The token cannot act as a person.
    addPerson(db, "owner", "colin");
    const send = await fetch(`http://127.0.0.1:${http.port}/api/send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ as: "colin", to: "demo", body: "hi" }),
    });
    expect(send.status).toBe(403);
  }, 60_000);

  it("refuses an existing agent without --new-key, and with it resets the key and says so", () => {
    const { key } = registerAgent(db, OWNER_ACCOUNT, "demo", "x");
    const before = everything();
    const refused = cli("connect", "demo", "--url", "https://h.example");
    expect(refused.status).toBe(1);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).toContain("already exists. Its key is stored only as a hash, so it cannot be shown again; pass --new-key");
    expect(everything()).toEqual(before);

    const res = cli("connect", "demo", "--new-key", "--url", "https://h.example");
    expect(res.status).toBe(0);
    expect(res.stderr.split("\n")[0]).toBe(
      "message-cp: new key for agent 'demo' of account 'owner'; its old key no longer works and its current sessions have ended.",
    );
    const { headers } = parse(res.stdout);
    expect(headers["X-Message-CP-Agent-Key"]).not.toBe(key);
    expect(() => registerAgent(db, OWNER_ACCOUNT, "demo", undefined, headers["X-Message-CP-Agent-Key"])).not.toThrow();
    expect(res.stderr).not.toContain(headers["X-Message-CP-Agent-Key"]!);
  }, 60_000);

  it("uses --account for the agent and the token", () => {
    const res = cli("connect", "demo", "--account", "friend", "--url", "https://h.example");
    expect(res.status).toBe(0);
    expect(res.stderr).toContain("agent 'demo' in account 'friend'");
    const token = parse(res.stdout).headers.Authorization!.replace(/^Bearer /, "");
    expect(accountForToken(db, token, TOKEN)).toEqual({
      account: friend,
      readOnly: false,
      agentOnly: true,
      agent: { ...identityOf(db, friend, "demo")!, name: "demo" },
    });
    expect(identityOf(db, OWNER_ACCOUNT, "demo")).toBeUndefined();
  }, 60_000);

  it("fails with exit 1 and a reason for a person, an invalid name, an unknown account or a refused URL, and changes nothing", () => {
    addPerson(db, "owner", "colin");
    const before = everything();
    for (const [args, message] of [
      [["connect", "colin", "--url", "https://h.example"], "The name 'colin' belongs to a person, not an agent."],
      [["connect", "colin", "--new-key", "--url", "https://h.example"], "The name 'colin' belongs to a person, not an agent."],
      [["connect", "a.b", "--url", "https://h.example"], "Invalid name"],
      [["connect", "demo", "--account", "nobody", "--url", "https://h.example"], "No account named 'nobody'."],
      [["connect", "demo", "--url", "http://localhost@evil/"], "--url must be https"],
      [["connect", "demo", "--url", "https://h/?x=/o/"], "--url must not carry"],
      [["connect", "demo", "--url", "https://h/#/o/"], "--url must not carry"],
      [["connect", "demo", "--url", "https://@/"], "--url is not a URL"],
    ] as const) {
      const res = cli(...args);
      expect(res.status, args.join(" ")).toBe(1);
      expect(res.stdout).toBe("");
      expect(res.stderr).toContain(message);
    }
    expect(everything()).toEqual(before);
  }, 120_000);

  it("prints its usage and exits 2 for anything else", () => {
    for (const args of [
      ["connect"],
      ["connect", "demo"],
      ["connect", "--url", "https://h.example"],
      ["connect", "demo", "--url"],
      ["connect", "demo", "--url", "https://h.example", "--url", "https://h.example"],
      ["connect", "demo", "--url", "https://h.example", "--new-key", "--new-key"],
      ["connect", "demo", "--url", "https://h.example", "--key", "x"],
    ]) {
      const res = cli(...args);
      expect(res.status, args.join(" ")).toBe(2);
      expect(res.stdout).toBe("");
      expect(res.stderr).toContain("usage: message-cp connect <agent> --url <public url> [--account <name>] [--new-key]");
    }
  }, 120_000);
});
