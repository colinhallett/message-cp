import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccountError, accountForToken, addAccount, addToken, listAccounts, listTokens, revokeToken } from "../src/accounts.js";
import { OWNER_ACCOUNT, openDb, type Db } from "../src/db.js";
import { startHttp, type HttpServer } from "../src/http.js";

// Two accounts on one HTTP server: the owner's (MESSAGE_CP_HTTP_TOKEN) and a friend's (a token from `account add`).
const OWNER_TOKEN = "owner-token";
let db: Db;
let http: HttpServer;
let friendToken: string;
let open: Client[] = [];

beforeEach(async () => {
  db = openDb(join(mkdtempSync(join(tmpdir(), "message-cp-accounts-")), "db.sqlite"));
  friendToken = addAccount(db, "friend").token;
  http = await startHttp(db, { token: OWNER_TOKEN, port: 0, waitHoldMs: 1500 });
});

afterEach(async () => {
  for (const c of open) await c.close().catch(() => {});
  open = [];
  await http.close();
  db.close();
});

const base = () => `http://127.0.0.1:${http.port}`;

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base()}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
  );
  open.push(client);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  const text = res.content[0].text;
  return { isError: !!res.isError, text, json: res.isError ? undefined : JSON.parse(text) };
}

/** A session of the account with `token`, registered as `name`; returns the client and the agent's key. */
async function agent(token: string, name: string) {
  const client = await connect(token);
  const res = await call(client, "register", { name, bio: `${name} of ${token === OWNER_TOKEN ? "owner" : "friend"}` });
  expect(res.isError).toBe(false);
  return { client, key: res.json.key as string };
}

const wait = (agentName: string, token: string) =>
  fetch(`${base()}/wait?agent=${agentName}`, { headers: { Authorization: `Bearer ${token}` } });

const names = (list: { name: string }[]) => list.map((a) => a.name);

describe("two accounts on one server", () => {
  it("each register the same name, as separate agents, without the other's key", async () => {
    const owners = await agent(OWNER_TOKEN, "planner");
    const friends = await agent(friendToken, "Planner");
    expect(friends.key).not.toBe(owners.key);
    expect((await call(owners.client, "get_agent", { name: "planner" })).json.bio).toBe("planner of owner");
    expect((await call(friends.client, "get_agent", { name: "planner" })).json.bio).toBe("Planner of friend");
  });

  it("never lets a key from one account take over the other's agent", async () => {
    const owners = await agent(OWNER_TOKEN, "planner");
    // The friend registers the owner's name with the owner's key: a new agent in the friend's account, not a takeover.
    const friend = await connect(friendToken);
    expect((await call(friend, "register", { name: "planner", bio: "mine", key: owners.key })).isError).toBe(false);
    expect((await call(owners.client, "get_agent", { name: "planner" })).json.bio).toBe("planner of owner");
    const ownerRows = db.prepare("SELECT bio FROM agents WHERE account_id = ? AND removed_at IS NULL").all(OWNER_ACCOUNT);
    expect(ownerRows).toEqual([{ bio: "planner of owner" }]);
  });

  it("list_agents and get_agent show only the caller's account, and the other's names look unknown", async () => {
    const a = await agent(OWNER_TOKEN, "ann");
    const f = await agent(friendToken, "fred");
    expect(names((await call(a.client, "list_agents")).json)).toEqual(["ann"]);
    expect(names((await call(f.client, "list_agents")).json)).toEqual(["fred"]);
    const other = await call(a.client, "get_agent", { name: "fred" });
    const unknown = await call(a.client, "get_agent", { name: "nobody" });
    expect(other).toEqual({ isError: true, text: "No agent named 'fred'.", json: undefined });
    expect(unknown.text).toBe("No agent named 'nobody'.");
  });

  it("send_message cannot reach the other account by name, and a broadcast stays in the sender's account", async () => {
    const a = await agent(OWNER_TOKEN, "ann");
    await agent(OWNER_TOKEN, "amy");
    const f = await agent(friendToken, "fred");
    const g = await agent(friendToken, "gina");
    expect((await call(a.client, "send_message", { to: "fred", body: "hi" })).text).toBe("No agent named 'fred'.");
    expect((await call(a.client, "send_message", { to: "all", body: "owners only" })).json).toEqual({ delivered: 1, recipients: ["amy"] });
    expect((await call(f.client, "send_message", { to: "all", body: "friends only" })).json).toEqual({ delivered: 1, recipients: ["gina"] });
    expect((await call(f.client, "read_inbox")).json).toEqual([]);
    expect((await call(g.client, "read_inbox")).json.map((m: { body: string }) => m.body)).toEqual(["friends only"]);
  });

  it("read_inbox shows each same-named agent only its own account's mail", async () => {
    const a = await agent(OWNER_TOKEN, "ann");
    const ownersBob = await agent(OWNER_TOKEN, "bob");
    const f = await agent(friendToken, "fred");
    const friendsBob = await agent(friendToken, "bob");
    await call(a.client, "send_message", { to: "bob", body: "from ann" });
    await call(f.client, "send_message", { to: "bob", body: "from fred" });
    expect((await call(ownersBob.client, "read_inbox", { unread_only: false })).json.map((m: { body: string }) => m.body)).toEqual(["from ann"]);
    expect((await call(friendsBob.client, "read_inbox", { unread_only: false })).json.map((m: { body: string }) => m.body)).toEqual(["from fred"]);
  });

  it("unregister by name and key cannot remove the other account's agent, even with its key", async () => {
    const owners = await agent(OWNER_TOKEN, "planner");
    const f = await agent(friendToken, "fred");
    const res = await call(f.client, "unregister", { name: "planner", key: owners.key });
    expect(res).toEqual({ isError: true, text: "No agent named 'planner'.", json: undefined });
    expect((await call(owners.client, "get_agent", { name: "planner" })).isError).toBe(false);
  });

  it("unregister of the caller removes only its own account's agent of that name", async () => {
    const owners = await agent(OWNER_TOKEN, "planner");
    const friends = await agent(friendToken, "planner");
    expect((await call(friends.client, "unregister")).json.removed).toBe("planner");
    expect((await call(owners.client, "get_agent", { name: "planner" })).isError).toBe(false);
    expect((await call(owners.client, "read_inbox")).isError).toBe(false);
  });

  it("a session keeps its account's last-seen to itself", async () => {
    await agent(OWNER_TOKEN, "bob");
    const friends = await agent(friendToken, "bob");
    const before = db.prepare("SELECT last_seen FROM agents WHERE account_id = ? AND name = 'bob'").pluck().get(OWNER_ACCOUNT);
    await new Promise((r) => setTimeout(r, 5));
    await call(friends.client, "list_agents");
    expect(db.prepare("SELECT last_seen FROM agents WHERE account_id = ? AND name = 'bob'").pluck().get(OWNER_ACCOUNT)).toBe(before);
  });
});

describe("GET /wait with two accounts", () => {
  it("answers the other account's agent exactly like an unknown one", async () => {
    await agent(friendToken, "fred");
    const other = await wait("fred", OWNER_TOKEN);
    const unknown = await wait("nobody", OWNER_TOKEN);
    expect(other.status).toBe(404);
    expect(await other.text()).toBe(await unknown.text());
  });

  it("wakes only on mail in the caller's account", async () => {
    const a = await agent(OWNER_TOKEN, "ann");
    await agent(OWNER_TOKEN, "bob");
    const f = await agent(friendToken, "fred");
    await agent(friendToken, "bob");
    // Mail for the friend's bob does not wake the owner's bob.
    await call(f.client, "send_message", { to: "bob", body: "x" });
    expect((await wait("bob", OWNER_TOKEN)).status).toBe(204);
    const friends = await wait("bob", friendToken);
    expect(friends.status).toBe(200);
    expect(await friends.text()).toBe("1 unread message from fred\n");
    await call(a.client, "send_message", { to: "bob", body: "y" });
    expect(await (await wait("bob", OWNER_TOKEN)).text()).toBe("1 unread message from ann\n");
  });
});

describe("tokens on sessions", () => {
  const init = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "raw", version: "0" } },
  };
  const post = (token: string, body: unknown, sid?: string) =>
    fetch(`${base()}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
        ...(sid ? { "mcp-session-id": sid } : {}),
      },
      body: JSON.stringify(body),
    });
  const toolCall = (name: string, args: Record<string, unknown>) => ({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name, arguments: args },
  });

  it("refuses a session to another account's token and changes nothing", async () => {
    const res = await post(OWNER_TOKEN, init);
    const sid = res.headers.get("mcp-session-id")!;
    await post(OWNER_TOKEN, { jsonrpc: "2.0", method: "notifications/initialized" }, sid);
    const hijack = await post(friendToken, toolCall("register", { name: "intruder", bio: "x" }), sid);
    expect(hijack.status).toBe(404);
    expect(db.prepare("SELECT COUNT(*) FROM agents").pluck().get()).toBe(0);
  });

  it("stops a revoked token at once, on a session it already started too", async () => {
    const f = await agent(friendToken, "fred");
    const second = addToken(db, "friend");
    const other = await agent(second.token, "gina");
    const [first] = listAccounts(db).find((a) => a.name === "friend")!.tokenIds;
    revokeToken(db, first);
    await expect(call(f.client, "list_agents")).rejects.toThrow();
    expect((await wait("fred", friendToken)).status).toBe(401);
    expect(accountForToken(db, friendToken, OWNER_TOKEN)).toBeUndefined();
    // The account's other token still works.
    expect(names((await call(other.client, "list_agents")).json)).toEqual(["fred", "gina"]);
  });
});

describe("account and token management", () => {
  it("prints nothing but hashes into the database and lists accounts without tokens", () => {
    const t = addToken(db, "friend");
    expect(JSON.stringify(db.prepare("SELECT * FROM tokens").all())).not.toContain(t.token);
    expect(JSON.stringify(db.prepare("SELECT * FROM tokens").all())).not.toContain(friendToken);
    const listed = listAccounts(db);
    expect(listed.map((a) => a.name)).toEqual(["owner", "friend"]);
    expect(JSON.stringify(listed)).not.toContain(t.token);
    expect(listed[1].tokenIds).toHaveLength(2);
  });

  it("refuses a duplicate or invalid account name, a token for an unknown account and an unknown or revoked token", () => {
    expect(() => addAccount(db, "FRIEND")).toThrow(AccountError);
    expect(() => addAccount(db, "bad name")).toThrow(AccountError);
    expect(() => addToken(db, "nobody")).toThrow(AccountError);
    expect(() => revokeToken(db, 999)).toThrow(AccountError);
    const id = listAccounts(db)[1].tokenIds[0];
    expect(revokeToken(db, id)).toBe("friend");
    expect(() => revokeToken(db, id)).toThrow(AccountError);
  });

  it("resolves MESSAGE_CP_HTTP_TOKEN to the owner's account and an account's token to that account", () => {
    expect(accountForToken(db, OWNER_TOKEN, OWNER_TOKEN)).toEqual({ account: OWNER_ACCOUNT, readOnly: false, agentOnly: false });
    expect(accountForToken(db, friendToken, OWNER_TOKEN)).toEqual({ account: listAccounts(db)[1].id, readOnly: false, agentOnly: false });
    const viewer = addToken(db, "friend", true);
    expect(viewer).toMatchObject({ readOnly: true, agentOnly: false });
    expect(accountForToken(db, viewer.token, OWNER_TOKEN)).toEqual({ account: listAccounts(db)[1].id, readOnly: true, agentOnly: false });
    const agent = addToken(db, "friend", false, true);
    expect(agent).toMatchObject({ readOnly: false, agentOnly: true });
    expect(accountForToken(db, agent.token, OWNER_TOKEN)).toEqual({ account: listAccounts(db)[1].id, readOnly: false, agentOnly: true });
    expect(() => addToken(db, "friend", true, true)).toThrow(AccountError);
    expect(accountForToken(db, "nope", OWNER_TOKEN)).toBeUndefined();
  });

  it("lists every working token with its id, account, kind and creation time, and never a token or hash", () => {
    const viewer = addToken(db, "friend", true);
    const agent = addToken(db, "owner", false, true);
    const gone = addToken(db, "owner");
    revokeToken(db, gone.id);
    const first = listAccounts(db)[1].tokenIds[0];
    const listed = listTokens(db);
    expect(listed).toEqual([
      { id: first, account: "friend", kind: "full", createdAt: expect.any(String) },
      { id: viewer.id, account: "friend", kind: "read-only", createdAt: expect.any(String) },
      { id: agent.id, account: "owner", kind: "agent", createdAt: expect.any(String) },
    ]);
    for (const t of listed) expect(new Date(t.createdAt).toISOString()).toBe(t.createdAt);
    const text = JSON.stringify(listed);
    for (const secret of [friendToken, viewer.token, agent.token, gone.token]) expect(text).not.toContain(secret);
    expect(text).not.toMatch(/[0-9a-f]{64}/);
  });
});
