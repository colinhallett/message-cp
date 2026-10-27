import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccountError, accountForToken, addAccount, addToken, issueToken, listAccounts, listTokens, revokeToken } from "../src/accounts.js";
import { addPerson, identityOf, registerAgent, registerWithIdentity, removeAgent } from "../src/agents.js";
import { connectAgent } from "../src/connect.js";
import { OWNER_ACCOUNT, openDb, type AccountId, type Db } from "../src/db.js";
import { startHttp, type HttpServer } from "../src/http.js";
import { saveSession } from "../src/sessions.js";

// An approval of a client that "registers its own agents": its token is bound to no agent, each session registers its
// own new name, and the token acts again only as the agents it registered, never as another agent or a person.
const OWNER_TOKEN = "owner-token";
const REDIRECT = "http://localhost:9999/callback";
let db: Db;
let http: HttpServer;
let friend: AccountId;
let ownerFull: string;
let publicUrl: string;
const clients: Client[] = [];

beforeEach(async () => {
  db = openDb(join(mkdtempSync(join(tmpdir(), "message-cp-registering-")), "db.sqlite"));
  addAccount(db, "friend");
  friend = listAccounts(db).find((a) => a.name === "friend")!.id;
  ownerFull = addToken(db, "owner").token;
  http = await startHttp(db, { token: OWNER_TOKEN, port: 0, waitHoldMs: 0 });
  const port = http.port;
  await http.close();
  publicUrl = `http://127.0.0.1:${port}`;
  http = await startHttp(db, { token: OWNER_TOKEN, port, waitHoldMs: 0, publicUrl });
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => {})));
  await http.close();
  db.close();
});

const base = () => publicUrl;
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Runs the OAuth flow with the owner's full token and the approval `body` (beside request and state); returns the token. */
async function approved(body: Record<string, unknown> = { registers: true }, token = ownerFull): Promise<string> {
  const reg = await fetch(`${base()}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "Codex", redirect_uris: [REDIRECT] }),
  });
  const clientId = ((await reg.json()) as { client_id: string }).client_id;
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const page = await fetch(
    `${base()}/oauth/authorize?${new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "s1",
      resource: `${publicUrl}/mcp`,
    })}`,
  );
  const request = /data-request="([0-9a-f]+)"/.exec(await page.text())![1];
  const res = await fetch(`${base()}/oauth/approve`, {
    method: "POST",
    headers: { ...auth(token), "Content-Type": "application/json" },
    body: JSON.stringify({ request, state: "s1", ...body }),
  });
  expect(res.status).toBe(200);
  const code = new URL(((await res.json()) as { location: string }).location).searchParams.get("code")!;
  const exchanged = await fetch(`${base()}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
      resource: `${publicUrl}/mcp`,
    }).toString(),
  });
  expect(exchanged.status).toBe(200);
  return ((await exchanged.json()) as { access_token: string }).access_token;
}

async function open(token: string): Promise<Client> {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base()}/mcp`), { requestInit: { headers: auth(token) } }));
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
const toolsList = (sid: string, token: string) => mcpPost({ ...auth(token), "mcp-session-id": sid }, { jsonrpc: "2.0", id: 9, method: "tools/list" });

/** A raw session on `token`, registered as `name` when given, and its id. */
async function sessionOf(token: string, name?: string): Promise<string> {
  const res = await mcpPost(auth(token));
  expect(res.status).toBe(200);
  const sid = res.headers.get("mcp-session-id")!;
  await res.text();
  if (name !== undefined) {
    const reg = await mcpPost(
      { ...auth(token), "mcp-session-id": sid },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "register", arguments: { name, bio: "x" } } },
    );
    expect(await reg.text()).not.toContain('isError":true');
  }
  return sid;
}

const tokenRow = () => db.prepare("SELECT * FROM tokens WHERE id = (SELECT max(id) FROM tokens)").get() as Record<string, unknown>;

describe("approving a client that registers its own agents", () => {
  it("issues an agent token bound to no agent, marked registering and recorded with its client, and makes no agent", async () => {
    const before = db.prepare("SELECT count(*) FROM agents").pluck().get();
    const token = await approved();
    expect(db.prepare("SELECT count(*) FROM agents").pluck().get()).toBe(before);
    const row = tokenRow();
    // read_only too, so a server from before `registers` takes it for an unbound agent token, never more.
    expect(row).toMatchObject({ account_id: OWNER_ACCOUNT, read_only: 1, agent_only: 1, agent_id: null, person_id: null, registers: 1, oauth: 1, client_name: "Codex" });
    expect(accountForToken(db, token, OWNER_TOKEN)).toEqual({ account: OWNER_ACCOUNT, readOnly: false, agentOnly: true, registers: row.id });
    expect(listTokens(db).find((t) => t.id === row.id)).toMatchObject({ kind: "agent", client: { name: "Codex", host: null } });
  });

  it("keeps a single-agent approval as it was: bound to its agent, not registering", async () => {
    const token = await approved({ agent: "desk" });
    const desk = identityOf(db, OWNER_ACCOUNT, "desk")!;
    expect(tokenRow()).toMatchObject({ agent_id: desk.id, registers: 0 });
    expect(accountForToken(db, token, OWNER_TOKEN)).toEqual({ account: OWNER_ACCOUNT, readOnly: false, agentOnly: true, agent: { ...desk, name: "desk" } });
    const refused = await call(await open(token), "register", { name: "other", bio: "x" });
    expect(refused).toEqual({ isError: true, text: "This token is already agent 'desk'; it cannot register or remove another name." });
  });

  it("refuses a body with neither an agent nor the choice, or with both", async () => {
    for (const body of [{}, { registers: false }, { registers: true, agent: "desk" }, { registers: "yes" }]) {
      const res = await fetch(`${base()}/oauth/approve`, {
        method: "POST",
        headers: { ...auth(ownerFull), "Content-Type": "application/json" },
        body: JSON.stringify({ request: "r", state: "s1", ...body }),
      });
      expect(res.status).toBe(400);
    }
  });

  it("offers the choice on the approval page", async () => {
    const reg = await fetch(`${base()}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: [REDIRECT] }),
    });
    const clientId = ((await reg.json()) as { client_id: string }).client_id;
    const html = await (
      await fetch(
        `${base()}/oauth/authorize?${new URLSearchParams({
          response_type: "code",
          client_id: clientId,
          redirect_uri: REDIRECT,
          code_challenge: "a".repeat(43),
          code_challenge_method: "S256",
        })}`,
      )
    ).text();
    expect(html).toContain('<input id="approve-registers" type="checkbox"> This client registers its own agents');
  });
});

describe("issueToken", () => {
  it("marks only an agent-only token bound to no agent as registering", () => {
    expect(() => issueToken(db, OWNER_ACCOUNT, false, false, undefined, undefined, true)).toThrow(AccountError);
    const desk = registerWithIdentity(db, OWNER_ACCOUNT, "desk").identity.id;
    expect(() => issueToken(db, OWNER_ACCOUNT, false, true, desk, undefined, true)).toThrow(AccountError);
    expect(() => issueToken(db, OWNER_ACCOUNT, true, false, undefined, undefined, true)).toThrow(AccountError);
  });

  it("never gives a full, read-only or person token the mark, even if its row has it", () => {
    addPerson(db, "owner", "maria");
    for (const t of [addToken(db, "owner"), addToken(db, "owner", true), addToken(db, "owner", false, false, undefined, "maria")]) {
      db.prepare("UPDATE tokens SET registers = 1 WHERE id = ?").run(t.id);
      expect(accountForToken(db, t.token, OWNER_TOKEN)?.registers).toBeUndefined();
    }
  });
});

describe("a registering token's sessions", () => {
  it("each register their own new name, with no key returned; a key argument is refused", async () => {
    const token = await approved();
    const a = await call(await open(token), "register", { name: "codex-1", bio: "one" });
    const b = await call(await open(token), "register", { name: "codex-2", bio: "two" });
    expect(a.isError).toBe(false);
    expect(b.isError).toBe(false);
    expect(JSON.parse(a.text)).not.toHaveProperty("key");
    expect(JSON.parse(b.text)).not.toHaveProperty("key");
    const tokenId = tokenRow().id;
    const rows = db.prepare("SELECT name, token_id, key_hash IS NOT NULL AS keyed FROM agents WHERE name LIKE 'codex-%' ORDER BY name").all();
    // The key hash is set from a key nobody is given, so no call without the token claims the agent.
    expect(rows).toEqual([
      { name: "codex-1", token_id: tokenId, keyed: 1 },
      { name: "codex-2", token_id: tokenId, keyed: 1 },
    ]);
    const keyed = await call(await open(token), "register", { name: "codex-3", bio: "x", key: "mine" });
    expect(keyed.isError).toBe(true);
    expect(keyed.text).toContain("Call register without a key");
    expect(identityOf(db, OWNER_ACCOUNT, "codex-3")).toBeUndefined();
    // Nor from any other token without the key.
    const unbound = await call(await open(addToken(db, "owner", false, true).token), "register", { name: "codex-1", bio: "x" });
    expect(unbound).toEqual({ isError: true, text: "Agent 'codex-1' is already registered and has a key. Pass its key to take it over." });
  });

  it("takes back an agent it registered, keeping its row, after a restart", async () => {
    const token = await approved();
    await call(await open(token), "register", { name: "codex-1", bio: "first" });
    const first = identityOf(db, OWNER_ACCOUNT, "codex-1")!;
    const again = await call(await open(token), "register", { name: "CODEX-1", bio: "back" });
    expect(again.isError).toBe(false);
    expect(JSON.parse(again.text)).toMatchObject({ name: "codex-1", bio: "back" });
    expect(JSON.parse(again.text)).not.toHaveProperty("key");
    expect(identityOf(db, OWNER_ACCOUNT, "codex-1")).toEqual(first);
  });

  it("is refused every other existing agent, with or without its key, and a person's name", async () => {
    const token = await approved();
    const other = await approved();
    await call(await open(other), "register", { name: "theirs", bio: "x" });
    const connected = connectAgent(db, "owner", "conn", false);
    registerAgent(db, OWNER_ACCOUNT, "stdio", "x", "stdio-key");
    addPerson(db, "owner", "maria");
    const session = await open(token);
    const taken = (name: string) => `Agent '${name}' is already registered. This token registers only new names and takes back only agents it registered.`;
    expect(await call(session, "register", { name: "theirs", bio: "x" })).toEqual({ isError: true, text: taken("theirs") });
    expect(await call(session, "register", { name: "conn", bio: "x" })).toEqual({ isError: true, text: taken("conn") });
    expect(await call(session, "register", { name: "stdio", bio: "x" })).toEqual({ isError: true, text: taken("stdio") });
    // With the agent's own key too: the refusal names no key.
    const withKey = await call(session, "register", { name: "conn", bio: "x", key: connected.key });
    expect(withKey.isError).toBe(true);
    expect(withKey.text).not.toContain(connected.key);
    expect((await call(session, "register", { name: "maria", bio: "x" })).text).toContain("belongs to a person");
    expect(db.prepare("SELECT token_id FROM agents WHERE name IN ('conn', 'stdio')").pluck().all()).toEqual([null, null]);
  });

  it("is refused a removed agent's name taken again by someone else", async () => {
    const token = await approved();
    await call(await open(token), "register", { name: "codex-1", bio: "x" });
    db.prepare("UPDATE agents SET key_hash = NULL WHERE name = 'codex-1'").run();
    removeAgent(db, OWNER_ACCOUNT, "codex-1");
    registerAgent(db, OWNER_ACCOUNT, "codex-1", "someone else");
    expect((await call(await open(token), "register", { name: "codex-1", bio: "x" })).isError).toBe(true);
  });

  it("registers only in its own account", async () => {
    registerAgent(db, friend, "codex-1", "friend's");
    const token = await approved();
    expect((await call(await open(token), "register", { name: "codex-1", bio: "mine" })).isError).toBe(false);
    expect(db.prepare("SELECT account_id, token_id IS NOT NULL AS own FROM agents WHERE name = 'codex-1' ORDER BY account_id").all()).toEqual([
      { account_id: OWNER_ACCOUNT, own: 1 },
      { account_id: friend, own: 0 },
    ]);
  });

  it("unregisters by name only an agent it registered, with no key", async () => {
    const token = await approved();
    await call(await open(token), "register", { name: "codex-1", bio: "x" });
    const connected = connectAgent(db, "owner", "conn", false);
    const session = await open(token);
    expect((await call(session, "unregister", { name: "conn" })).text).toContain("was not registered by this token");
    expect((await call(session, "unregister", { name: "conn", key: connected.key })).text).toContain("Call register without a key");
    expect((await call(session, "unregister", { name: "codex-1", key: "k" })).text).toContain("Call register without a key");
    expect(identityOf(db, OWNER_ACCOUNT, "conn")).toBeDefined();
    expect(JSON.parse((await call(session, "unregister", { name: "codex-1" })).text)).toMatchObject({ removed: "codex-1" });
    // With no name, it removes the session's own agent, as now.
    await call(session, "register", { name: "codex-2", bio: "x" });
    expect(JSON.parse((await call(session, "unregister")).text)).toMatchObject({ removed: "codex-2" });
  });
});

describe("a registering token on the other paths", () => {
  it("refuses agent headers on a sessionless initialize, before the cap", async () => {
    const token = await approved();
    const connected = connectAgent(db, "owner", "conn", false);
    const res = await mcpPost({ ...auth(token), "X-Message-CP-Agent": "conn", "X-Message-CP-Agent-Key": connected.key });
    expect(res.status).toBe(403);
    expect(res.headers.get("connection")).toBe("close");
    expect(await res.text()).not.toContain(connected.key);
  });

  it("answers 404 for another agent's live session, and works on its own agent's", async () => {
    const token = await approved();
    const own = await sessionOf(token, "codex-1");
    expect((await toolsList(own, token)).status).toBe(200);
    const theirs = await sessionOf(OWNER_TOKEN, "other");
    expect((await toolsList(theirs, token)).status).toBe(404);
    // A session not yet registered is the token's own to use.
    expect((await toolsList(await sessionOf(token), token)).status).toBe(200);
  });

  it("restores only a session of an agent it registered", async () => {
    const token = await approved();
    registerAgent(db, OWNER_ACCOUNT, "other", "x");
    saveSession(db, "theirs", OWNER_ACCOUNT, identityOf(db, OWNER_ACCOUNT, "other")!);
    expect((await toolsList("theirs", token)).status).toBe(404);
    await call(await open(token), "register", { name: "codex-1", bio: "x" });
    saveSession(db, "mine", OWNER_ACCOUNT, identityOf(db, OWNER_ACCOUNT, "codex-1")!);
    expect((await toolsList("mine", token)).status).toBe(200);
  });

  it("waits only for an agent it registered: 404 for any other name, or none", async () => {
    const token = await approved();
    await call(await open(token), "register", { name: "codex-1", bio: "x" });
    registerAgent(db, OWNER_ACCOUNT, "other", "x");
    addPerson(db, "owner", "maria");
    const wait = (q: string) => fetch(`${base()}/wait${q}`, { headers: auth(token) });
    expect((await wait("?agent=other")).status).toBe(404);
    expect((await wait("?agent=maria")).status).toBe(404);
    expect((await wait("")).status).toBe(404);
    expect((await wait("?agent=codex-1")).status).toBe(204);
  });

  it("stops every session of its agents once revoked, keeping the agents", async () => {
    const token = await approved();
    const sid = await sessionOf(token, "codex-1");
    revokeToken(db, tokenRow().id as number);
    expect((await toolsList(sid, token)).status).toBe(401);
    expect((await fetch(`${base()}/wait?agent=codex-1`, { headers: auth(token) })).status).toBe(401);
    expect(identityOf(db, OWNER_ACCOUNT, "codex-1")).toBeDefined();
  });
});


describe("query plans", () => {
  it("adds a token without scanning agents, finding the agents it registered by index", () => {
    const plan = db
      .prepare("EXPLAIN QUERY PLAN INSERT INTO tokens (account_id, hash, created_at, read_only, agent_only, agent_id, person_id, registers) VALUES (1, 'h', 0, 1, 1, NULL, NULL, 1)")
      .all() as { detail: string }[];
    expect(plan.map((r) => r.detail)).toEqual(["SEARCH agents USING COVERING INDEX agents_by_token (token_id=?)"]);
  });
});
