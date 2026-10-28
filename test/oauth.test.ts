import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addAccount, addToken, listAccounts, listTokens, revokeToken } from "../src/accounts.js";
import { addPerson, purgeAgent, registerAgent, registerWithIdentity, removePerson } from "../src/agents.js";
import { OWNER_ACCOUNT, openDb, type AccountId, type Db } from "../src/db.js";
import { startHttp, type HttpServer } from "../src/http.js";
import { AUTHORIZATION_TTL_MS, CODE_TTL_MS, MAX_AUTHORIZATIONS, MAX_CLIENTS } from "../src/oauth.js";

// MCP's authorization flow on `serve --public-url`: metadata, client registration, the approval page, approval with a
// full or person token and the code exchange for an agent token, on a server with the owner's account and a friend's.
const OWNER_TOKEN = "owner-token";
const REDIRECT = "http://localhost:9999/callback";
let db: Db;
let http: HttpServer;
let friend: AccountId;
let ownerFull: string;
let friendFull: string;
let publicUrl: string;

// Client ID Metadata Documents the server is given when it fetches their URL, in place of a network fetch.
let documents: Map<string, unknown>;
let fetchMetadata: (url: string) => Promise<unknown>;
const fetched: string[] = [];

const start = async (options: { publicUrl?: string | null; maxSessions?: number } = {}) => {
  // The public URL is the server's own address unless a test gives another, or none with null.
  http = await startHttp(db, { token: OWNER_TOKEN, port: 0, waitHoldMs: 0, ...options, publicUrl: undefined });
  if (options.publicUrl === null) return;
  const port = http.port;
  await http.close();
  publicUrl = options.publicUrl ?? `http://127.0.0.1:${port}`;
  http = await startHttp(db, {
    token: OWNER_TOKEN,
    port,
    waitHoldMs: 0,
    maxSessions: options.maxSessions,
    publicUrl,
    fetchClientMetadata: (url) => fetchMetadata(url),
  });
};

beforeEach(async () => {
  db = openDb(join(mkdtempSync(join(tmpdir(), "message-cp-oauth-")), "db.sqlite"));
  addAccount(db, "friend");
  friend = listAccounts(db).find((a) => a.name === "friend")!.id;
  ownerFull = addToken(db, "owner").token;
  friendFull = addToken(db, "friend").token;
  documents = new Map();
  fetched.length = 0;
  fetchMetadata = async (url) => {
    fetched.push(url);
    if (!documents.has(url)) throw new Error("no such document");
    return documents.get(url);
  };
  await start();
});

afterEach(async () => {
  await http.close();
  db.close();
});

const base = () => `http://127.0.0.1:${http.port}`;
const mcp = () => `${publicUrl}/mcp`;
const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};
const stored = () =>
  JSON.stringify([
    db.prepare("SELECT * FROM mcp_clients ORDER BY id").all(),
    db.prepare("SELECT * FROM mcp_authorizations ORDER BY id").all(),
    db.prepare("SELECT * FROM agents ORDER BY id").all(),
    // Without last_used_at, which a request the token authenticates sets even when a later check refuses it.
    db.prepare("SELECT id, account_id, hash, created_at, revoked_at, read_only, agent_only, agent_id, person_id, oauth, client_name, client_host, registers FROM tokens ORDER BY id").all(),
  ]);

const register = (body: unknown) =>
  fetch(`${base()}/oauth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const registered = async (redirectUris = [REDIRECT], name = "Test client") => {
  const res = await register({ client_name: name, redirect_uris: redirectUris });
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
};

const authorizeUrl = (params: Record<string, string>) => `${base()}/oauth/authorize?${new URLSearchParams(params)}`;
const authorize = (params: Record<string, string>) => fetch(authorizeUrl(params), { redirect: "manual" });

/** The approval page's request handle for a well-formed authorization request. */
const pageFor = async (clientId: string, challenge: string, extra: Record<string, string> = {}) => {
  const res = await authorize({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "s1",
    resource: mcp(),
    ...extra,
  });
  expect(res.status).toBe(200);
  const html = await res.text();
  return { html, request: /data-request="([0-9a-f]+)"/.exec(html)![1], headers: res.headers };
};

const approve = (token: string, body: Record<string, unknown>) =>
  fetch(`${base()}/oauth/approve`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const exchange = (form: Record<string, string>) =>
  fetch(`${base()}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });

/** Registers a client and runs the flow up to the code, approved with `token` as `agent`. */
const codeFor = async (token = ownerFull, agent = "desk") => {
  const clientId = await registered();
  const { verifier, challenge } = pkce();
  const { request } = await pageFor(clientId, challenge);
  const res = await approve(token, { request, state: "s1", agent });
  expect(res.status).toBe(200);
  const location = new URL(((await res.json()) as { location: string }).location);
  const code = location.searchParams.get("code")!;
  const form = { grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource: mcp() };
  return { clientId, verifier, code, location, form };
};

const accessToken = async (form: Record<string, string>) => {
  const res = await exchange(form);
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  const body = (await res.json()) as { access_token: string; token_type: string };
  expect(Object.keys(body).sort()).toEqual(["access_token", "token_type"]);
  expect(body.token_type).toBe("Bearer");
  return body.access_token;
};

const listAgents = async (token: string) => {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base()}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  try {
    const result = (await client.callTool({ name: "list_agents", arguments: {} })) as { content: { text: string }[] };
    return JSON.parse(result.content[0].text) as { name: string }[];
  } finally {
    await client.close();
  }
};

describe("OAuth metadata", () => {
  it("serves protected resource metadata for /mcp at both paths, naming the public URL as the authorization server", async () => {
    for (const path of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"]) {
      const res = await fetch(`${base()}${path}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.resource).toBe(mcp());
      expect(body.authorization_servers).toEqual([publicUrl]);
    }
  });

  it("serves authorization server metadata with the endpoints and the code flow with S256 and public clients only", async () => {
    const body = (await (await fetch(`${base()}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    expect(body).toEqual({
      issuer: publicUrl,
      authorization_endpoint: `${publicUrl}/oauth/authorize`,
      token_endpoint: `${publicUrl}/oauth/token`,
      registration_endpoint: `${publicUrl}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      client_id_metadata_document_supported: true,
    });
  });

  it("builds every address from a public URL with a path, and /mcp as mcpEndpoint does", async () => {
    await http.close();
    await start({ publicUrl: "https://h.example/team/" });
    const resource = (await (await fetch(`${base()}/.well-known/oauth-protected-resource`)).json()) as Record<string, unknown>;
    expect(resource).toMatchObject({ resource: "https://h.example/team/mcp", authorization_servers: ["https://h.example/team"] });
    const server = (await (await fetch(`${base()}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    expect(server.token_endpoint).toBe("https://h.example/team/oauth/token");
    const res = await fetch(`${base()}/mcp`, { method: "POST" });
    expect(res.headers.get("www-authenticate")).toBe('Bearer resource_metadata="https://h.example/team/.well-known/oauth-protected-resource/mcp"');
    // Where RFC 8414 and RFC 9728 look for metadata of an issuer or resource with a path.
    const discovered = (await (await fetch(`${base()}/.well-known/oauth-authorization-server/team`)).json()) as Record<string, unknown>;
    expect(discovered).toEqual(server);
    const described = (await (await fetch(`${base()}/.well-known/oauth-protected-resource/team/mcp`)).json()) as Record<string, unknown>;
    expect(described).toEqual(resource);
  });

  it("has the approval page send its approval relative to the authorization endpoint, under a public URL's path", async () => {
    const { html } = await pageFor(await registered(), pkce().challenge);
    expect(html).toContain('fetch("approve"');
    expect(html).not.toContain('fetch("/oauth/approve"');
    expect(new URL("approve", "https://h.example/team/oauth/authorize?x=1").href).toBe("https://h.example/team/oauth/approve");
  });

  it("points a 401 at the protected resource metadata", async () => {
    for (const path of ["/mcp", "/wait?agent=x", "/api/agents"]) {
      const res = await fetch(`${base()}${path}`, { method: path === "/mcp" ? "POST" : "GET" });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${publicUrl}/.well-known/oauth-protected-resource/mcp"`);
    }
  });

  it("without a public URL serves none of it: no token gets 401 with a plain Bearer challenge, a full token 404", async () => {
    await http.close();
    await start({ publicUrl: null });
    const paths = [
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-authorization-server",
      "/oauth/register",
      "/oauth/authorize",
      "/oauth/approve",
      "/oauth/token",
    ];
    for (const path of paths) {
      for (const method of ["GET", "POST"]) {
        const bare = await fetch(`${base()}${path}`, { method });
        expect(bare.status).toBe(401);
        expect(bare.headers.get("www-authenticate")).toBe("Bearer");
        const authed = await fetch(`${base()}${path}`, { method, headers: { Authorization: `Bearer ${ownerFull}` } });
        expect(authed.status).toBe(404);
      }
    }
    expect(JSON.parse(stored())[0]).toEqual([]);
  });
});

describe("client registration", () => {
  it("registers a public client without a token and answers 201 with a client_id", async () => {
    const res = await register({ client_name: "Claude", redirect_uris: [REDIRECT, "https://claude.example/cb"] });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.client_id).toMatch(/^[0-9a-f]{32}$/);
    expect(body).toMatchObject({ client_name: "Claude", redirect_uris: [REDIRECT, "https://claude.example/cb"], token_endpoint_auth_method: "none" });
  });

  it.each([
    "http://127.0.0.1:3000/cb",
    "http://127.9.8.7/cb",
    "http://[::1]:3000/cb",
    "http://localhost/cb",
    "https://client.example/oauth/callback",
  ])("accepts %s", async (uri) => {
    expect((await register({ redirect_uris: [uri] })).status).toBe(201);
  });

  it.each([
    "http://localhost@evil/",
    "https://@/",
    "https://h/?x=/o/",
    "https://h/#/o/",
    "https://h.example/cb?",
    "https://h.example/cb#",
    "https://user:pass@h.example/cb",
    "http://evil.example/cb",
    "http://localhost.evil.example/cb",
    "http://10.0.0.1/cb",
    "javascript:alert(1)",
    "custom-scheme://cb",
    "not a url",
  ])("refuses %s as a redirect URI with invalid_redirect_uri and stores nothing", async (uri) => {
    const before = stored();
    const res = await register({ client_name: "x", redirect_uris: [REDIRECT, uri] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_redirect_uri");
    expect(stored()).toBe(before);
  });

  it("refuses a body without redirect URIs, and one that is not JSON", async () => {
    for (const body of [{}, { redirect_uris: [] }, { redirect_uris: "https://h.example/cb" }, [REDIRECT]]) {
      expect((await register(body)).status).toBe(400);
    }
    const res = await fetch(`${base()}/oauth/register`, { method: "POST", body: "{" });
    expect(res.status).toBe(400);
    expect(JSON.parse(stored())[0]).toEqual([]);
  });

  it(`keeps at most ${MAX_CLIENTS} registrations, forgetting the oldest`, async () => {
    const first = await registered();
    const insert = db.prepare("INSERT INTO mcp_clients (client_id, client_name, redirect_uris, created_at) VALUES (?, NULL, '[]', 0)");
    for (let i = 0; i < MAX_CLIENTS - 1; i++) insert.run(`filler-${i}`);
    await registered();
    expect(db.prepare("SELECT count(*) FROM mcp_clients").pluck().get()).toBe(MAX_CLIENTS);
    expect(db.prepare("SELECT 1 FROM mcp_clients WHERE client_id = ?").get(first)).toBeUndefined();
  });

  it("never forgets a registration with a live request or code, so registering ends no other client's flow", async () => {
    const pending = await registered();
    const { request } = await pageFor(pending, pkce().challenge);
    const approved = await registered();
    const second = pkce();
    const { request: approvedRequest } = await pageFor(approved, second.challenge);
    const location = ((await (await approve(ownerFull, { request: approvedRequest, state: "s1", agent: "desk" })).json()) as { location: string })
      .location;
    const expired = await registered();
    await pageFor(expired, pkce().challenge);
    db.prepare("UPDATE mcp_authorizations SET expires_at = 0 WHERE client_id = (SELECT id FROM mcp_clients WHERE client_id = ?)").run(expired);
    const insert = db.prepare("INSERT INTO mcp_clients (client_id, client_name, redirect_uris, created_at) VALUES (?, NULL, '[]', 0)");
    for (let i = 0; i < MAX_CLIENTS; i++) insert.run(`filler-${i}`);
    await registered();
    const kept = (id: string) => db.prepare("SELECT 1 FROM mcp_clients WHERE client_id = ?").get(id) !== undefined;
    expect([kept(pending), kept(approved), kept(expired)]).toEqual([true, true, false]);
    expect(db.prepare("SELECT count(*) FROM mcp_clients").pluck().get()).toBe(MAX_CLIENTS + 2);
    // Both flows still finish.
    expect((await approve(ownerFull, { request, state: "s1", agent: "desk" })).status).toBe(200);
    const code = new URL(location).searchParams.get("code")!;
    const res = await exchange({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: approved, code_verifier: second.verifier, resource: mcp() });
    expect(res.status).toBe(200);
  });
});

describe("authorization request", () => {
  it("shows the approval page with the client's name, the redirect host and a loopback warning, under a hashed CSP", async () => {
    const clientId = await registered([REDIRECT], "<b>Claude</b>");
    const { html, headers } = await pageFor(clientId, pkce().challenge);
    expect(html).toContain("&lt;b&gt;Claude&lt;/b&gt;");
    expect(html).not.toContain("<b>Claude</b>");
    expect(html).toContain("localhost:9999");
    expect(html).toContain('class="warn"');
    expect(html).toContain('id="approve-token" type="password"');
    expect(html).toContain('id="approve-agent"');
    expect(html).not.toContain("localStorage");
    expect(html).not.toContain("sessionStorage");
    expect(html).toContain("/fonts/instrument-sans-latin-400-normal.woff2");
    const csp = headers.get("content-security-policy")!;
    expect(csp).toMatch(/script-src 'sha256-[^']+'/);
    expect(csp).toMatch(/style-src 'sha256-[^']+'/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(headers.get("cache-control")).toBe("no-store");
  });

  it("warns of nothing for an https redirect", async () => {
    const clientId = await registered(["https://client.example/cb"]);
    const res = await authorize({
      response_type: "code",
      client_id: clientId,
      redirect_uri: "https://client.example/cb",
      code_challenge: pkce().challenge,
      code_challenge_method: "S256",
    });
    const html = await res.text();
    expect(html).toContain("client.example");
    expect(html).not.toContain('class="warn"');
  });

  it("stores the request only as hashes, with an expiry minutes away", async () => {
    const clientId = await registered();
    const { request } = await pageFor(clientId, pkce().challenge);
    const rows = db.prepare("SELECT * FROM mcp_authorizations").all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(request);
    expect(rows[0].request_hash).toBe(createHash("sha256").update(request).digest("hex"));
    expect(rows[0].state_hash).toBe(createHash("sha256").update("s1").digest("hex"));
    expect(rows[0].expires_at as number).toBeLessThanOrEqual(Date.now() + AUTHORIZATION_TTL_MS);
  });

  it("shows an error page, never a redirect, for a missing or unregistered client or redirect URI", async () => {
    const clientId = await registered();
    const good = { response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: pkce().challenge, code_challenge_method: "S256" };
    for (const params of [
      { ...good, client_id: "" },
      { ...good, client_id: "nope" },
      { ...good, redirect_uri: "" },
      { ...good, redirect_uri: "http://localhost:9999/other" },
      { ...good, redirect_uri: "http://localhost:9999/callback/" },
      { ...good, redirect_uri: "http://LOCALHOST:9999/callback" },
    ]) {
      const res = await authorize(params);
      expect(res.status).toBe(400);
      expect(res.headers.get("location")).toBeNull();
      expect(res.headers.get("content-type")).toContain("text/html");
    }
    const noClient = await fetch(`${base()}/oauth/authorize?redirect_uri=${encodeURIComponent(REDIRECT)}`, { redirect: "manual" });
    expect(noClient.status).toBe(400);
    expect(db.prepare("SELECT count(*) FROM mcp_authorizations").pluck().get()).toBe(0);
  });

  it("accepts a loopback redirect URI on another port, sends the code there and exchanges it only for that URI", async () => {
    const clientId = await registered();
    const moved = "http://localhost:45678/callback";
    const { verifier, challenge } = pkce();
    const { request, html } = await pageFor(clientId, challenge, { redirect_uri: moved });
    expect(html).toContain("localhost:45678");
    expect(db.prepare("SELECT redirect_uri FROM mcp_authorizations").pluck().get()).toBe(moved);
    const res = await approve(ownerFull, { request, state: "s1", agent: "desk" });
    expect(res.status).toBe(200);
    const location = new URL(((await res.json()) as { location: string }).location);
    expect(`${location.origin}${location.pathname}`).toBe(moved);
    const code = location.searchParams.get("code")!;
    const form = { grant_type: "authorization_code", code, redirect_uri: moved, client_id: clientId, code_verifier: verifier, resource: mcp() };
    const registeredUri = await exchange({ ...form, redirect_uri: REDIRECT });
    expect(registeredUri.status).toBe(400);
    expect(((await registeredUri.json()) as { error: string }).error).toBe("invalid_grant");
  });

  it("lets only the port of an http loopback redirect URI differ", async () => {
    const clientId = await registered([REDIRECT, "https://client.example/cb", "http://127.0.0.1/cb", "http://[::1]:8000/cb"]);
    const good = { response_type: "code", client_id: clientId, code_challenge: pkce().challenge, code_challenge_method: "S256" };
    for (const redirect of ["http://localhost:1/callback", "http://localhost/callback", "http://127.0.0.1:5000/cb", "http://[::1]:9/cb"]) {
      expect((await authorize({ ...good, redirect_uri: redirect })).status, redirect).toBe(200);
    }
    for (const redirect of [
      "https://client.example:8443/cb",
      "http://client.example/cb",
      "https://localhost:9999/callback",
      "http://127.0.0.1:9999/callback",
      "http://localhost:5000/cb",
      "http://127.0.0.2:5000/cb",
      "http://localhost:5000/Callback",
      "http://localhost:5000/callback/",
      "http://localhost:5000/callback?x=1",
      "http://localhost:5000/callback?",
      "http://localhost:5000/callback#x",
      "http://u:p@localhost:5000/callback",
      "http://@localhost:5000/callback",
      "http://LOCALHOST:5000/callback",
      "http://localhost:5000/%63allback",
      "http://localhost:5000/x/../callback",
      "http://127.1:5000/cb",
      "http://[::1]:9/cb/",
    ]) {
      const res = await authorize({ ...good, redirect_uri: redirect });
      expect(res.status, redirect).toBe(400);
      expect(res.headers.get("location")).toBeNull();
    }
    expect(db.prepare("SELECT count(*) FROM mcp_authorizations").pluck().get()).toBe(4);
  });

  it("redirects any other bad parameter back with invalid_request and the state, storing nothing", async () => {
    const clientId = await registered();
    const good = { response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: pkce().challenge, code_challenge_method: "S256", state: "xyz" };
    const { code_challenge_method: _m, ...noMethod } = good;
    const { code_challenge: _c, ...noChallenge } = good;
    for (const params of [
      { ...good, response_type: "token" },
      { ...good, code_challenge_method: "plain" },
      noMethod,
      noChallenge,
      { ...good, code_challenge: "short" },
      { ...good, resource: "https://other.example/mcp" },
      { ...good, resource: `${publicUrl}/` },
    ]) {
      const res = await authorize(params);
      expect(res.status).toBe(302);
      const location = new URL(res.headers.get("location")!);
      expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
      expect(location.searchParams.get("error")).toBe("invalid_request");
      expect(location.searchParams.get("state")).toBe("xyz");
    }
    expect(db.prepare("SELECT count(*) FROM mcp_authorizations").pluck().get()).toBe(0);
  });

  it("accepts a request without a resource", async () => {
    const clientId = await registered();
    const res = await authorize({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: pkce().challenge, code_challenge_method: "S256" });
    expect(res.status).toBe(200);
  });

  it(`refuses a new request while ${MAX_AUTHORIZATIONS} are pending, and deletes expired ones first`, async () => {
    const clientId = await registered();
    const { id } = db.prepare("SELECT id FROM mcp_clients WHERE client_id = ?").get(clientId) as { id: number };
    const insert = db.prepare(
      "INSERT INTO mcp_authorizations (request_hash, client_id, redirect_uri, code_challenge, expires_at) VALUES (?, ?, ?, 'x', ?)",
    );
    for (let i = 0; i < MAX_AUTHORIZATIONS; i++) insert.run(`h${i}`, id, REDIRECT, Date.now() + 60_000);
    const res = await authorize({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: pkce().challenge, code_challenge_method: "S256" });
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!).searchParams.get("error")).toBe("temporarily_unavailable");
    db.prepare("UPDATE mcp_authorizations SET expires_at = 0").run();
    await pageFor(clientId, pkce().challenge);
    expect(db.prepare("SELECT count(*) FROM mcp_authorizations").pluck().get()).toBe(1);
  });
});

describe("approval", () => {
  it("makes a new agent in the token's account and sends the person to the redirect URI with a code and the state", async () => {
    const { location } = await codeFor(ownerFull, "desk");
    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
    expect(location.searchParams.get("code")).toMatch(/^[0-9a-f]{64}$/);
    expect(location.searchParams.get("state")).toBe("s1");
    expect(db.prepare("SELECT account_id FROM agents WHERE name = 'desk' AND removed_at IS NULL").all()).toEqual([{ account_id: OWNER_ACCOUNT }]);
  });

  it("binds to an existing live agent, leaving its key and registration alone", async () => {
    registerAgent(db, OWNER_ACCOUNT, "desk", "my bio");
    const before = db.prepare("SELECT id, key_hash, instance, registered_at FROM agents WHERE name = 'desk'").get();
    const { form } = await codeFor(ownerFull, "desk");
    expect(db.prepare("SELECT id, key_hash, instance, registered_at FROM agents WHERE name = 'desk'").get()).toEqual(before);
    const token = await accessToken(form);
    expect(db.prepare("SELECT agent_id FROM tokens WHERE id = (SELECT max(id) FROM tokens)").pluck().get()).toBe((before as { id: number }).id);
    expect((await listAgents(token)).map((a) => a.name)).toEqual(["desk"]);
  });

  it("refuses a person's name or an invalid name with the reason, storing nothing", async () => {
    addPerson(db, "owner", "colin");
    const clientId = await registered();
    const { request } = await pageFor(clientId, pkce().challenge);
    const before = stored();
    for (const [agent, reason] of [
      ["colin", "belongs to a person"],
      ["no spaces", "Invalid name"],
      ["all", "reserved"],
      ["", "Invalid name"],
    ]) {
      const res = await approve(ownerFull, { request, state: "s1", agent });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { message: string }).message).toContain(reason);
    }
    expect(stored()).toBe(before);
    // The request is still there to approve with a good name.
    expect((await approve(ownerFull, { request, state: "s1", agent: "desk" })).status).toBe(200);
  });

  it("refuses an agent-only or read-only token with 403 and no token with 401, changing nothing", async () => {
    const clientId = await registered();
    const { request } = await pageFor(clientId, pkce().challenge);
    const before = stored();
    const agentOnly = addToken(db, "owner", false, true).token;
    const readOnly = addToken(db, "owner", true).token;
    const bound = addToken(db, "owner", false, true, registerWithIdentity(db, OWNER_ACCOUNT, "b").identity.id).token;
    const after = stored();
    for (const token of [agentOnly, readOnly, bound]) {
      const res = await approve(token, { request, state: "s1", agent: "desk" });
      expect(res.status).toBe(403);
      // Its body is left unread, so the connection is not kept for another request.
      expect(res.headers.get("connection")).toBe("close");
    }
    expect((await approve("wrong", { request, state: "s1", agent: "desk" })).status).toBe(401);
    expect(stored()).toBe(after);
    expect(before).not.toBe(after);
  });

  it("approves with a person token: the code gives an agent token bound to a new agent of the person's account, working on /mcp", async () => {
    addPerson(db, "owner", "maria");
    const maria = addToken(db, "owner", false, false, undefined, "maria").token;
    const { form } = await codeFor(maria, "desk");
    const desk = db.prepare("SELECT id, account_id, person FROM agents WHERE name = 'desk' AND removed_at IS NULL").all();
    expect(desk).toEqual([{ id: expect.any(Number), account_id: OWNER_ACCOUNT, person: 0 }]);
    // The approved request names the agent until the code is exchanged.
    expect(db.prepare("SELECT agent_id FROM mcp_authorizations WHERE code_hash IS NOT NULL").pluck().all()).toEqual([(desk[0] as { id: number }).id]);
    const token = await accessToken(form);
    const row = db.prepare("SELECT account_id, agent_only, agent_id, person_id FROM tokens WHERE id = (SELECT max(id) FROM tokens)").get();
    expect(row).toEqual({ account_id: OWNER_ACCOUNT, agent_only: 1, agent_id: (desk[0] as { id: number }).id, person_id: null });
    expect((await listAgents(token)).map((a) => a.name).sort()).toEqual(["desk", "maria"]);
    // The person token itself still cannot act as an agent.
    expect((await fetch(`${base()}/wait?agent=desk`, { headers: { Authorization: `Bearer ${maria}` } })).status).toBe(403);
  });

  it("approves with a person token of another account only into that account", async () => {
    registerAgent(db, OWNER_ACCOUNT, "desk", "owner's desk");
    addPerson(db, "friend", "dana");
    const dana = addToken(db, "friend", false, false, undefined, "dana").token;
    const token = await accessToken((await codeFor(dana, "desk")).form);
    const row = db.prepare("SELECT account_id, agent_id FROM tokens WHERE id = (SELECT max(id) FROM tokens)").get() as { account_id: number; agent_id: number };
    expect(row.account_id).toBe(friend);
    expect(db.prepare("SELECT account_id FROM agents WHERE id = ?").pluck().get(row.agent_id)).toBe(friend);
    expect((await listAgents(token)).map((a) => a.name).sort()).toEqual(["dana", "desk"]);
    expect(db.prepare("SELECT bio FROM agents WHERE account_id = ? AND name = 'desk'").pluck().get(OWNER_ACCOUNT)).toBe("owner's desk");
  });

  it("refuses a removed person's token with 401, storing nothing", async () => {
    const clientId = await registered();
    const { request } = await pageFor(clientId, pkce().challenge);
    addPerson(db, "owner", "maria");
    const maria = addToken(db, "owner", false, false, undefined, "maria").token;
    removePerson(db, "owner", "maria");
    const before = stored();
    expect((await approve(maria, { request, state: "s1", agent: "desk" })).status).toBe(401);
    expect(stored()).toBe(before);
    expect(db.prepare("SELECT 1 FROM agents WHERE name = 'desk'").get()).toBeUndefined();
    // The request is still there for a working token to approve.
    expect((await approve(ownerFull, { request, state: "s1", agent: "desk" })).status).toBe(200);
  });

  it("refuses a request handle it does not hold, a wrong state, an expired request, and a second approval", async () => {
    const clientId = await registered();
    const { request } = await pageFor(clientId, pkce().challenge);
    expect((await approve(ownerFull, { request: "0".repeat(64), state: "s1", agent: "desk" })).status).toBe(400);
    expect((await approve(ownerFull, { request, state: "other", agent: "desk" })).status).toBe(400);
    expect((await approve(ownerFull, { request, state: null, agent: "desk" })).status).toBe(400);
    expect((await approve(ownerFull, { request, state: "s1", agent: "desk" })).status).toBe(200);
    expect((await approve(ownerFull, { request, state: "s1", agent: "desk2" })).status).toBe(400);
    expect(db.prepare("SELECT 1 FROM agents WHERE name = 'desk2'").get()).toBeUndefined();

    const second = await pageFor(clientId, pkce().challenge);
    db.prepare("UPDATE mcp_authorizations SET expires_at = ? WHERE code_hash IS NULL").run(Date.now() - 1);
    expect((await approve(ownerFull, { request: second.request, state: "s1", agent: "late" })).status).toBe(400);
    expect(db.prepare("SELECT 1 FROM agents WHERE name = 'late'").get()).toBeUndefined();
  });

  it("puts the redirect with access_denied and the state behind Refuse", async () => {
    const clientId = await registered();
    const { html } = await pageFor(clientId, pkce().challenge);
    const deny = /data-location="([^"]+)"/.exec(html)![1].replace(/&amp;/g, "&");
    expect(deny).toBe(`${REDIRECT}?error=access_denied&state=s1`);
  });
});

describe("code exchange", () => {
  it("issues an agent token bound to the approved agent, which works on /mcp and /wait like connect's and is listed as agent", async () => {
    const { form } = await codeFor(ownerFull, "desk");
    const token = await accessToken(form);
    const row = db.prepare("SELECT account_id, agent_only, agent_id FROM tokens WHERE id = (SELECT max(id) FROM tokens)").get();
    const desk = db.prepare("SELECT id FROM agents WHERE name = 'desk'").pluck().get();
    expect(row).toEqual({ account_id: OWNER_ACCOUNT, agent_only: 1, agent_id: desk });
    expect(listTokens(db).at(-1)).toMatchObject({ account: "owner", kind: "agent" });
    expect((await listAgents(token)).map((a) => a.name)).toEqual(["desk"]);
    const wait = await fetch(`${base()}/wait`, { headers: { Authorization: `Bearer ${token}` } });
    expect(wait.status).toBe(204);
    // A bound token acts only as its agent.
    const other = await fetch(`${base()}/wait?agent=someone`, { headers: { Authorization: `Bearer ${token}` } });
    expect(other.status).toBe(404);
    const api = await fetch(`${base()}/api/agents`, { headers: { Authorization: `Bearer ${token}` } });
    expect(api.status).toBe(403);
    revokeToken(db, listTokens(db).at(-1)!.id);
    expect((await fetch(`${base()}/wait`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
  });

  it("accepts an exchange without resource when the request had none", async () => {
    const clientId = await registered();
    const { verifier, challenge } = pkce();
    const res = await authorize({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256" });
    const request = /data-request="([0-9a-f]+)"/.exec(await res.text())![1];
    const ap = await approve(ownerFull, { request, state: null, agent: "desk" });
    const location = new URL(((await ap.json()) as { location: string }).location);
    expect(location.searchParams.has("state")).toBe(false);
    await accessToken({ grant_type: "authorization_code", code: location.searchParams.get("code")!, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier });
  });

  it.each([
    ["verifier", { code_verifier: randomBytes(32).toString("base64url") }],
    ["client", { client_id: "someone-else" }],
    ["redirect URI", { redirect_uri: "http://localhost:9999/other" }],
    ["resource", { resource: "https://other.example/mcp" }],
    ["missing resource", { resource: undefined }],
    ["code", { code: "0".repeat(64) }],
  ])("refuses a wrong %s with invalid_grant, issues nothing, and uses the code up", async (_, change) => {
    const { form } = await codeFor();
    const tokens = listTokens(db).length;
    const bad: Record<string, string> = { ...form, ...change } as Record<string, string>;
    for (const [k, v] of Object.entries(bad)) if (v === undefined) delete bad[k];
    const res = await exchange(bad);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_grant");
    expect(listTokens(db).length).toBe(tokens);
    // A wrong code touches nothing; any other mismatch uses the real code up.
    const retry = await exchange(form);
    expect(retry.status).toBe(change.code ? 200 : 400);
  });

  it("refuses a second exchange of a used code", async () => {
    const { form } = await codeFor();
    await accessToken(form);
    const tokens = listTokens(db).length;
    const res = await exchange(form);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_grant");
    expect(listTokens(db).length).toBe(tokens);
  });

  it("refuses an expired code", async () => {
    const { form } = await codeFor();
    const row = db.prepare("SELECT expires_at FROM mcp_authorizations").pluck().get() as number;
    expect(row).toBeLessThanOrEqual(Date.now() + CODE_TTL_MS);
    db.prepare("UPDATE mcp_authorizations SET expires_at = ?").run(Date.now() - 1);
    const res = await exchange(form);
    expect(res.status).toBe(400);
    expect(db.prepare("SELECT count(*) FROM mcp_authorizations").pluck().get()).toBe(0);
  });

  it("refuses a code whose agent was removed after approval", async () => {
    const { form } = await codeFor(ownerFull, "desk");
    purgeAgent(db, "owner", "desk");
    const tokens = listTokens(db).length;
    expect((await exchange(form)).status).toBe(400);
    expect(listTokens(db).length).toBe(tokens);
  });

  it("stores the code only as a hash", async () => {
    const { code } = await codeFor();
    expect(JSON.stringify(db.prepare("SELECT * FROM mcp_authorizations").all())).not.toContain(code);
  });

  it("refuses another grant type and a malformed form", async () => {
    const { form } = await codeFor();
    const refresh = await exchange({ ...form, grant_type: "refresh_token" });
    expect(((await refresh.json()) as { error: string }).error).toBe("unsupported_grant_type");
    const { code_verifier: _, ...noVerifier } = form;
    expect(((await (await exchange(noVerifier)).json()) as { error: string }).error).toBe("invalid_request");
    // Neither touched the code.
    await accessToken(form);
  });
});

describe("account separation", () => {
  it("a code approved with account A's token yields a token of A only, bound to A's agent of that name", async () => {
    registerAgent(db, OWNER_ACCOUNT, "desk", "owner's desk");
    const { form } = await codeFor(friendFull, "desk");
    const token = await accessToken(form);
    const row = db.prepare("SELECT account_id, agent_id FROM tokens WHERE id = (SELECT max(id) FROM tokens)").get() as { account_id: number; agent_id: number };
    expect(row.account_id).toBe(friend);
    expect(db.prepare("SELECT account_id FROM agents WHERE id = ?").pluck().get(row.agent_id)).toBe(friend);
    expect(listTokens(db).at(-1)).toMatchObject({ account: "friend", kind: "agent" });
    // The friend's token sees only the friend's agents.
    expect((await listAgents(token)).map((a) => a.name)).toEqual(["desk"]);
    expect(db.prepare("SELECT bio FROM agents WHERE account_id = ? AND name = 'desk'").pluck().get(OWNER_ACCOUNT)).toBe("owner's desk");
  });

  it("the unauthenticated endpoints name no account, agent or token", async () => {
    registerAgent(db, OWNER_ACCOUNT, "secret-agent", "");
    const clientId = await registered();
    const texts = [
      await (await fetch(`${base()}/.well-known/oauth-protected-resource`)).text(),
      await (await fetch(`${base()}/.well-known/oauth-authorization-server`)).text(),
      await (await register({ redirect_uris: [REDIRECT] })).text(),
      (await pageFor(clientId, pkce().challenge)).html,
    ];
    for (const text of texts) {
      expect(text).not.toContain("friend");
      expect(text).not.toMatch(/\bowner\b/);
      expect(text).not.toContain("secret-agent");
    }
  });
});

describe("caps", () => {
  it("answers 503 with Connection: close to a body request past the cap, and gives the slot back", async () => {
    await http.close();
    await start({ maxSessions: 1 });
    // Hold one slot with a body that never ends.
    const held = request(`${base()}/oauth/register`, { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": "100" } });
    held.on("error", () => {});
    held.write("{");
    await new Promise((r) => setTimeout(r, 100));
    for (const path of ["/oauth/register", "/oauth/token"]) {
      const res = await fetch(`${base()}${path}`, { method: "POST", body: "{}" });
      expect(res.status).toBe(503);
      expect(res.headers.get("connection")).toBe("close");
      expect(res.headers.get("retry-after")).toBe("5");
    }
    const ap = await approve(ownerFull, { request: "x", state: null, agent: "a" });
    expect(ap.status).toBe(503);
    held.destroy();
    await new Promise((r) => setTimeout(r, 100));
    expect((await register({ redirect_uris: [REDIRECT] })).status).toBe(201);
  });

  it("answers 413 to a body over 16 KiB", async () => {
    const res = await register({ redirect_uris: [REDIRECT], client_name: "x".repeat(20 * 1024) });
    expect(res.status).toBe(413);
  });
});

describe("Client ID Metadata Documents", () => {
  const CLAUDE = "https://claude.ai/oauth/mcp-oauth-client-metadata";
  const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
  const claude = { client_id: CLAUDE, client_name: "Claude", redirect_uris: [CALLBACK], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"] };
  const params = (extra: Record<string, string> = {}) => ({
    response_type: "code",
    client_id: CLAUDE,
    redirect_uri: CALLBACK,
    code_challenge_method: "S256",
    state: "s1",
    resource: mcp(),
    ...extra,
  });

  /** Runs the flow for the metadata client up to the code, approved with `token` as `agent`. */
  const metadataCode = async (token = ownerFull, agent = "claude") => {
    documents.set(CLAUDE, claude);
    const { verifier, challenge } = pkce();
    const res = await authorize(params({ code_challenge: challenge }));
    expect(res.status).toBe(200);
    const request = /data-request="([0-9a-f]+)"/.exec(await res.text())![1];
    const approved = await approve(token, { request, state: "s1", agent });
    expect(approved.status).toBe(200);
    const location = new URL(((await approved.json()) as { location: string }).location);
    expect(`${location.origin}${location.pathname}`).toBe(CALLBACK);
    const code = location.searchParams.get("code")!;
    return { grant_type: "authorization_code", code, redirect_uri: CALLBACK, client_id: CLAUDE, code_verifier: verifier, resource: mcp() };
  };

  it("walks the whole flow with the URL as client_id, to a list_agents call with only the issued token", async () => {
    registerAgent(db, OWNER_ACCOUNT, "already-here", "");
    const form = await metadataCode(ownerFull, "claude");
    expect(fetched).toEqual([CLAUDE]);
    const token = await accessToken(form);
    expect((await listAgents(token)).map((a) => a.name).sort()).toEqual(["already-here", "claude"]);
    expect(listTokens(db).at(-1)).toMatchObject({ account: "owner", kind: "agent" });
  });

  it("names the client and its metadata URL's host on the approval page, HTML-escaped, with the redirect host", async () => {
    documents.set(CLAUDE, { ...claude, client_name: "<b>Claude</b>" });
    const res = await authorize(params({ code_challenge: pkce().challenge }));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<span class="client">&lt;b&gt;Claude&lt;/b&gt;</span>, from <span class="client">claude.ai</span>, asks');
    expect(html).toContain("this server has checked only that its description is at claude.ai");
    expect(html).not.toContain('class="warn"');
    expect(html).not.toContain(CLAUDE);
  });

  it("warns of a loopback redirect the document lists, as for a registered client", async () => {
    const vscode = "https://vscode.dev/oauth/client-metadata.json";
    documents.set(vscode, { client_id: vscode, client_name: "Visual Studio Code", redirect_uris: ["http://127.0.0.1:33418/", "https://vscode.dev/redirect"] });
    const res = await authorize(params({ client_id: vscode, redirect_uri: "http://127.0.0.1:33418/", code_challenge: pkce().challenge }));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Visual Studio Code</span>, from <span class=\"client\">vscode.dev</span>");
    expect(html).toContain('class="warn"');
  });

  it("accepts a portless loopback redirect URI the document lists on any port, as Codex asks", async () => {
    const codex = "https://chatgpt.com/oauth/codex-client-metadata.json";
    documents.set(codex, { client_id: codex, client_name: "Codex", redirect_uris: ["http://127.0.0.1/callback/x", "http://localhost/callback/x"] });
    const moved = "http://127.0.0.1:44663/callback/x";
    const { verifier, challenge } = pkce();
    const res = await authorize(params({ client_id: codex, redirect_uri: moved, code_challenge: challenge }));
    expect(res.status).toBe(200);
    const request = /data-request="([0-9a-f]+)"/.exec(await res.text())![1];
    const approved = await approve(ownerFull, { request, state: "s1", agent: "codex" });
    const location = new URL(((await approved.json()) as { location: string }).location);
    expect(`${location.origin}${location.pathname}`).toBe(moved);
    const form = { grant_type: "authorization_code", code: location.searchParams.get("code")!, redirect_uri: moved, client_id: codex, code_verifier: verifier, resource: mcp() };
    await accessToken(form);
    for (const redirect of ["http://localhost:44663/callback/y", "https://127.0.0.1:44663/callback/x"]) {
      expect((await authorize(params({ client_id: codex, redirect_uri: redirect, code_challenge: pkce().challenge }))).status, redirect).toBe(400);
    }
  });

  it("shows the error page, never a redirect, for a redirect URI the document does not list", async () => {
    documents.set(CLAUDE, claude);
    for (const redirect of ["https://evil.example/cb", `${CALLBACK}/`, "https://claude.ai/api/mcp/auth_callback?x=1", ""]) {
      const res = await authorize(params({ redirect_uri: redirect, code_challenge: pkce().challenge }));
      expect(res.status, redirect).toBe(400);
      expect(res.headers.get("location")).toBeNull();
    }
    expect(db.prepare("SELECT count(*) FROM mcp_authorizations").pluck().get()).toBe(0);
  });

  it("shows the error page with a fixed reason, never a redirect or the document, when the fetch fails or the document is bad", async () => {
    const secret = "do-not-echo-this";
    for (const doc of [
      undefined,
      { ...claude, client_id: `${CLAUDE}-other`, client_name: secret },
      { ...claude, redirect_uris: [`https://${secret}.example/cb?x`] },
      { ...claude, client_secret: secret },
      { ...claude, token_endpoint_auth_method: secret },
      [secret],
    ]) {
      documents.clear();
      if (doc !== undefined) documents.set(CLAUDE, doc);
      const res = await authorize(params({ code_challenge: pkce().challenge }));
      expect(res.status).toBe(400);
      expect(res.headers.get("location")).toBeNull();
      const html = await res.text();
      expect(html).not.toContain(secret);
      expect(html).not.toContain("claude.ai");
    }
    expect(db.prepare("SELECT count(*) FROM mcp_clients").pluck().get()).toBe(0);
    expect(db.prepare("SELECT count(*) FROM mcp_authorizations").pluck().get()).toBe(0);
  });

  it("refuses a bad metadata URL with the error page, fetching nothing", async () => {
    for (const id of [
      "https://localhost@evil/",
      "https://@/",
      "https://h/?x=/o/",
      "https://h/#/o/",
      "https://claude.ai/",
      "https://claude.ai/a/../oauth",
      `https://claude.ai/${"x".repeat(2000)}`,
    ]) {
      const res = await authorize(params({ client_id: id, code_challenge: pkce().challenge }));
      expect(res.status, id).toBe(400);
      expect(res.headers.get("location")).toBeNull();
    }
    // An http URL is not taken for a metadata URL, and is looked up as a registration, which it is not.
    const http = await authorize(params({ client_id: "http://localhost@evil/", code_challenge: pkce().challenge }));
    expect(http.status).toBe(400);
    expect(fetched).toEqual([]);
  });

  it("refuses an exchange with another client_id, and keeps a registered client's flow unchanged alongside", async () => {
    const form = await metadataCode();
    const { form: registeredForm } = await codeFor(ownerFull, "desk");
    expect((await exchange({ ...form, client_id: `${CLAUDE}/` })).status).toBe(400);
    expect((await exchange({ ...registeredForm, client_id: CLAUDE })).status).toBe(400);
    const { form: again } = await codeFor(ownerFull, "desk");
    await accessToken(again);
  });

  it("stores the client keyed by its URL, replaced by each fetch, under the registrations' pruning", async () => {
    documents.set(CLAUDE, claude);
    await pageFor(CLAUDE, pkce().challenge, { redirect_uri: CALLBACK });
    documents.set(CLAUDE, { ...claude, client_name: "Claude 2", redirect_uris: [CALLBACK, "https://claude.ai/other"] });
    await pageFor(CLAUDE, pkce().challenge, { redirect_uri: "https://claude.ai/other" });
    const rows = db.prepare("SELECT client_id, client_name, redirect_uris FROM mcp_clients").all();
    expect(rows).toEqual([{ client_id: CLAUDE, client_name: "Claude 2", redirect_uris: JSON.stringify([CALLBACK, "https://claude.ai/other"]) }]);
    expect(db.prepare("SELECT count(*) FROM mcp_authorizations").pluck().get()).toBe(2);
    db.prepare("UPDATE mcp_authorizations SET expires_at = 0").run();
    for (let i = 0; i < MAX_CLIENTS; i++) await registered();
    expect(db.prepare("SELECT count(*) FROM mcp_clients WHERE client_id = ?").pluck().get(CLAUDE)).toBe(0);
  });

  it("a code approved with account A's token yields a token of A only", async () => {
    registerAgent(db, OWNER_ACCOUNT, "claude", "owner's claude");
    const token = await accessToken(await metadataCode(friendFull, "claude"));
    expect(listTokens(db).at(-1)).toMatchObject({ account: "friend", kind: "agent" });
    expect((await listAgents(token)).map((a) => a.name)).toEqual(["claude"]);
    expect(db.prepare("SELECT bio FROM agents WHERE account_id = ? AND name = 'claude'").pluck().get(OWNER_ACCOUNT)).toBe("owner's claude");
    expect(db.prepare("SELECT count(*) FROM agents WHERE account_id = ? AND name = 'claude'").pluck().get(friend)).toBe(1);
  });

  it("answers 503 with Retry-After to a fetch past the cap, checked before fetching, and gives the slot back", async () => {
    await http.close();
    await start({ maxSessions: 1 });
    documents.set(CLAUDE, claude);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const original = fetchMetadata;
    fetchMetadata = async (url) => {
      await gate;
      return original(url);
    };
    const held = authorize(params({ code_challenge: pkce().challenge }));
    await new Promise((r) => setTimeout(r, 100));
    const past = await authorize(params({ code_challenge: pkce().challenge }));
    expect(past.status).toBe(503);
    expect(past.headers.get("retry-after")).toBe("5");
    expect(past.headers.get("location")).toBeNull();
    expect(fetched).toEqual([]);
    // A registered client fetches nothing and is not held back by the cap.
    expect((await pageFor(await registered(), pkce().challenge)).request).toBeTruthy();
    release();
    expect((await held).status).toBe(200);
    expect((await authorize(params({ code_challenge: pkce().challenge }))).status).toBe(200);
    // A failed fetch gives its slot back too.
    fetchMetadata = async () => {
      throw new Error("down");
    };
    expect((await authorize(params({ code_challenge: pkce().challenge }))).status).toBe(400);
    fetchMetadata = original;
    expect((await authorize(params({ code_challenge: pkce().challenge }))).status).toBe(200);
  });

  it("connects through the MCP SDK's client with its clientMetadataUrl", async () => {
    documents.set(CLAUDE, claude);
    let authorizationUrl: URL | undefined;
    let verifier = "";
    let tokens: { access_token: string } | undefined;
    let info: { client_id: string } | undefined;
    const provider = {
      redirectUrl: CALLBACK,
      clientMetadataUrl: CLAUDE,
      clientMetadata: { redirect_uris: [CALLBACK], client_name: "Claude" },
      clientInformation: () => info,
      saveClientInformation: (i: { client_id: string }) => {
        info = i;
      },
      tokens: () => tokens,
      saveTokens: (t: { access_token: string }) => {
        tokens = t;
      },
      redirectToAuthorization: (url: URL) => {
        authorizationUrl = url;
      },
      saveCodeVerifier: (v: string) => {
        verifier = v;
      },
      codeVerifier: () => verifier,
    };
    const { auth } = await import("@modelcontextprotocol/sdk/client/auth.js");
    // The SDK reads the metadata at the public URL, which is this server's own address.
    expect(await auth(provider as never, { serverUrl: mcp() })).toBe("REDIRECT");
    expect(authorizationUrl!.searchParams.get("client_id")).toBe(CLAUDE);
    const page = await fetch(authorizationUrl!, { redirect: "manual" });
    expect(page.status).toBe(200);
    const html = await page.text();
    const request = /data-request="([0-9a-f]+)"/.exec(html)![1];
    const state = authorizationUrl!.searchParams.get("state");
    const approved = await approve(ownerFull, { request, state, agent: "sdk-claude" });
    const code = new URL(((await approved.json()) as { location: string }).location).searchParams.get("code")!;
    expect(await auth(provider as never, { serverUrl: mcp(), authorizationCode: code })).toBe("AUTHORIZED");
    expect((await listAgents(tokens!.access_token)).map((a) => a.name)).toContain("sdk-claude");
  });
});
