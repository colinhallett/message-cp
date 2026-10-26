import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { accountForToken, addAccount, addToken, listAccounts } from "../src/accounts.js";
import { identityOf, purgeAgent, registerAgent, removeAgent, resetAgentKey } from "../src/agents.js";
import { connectAgent, type Connection } from "../src/connect.js";
import { OWNER_ACCOUNT, openDb, type AccountId, type Db } from "../src/db.js";
import { startHttp, type HttpServer } from "../src/http.js";
import { sendMessage } from "../src/messages.js";
import { saveSession } from "../src/sessions.js";

// The agent token `connect` makes is bound to its agent: the token alone acts as that agent, and as no other name.
const TOKEN = "owner-token";
let dbFile: string;
let db: Db;
let http: HttpServer;
let friend: AccountId;
let writer: Connection;
const clients: Client[] = [];

beforeEach(async () => {
  dbFile = join(mkdtempSync(join(tmpdir(), "message-cp-bound-")), "db.sqlite");
  db = openDb(dbFile);
  addAccount(db, "friend");
  friend = listAccounts(db).find((a) => a.name === "friend")!.id;
  writer = connectAgent(db, "owner", "writer", false);
  http = await startHttp(db, { token: TOKEN, port: 0, waitHoldMs: 200 });
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => {})));
  await http.close();
  db.close();
});

const base = () => `http://127.0.0.1:${http.port}`;
const auth = (token = writer.token) => ({ Authorization: `Bearer ${token}` });
const rows = (sql: string, ...p: unknown[]) => db.prepare(sql).all(...p);
// Everything but when rows were last used, which every call, refused or not, moves on.
const everything = () => ({
  agents: rows("SELECT id, account_id, name, bio, registered_at, key_hash, instance, removed_at, removed_name, person, status FROM agents ORDER BY id"),
  tokens: rows("SELECT * FROM tokens ORDER BY id"),
  messages: rows("SELECT * FROM messages ORDER BY id"),
  sessions: rows("SELECT hash, account_id, agent_id, registered_at, instance, ended FROM http_sessions ORDER BY hash"),
});

async function open(headers: Record<string, string> = auth()): Promise<Client> {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base()}/mcp`), { requestInit: { headers } }));
  clients.push(client);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  return { isError: !!res.isError, text: res.content[0]!.text };
}

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } },
};
const mcpPost = (headers: Record<string, string>, body: unknown = initialize) =>
  fetch(`${base()}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });

/** A session of the owner's full token registered as `name`, and its id. */
async function sessionOf(name: string, key?: string): Promise<string> {
  const res = await mcpPost(auth(TOKEN));
  const sid = res.headers.get("mcp-session-id")!;
  await res.text();
  const listed = await mcpPost(
    { ...auth(TOKEN), "mcp-session-id": sid },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "register", arguments: { name, bio: "x", key } } },
  );
  expect(await listed.text()).not.toContain("isError\":true");
  return sid;
}

const toolsList = (sid: string, token = writer.token) =>
  mcpPost({ ...auth(token), "mcp-session-id": sid }, { jsonrpc: "2.0", id: 9, method: "tools/list" });

describe("accountForToken", () => {
  it("returns the bound agent's registration, and nothing once the agent is removed", () => {
    expect(accountForToken(db, writer.token, TOKEN)).toEqual({
      account: OWNER_ACCOUNT,
      readOnly: false,
      agentOnly: true,
      agent: { ...identityOf(db, OWNER_ACCOUNT, "writer")!, name: "writer" },
    });
    // A bound row is still read-only and agent-only, so a server from before bound tokens takes it for an agent token.
    expect(rows("SELECT read_only, agent_only FROM tokens WHERE id = ?", writer.tokenId)).toEqual([{ read_only: 1, agent_only: 1 }]);
    removeAgent(db, OWNER_ACCOUNT, "writer", writer.key);
    expect(accountForToken(db, writer.token, TOKEN)).toBeUndefined();
  });

  it("keeps an unbound agent token, and every other kind, as it was", () => {
    const unbound = addToken(db, "owner", false, true);
    expect(accountForToken(db, unbound.token, TOKEN)).toEqual({ account: OWNER_ACCOUNT, readOnly: false, agentOnly: true });
    expect(accountForToken(db, addToken(db, "owner").token, TOKEN)).toEqual({ account: OWNER_ACCOUNT, readOnly: false, agentOnly: false });
    expect(accountForToken(db, addToken(db, "owner", true).token, TOKEN)).toEqual({ account: OWNER_ACCOUNT, readOnly: true, agentOnly: false });
    expect(accountForToken(db, TOKEN, TOKEN)).toEqual({ account: OWNER_ACCOUNT, readOnly: false, agentOnly: false });
  });

  it("never binds a token to another account's agent", () => {
    registerAgent(db, friend, "theirs", "x");
    const theirs = identityOf(db, friend, "theirs")!;
    expect(() => addToken(db, "owner", false, true, theirs.id)).toThrow("No live agent");
    // A row pointing across accounts anyway (made by hand) gets nothing.
    const t = addToken(db, "owner", false, true);
    db.prepare("UPDATE tokens SET agent_id = ? WHERE id = ?").run(theirs.id, t.id);
    expect(accountForToken(db, t.token, TOKEN)).toBeUndefined();
  });

  it("finds the token by its hash and the agent by its primary key", () => {
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT tokens.account_id, tokens.read_only, tokens.agent_only, tokens.agent_id,
           agents.id, agents.registered_at, agents.instance, agents.name
         FROM tokens LEFT JOIN agents ON agents.id = tokens.agent_id AND agents.account_id = tokens.account_id
           AND agents.removed_at IS NULL AND agents.person = 0
         WHERE tokens.hash = ? AND tokens.revoked_at IS NULL`,
      )
      .all("x")
      .map((r) => (r as { detail: string }).detail);
    expect(plan).toEqual([
      expect.stringMatching(/^SEARCH tokens USING INDEX sqlite_autoindex_tokens_\d \(hash=\?\)$/),
      expect.stringMatching(/^SEARCH agents USING INTEGER PRIMARY KEY \(rowid=\?\) LEFT-JOIN$/),
    ]);
  });
});

describe("a session with only a bound token", () => {
  it("is the agent from its initialize request: read_inbox, send_message, set_status, wait_for_mail and ask work", async () => {
    const bobKey = registerAgent(db, OWNER_ACCOUNT, "bob", "answers").key!;
    sendMessage(db, OWNER_ACCOUNT, "bob", "writer", "hello writer");
    const client = await open();
    const inbox = await call(client, "read_inbox");
    expect(inbox.isError).toBe(false);
    expect(JSON.parse(inbox.text)).toEqual([expect.objectContaining({ from: "bob", body: "hello writer" })]);
    expect((await call(client, "send_message", { to: "bob", body: "hi bob" })).isError).toBe(false);
    expect((await call(client, "set_status", { text: "writing" })).isError).toBe(false);
    expect(rows("SELECT status FROM agents WHERE name = 'writer'")).toEqual([{ status: "writing" }]);
    const waited = await call(client, "wait_for_mail", { timeout_seconds: 1 });
    expect(waited).toEqual({ isError: false, text: expect.stringContaining('"unread": null') });

    // ask: bob answers the question as soon as it is stored.
    const asking = call(client, "ask", { to: "bob", body: "ready?", timeout_seconds: 10 });
    let question: { id: number } | undefined;
    while (!(question = db.prepare("SELECT id FROM messages WHERE body = 'ready?'").get() as { id: number } | undefined)) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const bob = await open({ ...auth(TOKEN), "X-Message-CP-Agent": "bob", "X-Message-CP-Agent-Key": bobKey });
    expect((await call(bob, "send_message", { to: "writer", body: "yes", in_reply_to: question.id })).isError).toBe(false);
    const asked = await asking;
    expect(asked.isError).toBe(false);
    expect(JSON.parse(asked.text).reply).toMatchObject({ from: "bob", body: "yes" });
  }, 30_000);

  it("works the same with connect's headers naming its own agent and key", async () => {
    const client = await open({ ...auth(), "X-Message-CP-Agent": "WRITER", "X-Message-CP-Agent-Key": writer.key });
    expect((await call(client, "set_status", { text: "here" })).isError).toBe(false);
  });

  it("refuses register for any name, its own included, and changes nothing", async () => {
    registerAgent(db, OWNER_ACCOUNT, "bob", "x", "bob-key");
    const client = await open();
    const before = everything();
    for (const args of [
      { name: "writer", bio: "x", key: writer.key },
      { name: "bob", bio: "x", key: "bob-key" },
      { name: "fresh", bio: "x" },
    ]) {
      const res = await call(client, "register", args);
      expect(res).toEqual({ isError: true, text: "This token is already agent 'writer'; it cannot register or remove another name." });
    }
    expect(everything()).toEqual(before);
    expect((await call(client, "set_status", { text: "still writer" })).isError).toBe(false);
  });

  it("refuses unregister with a name, with or without a key, and changes nothing", async () => {
    registerAgent(db, OWNER_ACCOUNT, "bob", "x", "bob-key");
    registerAgent(db, OWNER_ACCOUNT, "keyless", "x");
    const client = await open();
    const before = everything();
    for (const args of [{ name: "bob", key: "bob-key" }, { name: "bob" }, { name: "writer", key: writer.key }]) {
      expect((await call(client, "unregister", args)).isError).toBe(true);
    }
    expect(everything()).toEqual(before);
  });

  it("refuses X-Message-CP-Agent naming another agent with 403, changing nothing", async () => {
    const bobKey = registerAgent(db, OWNER_ACCOUNT, "bob", "x").key!;
    const before = everything();
    const res = await mcpPost({ ...auth(), "X-Message-CP-Agent": "bob", "X-Message-CP-Agent-Key": bobKey });
    expect(res.status).toBe(403);
    expect(res.headers.get("connection")).toBe("close");
    expect(await res.text()).not.toContain(bobKey);
    expect(everything()).toEqual(before);
    expect(http.sessionCount()).toBe(0);
  });

  it("refuses a held session of another agent or of none with 404", async () => {
    registerAgent(db, OWNER_ACCOUNT, "bob", "x", "bob-key");
    const bobs = await sessionOf("bob", "bob-key");
    const none = (await mcpPost(auth(TOKEN))).headers.get("mcp-session-id")!;
    for (const sid of [bobs, none]) {
      const res = await toolsList(sid);
      expect(res.status).toBe(404);
      expect(await res.text()).toContain("Unknown session");
    }
    // The owner's token still uses them.
    expect((await toolsList(bobs, TOKEN)).status).toBe(200);
  });

  it("uses a held session of its own agent", async () => {
    const own = await sessionOf("writer", writer.key);
    expect((await toolsList(own)).status).toBe(200);
  });

  it("refuses to restore another agent's session, and restores its own", async () => {
    registerAgent(db, OWNER_ACCOUNT, "bob", "x");
    saveSession(db, "bobs-session", OWNER_ACCOUNT, identityOf(db, OWNER_ACCOUNT, "bob")!);
    saveSession(db, "writers-session", OWNER_ACCOUNT, identityOf(db, OWNER_ACCOUNT, "writer")!);
    const before = everything();
    const refused = await toolsList("bobs-session");
    expect(refused.status).toBe(404);
    expect(refused.headers.get("connection")).toBe("close");
    expect(http.sessionCount()).toBe(0);
    expect(everything()).toEqual(before);
    // The token of the session's account can still restore it.
    expect((await toolsList("bobs-session", TOKEN)).status).toBe(200);
    expect((await toolsList("writers-session")).status).toBe(200);
  });

  it("gets 401 on every request once its agent is removed, by unregister or agent remove", async () => {
    const client = await open();
    expect((await call(client, "unregister")).isError).toBe(false);
    expect((await mcpPost(auth())).status).toBe(401);
    expect((await fetch(`${base()}/wait`, { headers: auth() })).status).toBe(401);

    const other = connectAgent(db, "owner", "other", false);
    expect((await mcpPost(auth(other.token))).status).toBe(200);
    purgeAgent(db, "owner", "other");
    expect((await mcpPost(auth(other.token))).status).toBe(401);
    expect((await fetch(`${base()}/api/token`, { headers: auth(other.token) })).status).toBe(401);
  });

  it("stops acting as the agent on a session opened before its key was reset, and a new session picks up the new identity", async () => {
    const client = await open();
    expect((await call(client, "set_status", { text: "one" })).isError).toBe(false);
    resetAgentKey(db, "owner", "writer");
    // The session holds the old registration, which is no longer the token's agent, so it looks like one that does not exist.
    await expect(call(client, "set_status", { text: "two" })).rejects.toThrow("Unknown session");
    expect(rows("SELECT status FROM agents WHERE name = 'writer'")).toEqual([{ status: "one" }]);
    const again = await open();
    expect((await call(again, "set_status", { text: "three" })).isError).toBe(false);
  });

  it("never acts in another account", async () => {
    registerAgent(db, friend, "writer", "theirs");
    const client = await open();
    expect((await call(client, "set_status", { text: "ours" })).isError).toBe(false);
    expect(rows("SELECT status FROM agents WHERE account_id = ? AND name = 'writer'", friend)).toEqual([{ status: null }]);
  });
});

describe("GET /wait with a bound token", () => {
  const wait = (query: string) => fetch(`${base()}/wait${query}`, { headers: auth() });

  it("answers for its own agent, whether agent names it or is left out", async () => {
    expect((await wait("")).status).toBe(204);
    expect((await wait("?agent=Writer")).status).toBe(204);
    registerAgent(db, OWNER_ACCOUNT, "bob", "x");
    sendMessage(db, OWNER_ACCOUNT, "bob", "writer", "mail");
    for (const query of ["", "?agent=writer"]) {
      const res = await wait(query);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("1 unread message");
    }
  });

  it("answers 404 for another agent, even one with mail", async () => {
    registerAgent(db, OWNER_ACCOUNT, "bob", "x");
    sendMessage(db, OWNER_ACCOUNT, "writer", "bob", "for bob");
    const res = await wait("?agent=bob");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("No such agent");
  });

  it("leaves an unbound agent token waiting for any name, and needing one", async () => {
    const unbound = addToken(db, "owner", false, true).token;
    registerAgent(db, OWNER_ACCOUNT, "bob", "x");
    expect((await fetch(`${base()}/wait?agent=bob`, { headers: auth(unbound) })).status).toBe(204);
    expect((await fetch(`${base()}/wait`, { headers: auth(unbound) })).status).toBe(404);
  });
});
