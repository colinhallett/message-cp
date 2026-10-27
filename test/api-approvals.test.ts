import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addAccount, addToken, listAccounts, listTokens, revokeToken } from "../src/accounts.js";
import { addPerson, purgeAgent, registerAgent } from "../src/agents.js";
import { connectAgent } from "../src/connect.js";
import { makeLoginCode, redeemLoginCode } from "../src/login.js";
import { OWNER_ACCOUNT, openDb, type AccountId, type Db } from "../src/db.js";
import { startHttp, type HttpServer } from "../src/http.js";

// The client each OAuth token was issued to, recorded by the code exchange, and GET /api/approvals, on a server with the
// owner's account and a friend's.
const OWNER_TOKEN = "owner-token";
const REDIRECT = "http://localhost:9999/callback";
const METADATA = "https://claude.ai/oauth/mcp-oauth-client-metadata";
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
let dbFile: string;
let db: Db;
let http: HttpServer;
let friend: AccountId;
let ownerFull: string;
let friendFull: string;
let publicUrl: string;

beforeEach(async () => {
  dbFile = join(mkdtempSync(join(tmpdir(), "message-cp-api-approvals-")), "db.sqlite");
  db = openDb(dbFile);
  addAccount(db, "friend");
  friend = listAccounts(db).find((a) => a.name === "friend")!.id;
  ownerFull = addToken(db, "owner").token;
  friendFull = addToken(db, "friend").token;
  // The public URL is the server's own address, so it is known only once the server has a port.
  const first = await startHttp(db, { token: OWNER_TOKEN, port: 0, waitHoldMs: 0 });
  const port = first.port;
  await first.close();
  publicUrl = `http://127.0.0.1:${port}`;
  http = await startHttp(db, {
    token: OWNER_TOKEN,
    port,
    waitHoldMs: 0,
    publicUrl,
    fetchClientMetadata: async (url) => {
      if (url !== METADATA) throw new Error("no such document");
      return { client_id: METADATA, client_name: "Claude", redirect_uris: [CALLBACK], token_endpoint_auth_method: "none" };
    },
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await http.close();
  db.close();
});

interface ApprovalJson {
  id: number;
  agent: string;
  clientName: string | null;
  clientHost: string | null;
  issuedAt: string;
}

const auth = (token: string | null): Record<string, string> => (token === null ? {} : { Authorization: `Bearer ${token}` });
const get = (path: string, token: string | null, method = "GET") => fetch(`${publicUrl}${path}`, { method, headers: auth(token) });
const approvals = async (token: string, query = "") => {
  const res = await get(`/api/approvals${query}`, token);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/json");
  return (await res.json()) as ApprovalJson[];
};
const client = (id: number) =>
  db.prepare("SELECT account_id, oauth, client_name, client_host FROM tokens WHERE id = ?").get(id) as Record<string, unknown>;
const lastTokenId = () => db.prepare("SELECT max(id) FROM tokens").pluck().get() as number;

/**
 * Runs the whole flow, approved with `token` as `agent`, for a client registered with `name` (none for undefined), or
 * for the metadata client with `metadata`. Returns the issued token and its row id.
 */
const connectClient = async (token: string, agent: string, options: { name?: string; metadata?: boolean } = {}) => {
  let clientId = METADATA;
  let redirect = CALLBACK;
  if (!options.metadata) {
    const res = await fetch(`${publicUrl}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: [REDIRECT], ...(options.name !== undefined && { client_name: options.name }) }),
    });
    expect(res.status).toBe(201);
    clientId = ((await res.json()) as { client_id: string }).client_id;
    redirect = REDIRECT;
  }
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const page = await fetch(
    `${publicUrl}/oauth/authorize?${new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirect,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "s1",
      resource: `${publicUrl}/mcp`,
    })}`,
  );
  expect(page.status).toBe(200);
  const request = /data-request="([0-9a-f]+)"/.exec(await page.text())![1];
  const approved = await fetch(`${publicUrl}/oauth/approve`, {
    method: "POST",
    headers: { ...auth(token), "Content-Type": "application/json" },
    body: JSON.stringify({ request, state: "s1", agent }),
  });
  expect(approved.status).toBe(200);
  const code = new URL(((await approved.json()) as { location: string }).location).searchParams.get("code")!;
  const exchanged = await fetch(`${publicUrl}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirect,
      client_id: clientId,
      code_verifier: verifier,
      resource: `${publicUrl}/mcp`,
    }).toString(),
  });
  expect(exchanged.status).toBe(200);
  return { token: ((await exchanged.json()) as { access_token: string }).access_token, id: lastTokenId(), code, request, verifier, clientId };
};

describe("recording the client", () => {
  it("records a registered client's name, and no host, on the token the exchange issues", async () => {
    const { id } = await connectClient(ownerFull, "desk", { name: "Cursor" });
    expect(client(id)).toEqual({ account_id: OWNER_ACCOUNT, oauth: 1, client_name: "Cursor", client_host: null });
  });

  it("records a registered client without a name as an OAuth token with neither", async () => {
    const { id } = await connectClient(ownerFull, "desk");
    expect(client(id)).toEqual({ account_id: OWNER_ACCOUNT, oauth: 1, client_name: null, client_host: null });
  });

  it("records a metadata client's name and its URL's host", async () => {
    const { id } = await connectClient(ownerFull, "claude", { metadata: true });
    expect(client(id)).toEqual({ account_id: OWNER_ACCOUNT, oauth: 1, client_name: "Claude", client_host: "claude.ai" });
  });

  it("keeps the name stored at the exchange once the client row is forgotten", async () => {
    const { id } = await connectClient(ownerFull, "desk", { name: "Cursor" });
    db.prepare("DELETE FROM mcp_clients").run();
    expect(client(id)).toMatchObject({ oauth: 1, client_name: "Cursor" });
    expect((await approvals(ownerFull)).map((a) => a.clientName)).toEqual(["Cursor"]);
  });

  it("records no client on tokens connect, token add, account add and login-link make", () => {
    const made = [addToken(db, "owner").id, addToken(db, "owner", true).id, addToken(db, "owner", false, true).id];
    addPerson(db, "owner", "maria");
    made.push(addToken(db, "owner", false, false, undefined, "maria").id);
    made.push(addAccount(db, "third").id);
    made.push(connectAgent(db, "owner", "writer", false).tokenId);
    redeemLoginCode(db, makeLoginCode(db, "owner").code);
    made.push(lastTokenId());
    for (const id of made) expect(client(id)).toMatchObject({ oauth: null, client_name: null, client_host: null });
  });
});

describe("GET /api/approvals", () => {
  it("lists the account's OAuth tokens newest first, with agent, client and issue time, for full, read-only and person tokens", async () => {
    const cursor = await connectClient(ownerFull, "desk", { name: "Cursor" });
    const claude = await connectClient(ownerFull, "claude", { metadata: true });
    // Tokens made otherwise are not approvals.
    registerAgent(db, OWNER_ACCOUNT, "plain", "");
    addToken(db, "owner", false, true);
    connectAgent(db, "owner", "writer", false);
    const viewer = addToken(db, "owner", true).token;
    addPerson(db, "owner", "maria");
    const person = addToken(db, "owner", false, false, undefined, "maria").token;
    const issued = (id: number) => new Date(db.prepare("SELECT created_at FROM tokens WHERE id = ?").pluck().get(id) as number).toISOString();
    const expected = [
      { id: claude.id, agent: "claude", clientName: "Claude", clientHost: "claude.ai", issuedAt: issued(claude.id) },
      { id: cursor.id, agent: "desk", clientName: "Cursor", clientHost: null, issuedAt: issued(cursor.id) },
    ];
    for (const token of [ownerFull, OWNER_TOKEN, viewer, person]) expect(await approvals(token)).toEqual(expected);
    const text = await (await get("/api/approvals", ownerFull)).text();
    for (const secret of [cursor.token, claude.token, cursor.code, cursor.request, cursor.verifier, cursor.clientId]) expect(text).not.toContain(secret);
    expect(text).not.toContain("localhost:9999");
    expect(text).not.toContain(CALLBACK);
    expect(text).not.toMatch(/[0-9a-f]{64}/);
  });

  it("pages with limit and offset", async () => {
    const ids: number[] = [];
    for (const name of ["a1", "a2", "a3"]) ids.push((await connectClient(ownerFull, name, { name })).id);
    expect((await approvals(ownerFull, "?limit=2")).map((a) => a.id)).toEqual([ids[2], ids[1]]);
    expect((await approvals(ownerFull, "?limit=2&offset=2")).map((a) => a.id)).toEqual([ids[0]]);
    expect(await approvals(ownerFull, "?offset=3")).toEqual([]);
    for (const query of ["?limit=0", "?limit=201", "?offset=-1", "?limit=1&limit=2", "?limit=x"]) {
      expect((await get(`/api/approvals${query}`, ownerFull)).status).toBe(400);
    }
  });

  it("never lists another account's approval", async () => {
    const own = await connectClient(ownerFull, "desk", { name: "Cursor" });
    const theirs = await connectClient(friendFull, "desk", { name: "Friend's client" });
    expect(client(theirs.id)).toMatchObject({ account_id: friend, client_name: "Friend's client" });
    expect((await approvals(ownerFull)).map((a) => a.id)).toEqual([own.id]);
    expect((await approvals(friendFull)).map((a) => a.id)).toEqual([theirs.id]);
    expect((await approvals(addToken(db, "friend", true).token)).map((a) => a.clientName)).toEqual(["Friend's client"]);
  });

  it("leaves out a revoked token and one whose agent was removed", async () => {
    const revoked = await connectClient(ownerFull, "gone-token", { name: "A" });
    const removed = await connectClient(ownerFull, "gone-agent", { name: "B" });
    const kept = await connectClient(ownerFull, "kept", { name: "C" });
    revokeToken(db, revoked.id);
    purgeAgent(db, "owner", "gone-agent");
    expect((await get("/mcp", removed.token)).status).toBe(401);
    expect((await approvals(ownerFull)).map((a) => a.id)).toEqual([kept.id]);
  });

  it("does not list an OAuth token issued before the client was recorded", async () => {
    const old = await connectClient(ownerFull, "old", { name: "Old" });
    db.prepare("UPDATE tokens SET oauth = NULL, client_name = NULL, client_host = NULL WHERE id = ?").run(old.id);
    expect(await approvals(ownerFull)).toEqual([]);
    expect(listTokens(db).find((t) => t.id === old.id)).not.toHaveProperty("client");
  });

  it("refuses agent tokens with 403, no or a wrong token with 401, and any method but GET with 405", async () => {
    const { token: bound } = await connectClient(ownerFull, "desk", { name: "Cursor" });
    const unbound = addToken(db, "owner", false, true).token;
    for (const token of [bound, unbound]) expect((await get("/api/approvals", token)).status).toBe(403);
    expect((await get("/api/approvals", null)).status).toBe(401);
    expect((await get("/api/approvals", "wrong")).status).toBe(401);
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const res = await get("/api/approvals", ownerFull, method);
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("GET");
    }
    // A read-only token's other methods are refused as on every other read.
    expect((await get("/api/approvals", addToken(db, "owner", true).token, "DELETE")).status).toBe(405);
  });

  it("answers 503 with Retry-After when the database is busy", async () => {
    await connectClient(ownerFull, "desk", { name: "Cursor" });
    const prepare = db.prepare.bind(db);
    let thrown = false;
    vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
      if (thrown || !sql.includes("tokens.oauth = 1")) return prepare(sql);
      thrown = true;
      throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    }) as typeof db.prepare);
    const res = await get("/api/approvals", ownerFull);
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("1");
    vi.restoreAllMocks();
    expect(await approvals(ownerFull)).toHaveLength(1);
  });

  it("reads the account's tokens through the agents primary key, searching agents rather than scanning them", () => {
    const plan = (
      db
        .prepare(
          `EXPLAIN QUERY PLAN SELECT tokens.id, agents.name, tokens.client_name, tokens.client_host, tokens.created_at
           FROM tokens JOIN agents ON agents.id = tokens.agent_id AND agents.account_id = tokens.account_id
             AND agents.removed_at IS NULL AND agents.person = 0
           WHERE tokens.account_id = ? AND tokens.oauth = 1 AND tokens.revoked_at IS NULL
           ORDER BY tokens.id DESC LIMIT ? OFFSET ?`,
        )
        .all(OWNER_ACCOUNT, 50, 0) as { detail: string }[]
    ).map((r) => r.detail);
    expect(plan.some((d) => /SEARCH agents USING INTEGER PRIMARY KEY/.test(d))).toBe(true);
    expect(plan.some((d) => /SCAN agents/.test(d))).toBe(false);
  });
});

describe("message-cp token list", () => {
  const root = resolve(import.meta.dirname, "..");
  const cli = (...args: string[]) =>
    spawnSync(join(root, "node_modules/.bin/tsx"), [join(root, "src/cli.ts"), ...args], {
      env: { ...process.env, MESSAGE_CP_DB: dbFile },
      encoding: "utf8",
    });

  it("shows an OAuth token's client after its kind, its host for a nameless one, and leaves every other line as it was", async () => {
    const named = await connectClient(ownerFull, "desk", { name: "Cursor\tIDE\n\u001b[31m" });
    const nameless = await connectClient(ownerFull, "bare");
    const claude = await connectClient(ownerFull, "claude", { metadata: true });
    db.prepare("UPDATE tokens SET client_name = NULL WHERE id = ?").run(claude.id);
    const agent = addToken(db, "owner", false, true);
    const res = cli("token", "list");
    expect(res.status).toBe(0);
    const lines = res.stdout.trimEnd().split("\n").map((l) => l.replace(/created \S+$/, "created"));
    const ids = db.prepare("SELECT id FROM tokens WHERE revoked_at IS NULL ORDER BY id").pluck().all() as number[];
    expect(lines).toEqual([
      `${ids[0]}\tfriend\tfull\tcreated`,
      `${ids[1]}\towner\tfull\tcreated`,
      `${ids[2]}\tfriend\tfull\tcreated`,
      `${named.id}\towner\tagent\tclient Cursor�IDE��[31m\tcreated`,
      `${nameless.id}\towner\tagent\tclient (unnamed)\tcreated`,
      `${claude.id}\towner\tagent\tclient claude.ai\tcreated`,
      `${agent.id}\towner\tagent\tcreated`,
    ]);
    const out = res.stdout + res.stderr;
    for (const secret of [named.token, nameless.token, claude.token, agent.token]) expect(out).not.toContain(secret);
  }, 30_000);
});
