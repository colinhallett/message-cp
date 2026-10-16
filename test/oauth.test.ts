import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addAccount } from "../src/accounts.js";
import { registerAgent } from "../src/agents.js";
import { OWNER_ACCOUNT, openDb, type Db } from "../src/db.js";
import { startHttp, type HttpServer } from "../src/http.js";
import { sendMessage } from "../src/messages.js";
import { MAX_PENDING, MAX_UNUSED_CLIENTS, oauthConfigFromEnv, type OAuthConfig } from "../src/oauth.js";
import { startFakeGitHub, type FakeGitHub } from "./fixtures/fake-github.js";

const TOKEN = "s3cret-token";
const REDIRECT = "http://127.0.0.1:33418/callback";
let db: Db;
let http: HttpServer;
let github: FakeGitHub;
let base: string;
let open: Client[] = [];

const config = (overrides: Partial<OAuthConfig> = {}): OAuthConfig => ({
  ...oauthConfigFromEnv(
    {
      MEMORY_CP_GITHUB_CLIENT_ID: github.clientId,
      MEMORY_CP_GITHUB_CLIENT_SECRET: github.clientSecret,
      MEMORY_CP_GITHUB_ALLOWED_LOGINS: "Octo, owner-gh ,second",
      MEMORY_CP_OWNER_GITHUB_LOGIN: "OWNER-GH",
      MEMORY_CP_GITHUB_URL: github.url,
      MEMORY_CP_GITHUB_API_URL: github.url,
    },
    base,
  )!,
  ...overrides,
});

let port = 0;

beforeEach(async () => {
  db = openDb(join(mkdtempSync(join(tmpdir(), "memory-cp-oauth-")), "db.sqlite"));
  github = await startFakeGitHub();
  // The public URL has to be known before the server starts, so a free port is found first; each test then starts
  // the server it needs on it.
  const probe = await startHttp(db, { token: TOKEN, port: 0 });
  port = probe.port;
  await probe.close();
  base = `http://127.0.0.1:${port}`;
  http = undefined as never;
});

afterEach(async () => {
  for (const c of open) await c.close().catch(() => {});
  open = [];
  await http?.close();
  await github.close();
  db.close();
});

/** Starts the server with sign-in configured as `oauth`, or with it off for null. */
async function startServer(oauth: OAuthConfig | null = config()) {
  http = await startHttp(db, { token: TOKEN, port, publicUrl: base, oauth: oauth ?? undefined, waitHoldMs: 200 });
}

/** A browser: follows redirects with a cookie jar until one goes to the client's redirect URI, and returns that. */
async function browse(start: URL | string, jar = new Map<string, string>()): Promise<URL> {
  let url = new URL(start);
  for (let i = 0; i < 10; i++) {
    if (url.href.startsWith(REDIRECT.split("/callback")[0])) return url;
    const res = await fetch(url, {
      redirect: "manual",
      headers: jar.size ? { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") } : {},
    });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(";");
      const [k, v] = kv.split("=");
      if (v) jar.set(k, v);
      else jar.delete(k);
    }
    const location = res.headers.get("location");
    if (res.status !== 302 || !location) throw new Error(`stopped at ${url.pathname} with ${res.status}: ${await res.text()}`);
    url = new URL(location, url);
  }
  throw new Error("too many redirects");
}

/** The SDK's OAuth client provider, kept in memory, with the browser above in place of a real one. */
class Provider implements OAuthClientProvider {
  info?: OAuthClientInformationMixed;
  saved?: OAuthTokens;
  verifier = "";
  landed?: URL;
  get redirectUrl() {
    return REDIRECT;
  }
  get clientMetadata() {
    return { client_name: "test client", redirect_uris: [REDIRECT], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" };
  }
  state() {
    return "client-state";
  }
  clientInformation() {
    return this.info;
  }
  saveClientInformation(info: OAuthClientInformationMixed) {
    this.info = info;
  }
  tokens() {
    return this.saved;
  }
  saveTokens(tokens: OAuthTokens) {
    this.saved = tokens;
  }
  async redirectToAuthorization(url: URL) {
    this.landed = await browse(url);
  }
  saveCodeVerifier(v: string) {
    this.verifier = v;
  }
  codeVerifier() {
    return this.verifier;
  }
}

/** Connects the way Claude Code does: no token, a 401, discovery, registration, the browser, the code. */
async function signIn(as: { id: number; login: string }, provider = new Provider()): Promise<{ client: Client; provider: Provider }> {
  github.as = as;
  const url = new URL(`${base}/mcp`);
  const first = new StreamableHTTPClientTransport(url, { authProvider: provider });
  await expect(new Client({ name: "t", version: "0" }).connect(first)).rejects.toBeInstanceOf(UnauthorizedError);
  const landed = provider.landed!;
  expect(landed.searchParams.get("state")).toBe("client-state");
  const code = landed.searchParams.get("code");
  if (!code) throw new Error(`sign-in refused: ${landed.searchParams.get("error")}: ${landed.searchParams.get("error_description")}`);
  await first.finishAuth(code);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(url, { authProvider: provider }));
  open.push(client);
  return { client, provider };
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  if (res.isError) throw new Error(res.content[0].text);
  return JSON.parse(res.content[0].text);
}

/** Registers a client by hand and starts /authorize for it, returning what the raw flow needs. */
async function rawRegister(redirectUris = [REDIRECT]) {
  return fetch(`${base}/oauth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: redirectUris }) });
}
const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};
const authorizeUrl = (clientId: string, challenge: string, extra: Record<string, string> = {}) => {
  const u = new URL(`${base}/oauth/authorize`);
  for (const [k, v] of Object.entries({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "s", ...extra })) {
    u.searchParams.set(k, v);
  }
  return u;
};
const tokenRequest = (params: Record<string, string>) =>
  fetch(`${base}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params) });

/** A raw sign-in, returning the client id, the code and the verifier, for checking the token endpoint by hand. */
async function rawCode(as = { id: 1, login: "octo" }) {
  github.as = as;
  const { client_id } = (await (await rawRegister()).json()) as { client_id: string };
  const { verifier, challenge } = pkce();
  const landed = await browse(authorizeUrl(client_id, challenge, { resource: `${base}/mcp` }));
  return { clientId: client_id, code: landed.searchParams.get("code")!, verifier };
}

describe("sign-in with GitHub", () => {
  it("signs a client in from only the URL, as a new account, and the tools act as it", async () => {
    await startServer();
    const { client, provider } = await signIn({ id: 1, login: "octo" });
    expect(provider.saved?.access_token).toBeTruthy();
    expect(provider.saved?.refresh_token).toBeTruthy();
    expect(github.exchanges).toBe(1);
    await call(client, "register", { name: "a", bio: "x" });
    await call(client, "register", { name: "b", bio: "y" });
    await call(client, "send_message", { to: "b", body: "hello" });
    const row = db.prepare("SELECT a.name AS account FROM github_users g JOIN accounts a ON a.id = g.account_id WHERE g.github_id = 1").get() as { account: string };
    expect(row.account).toBe("octo");
    expect((await call(client, "list_agents")).map((a: { name: string }) => a.name)).toEqual(["a", "b"]);
    // Nothing of it is in the owner's account.
    expect(db.prepare("SELECT COUNT(*) AS n FROM agents WHERE account_id = ?").get(OWNER_ACCOUNT)).toEqual({ n: 0 });
  });

  it("answers the 401 with the resource metadata, and serves both metadata documents", async () => {
    await startServer();
    const res = await fetch(`${base}/mcp`, { method: "POST" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`);
    const resource = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
    expect(resource).toMatchObject({ resource: `${base}/mcp`, authorization_servers: [base] });
    const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    expect(as).toMatchObject({ issuer: base, code_challenge_methods_supported: ["S256"], registration_endpoint: `${base}/oauth/register` });
  });

  it("refuses a login not on the allowlist, and makes no account or token for it", async () => {
    await startServer();
    const accounts = db.prepare("SELECT COUNT(*) AS n FROM accounts").get();
    await expect(signIn({ id: 9, login: "mallory" })).rejects.toThrow(/access_denied.*mallory is not allowed/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM accounts").get()).toEqual(accounts);
    expect(db.prepare("SELECT COUNT(*) AS n FROM github_users").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM oauth_codes").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM oauth_grants").get()).toEqual({ n: 0 });
  });

  it("lets nobody in when the allowlist is unset or empty", async () => {
    await startServer(config({ allowedLogins: new Set() }));
    await expect(signIn({ id: 1, login: "octo" })).rejects.toThrow(/access_denied/);
    expect(oauthConfigFromEnv({ MEMORY_CP_GITHUB_CLIENT_ID: "a", MEMORY_CP_GITHUB_CLIENT_SECRET: "b", MEMORY_CP_GITHUB_ALLOWED_LOGINS: " , " }, base)!.allowedLogins.size).toBe(0);
  });

  it("is off without the client id, the secret or the public URL", () => {
    const env = { MEMORY_CP_GITHUB_CLIENT_ID: "a", MEMORY_CP_GITHUB_CLIENT_SECRET: "b" };
    expect(oauthConfigFromEnv(env, base)).toBeDefined();
    expect(oauthConfigFromEnv(env, undefined)).toBeUndefined();
    expect(oauthConfigFromEnv({ MEMORY_CP_GITHUB_CLIENT_ID: "a" }, base)).toBeUndefined();
    expect(oauthConfigFromEnv({ MEMORY_CP_GITHUB_CLIENT_SECRET: "b" }, base)).toBeUndefined();
  });

  it("signs the owner's login in to the owner's existing account", async () => {
    registerAgent(db, OWNER_ACCOUNT, "old-agent", "from before");
    await startServer();
    const { client } = await signIn({ id: 5, login: "owner-gh" });
    expect((await call(client, "list_agents")).map((a: { name: string }) => a.name)).toEqual(["old-agent"]);
  });

  it("gives a second allowed login its own account, which sees none of the first's agents", async () => {
    await startServer();
    const { client: first } = await signIn({ id: 1, login: "octo" });
    await call(first, "register", { name: "planner", bio: "first" });
    const { client: second } = await signIn({ id: 2, login: "second" });
    expect(await call(second, "list_agents")).toEqual([]);
    await call(second, "register", { name: "planner", bio: "second" });
    expect((await call(first, "get_agent", { name: "planner" })).bio).toBe("first");
    expect((await call(second, "get_agent", { name: "planner" })).bio).toBe("second");
  });

  it("ties the account to the GitHub id: a renamed login keeps it, and a login taken over by someone else does not inherit it", async () => {
    await startServer(config({ allowedLogins: new Set(["octo", "octo-renamed"]) }));
    const { client } = await signIn({ id: 1, login: "octo" });
    await call(client, "register", { name: "mine", bio: "x" });
    const { client: renamed } = await signIn({ id: 1, login: "octo-renamed" });
    expect((await call(renamed, "list_agents")).map((a: { name: string }) => a.name)).toEqual(["mine"]);
    const { client: newcomer } = await signIn({ id: 77, login: "octo" });
    expect(await call(newcomer, "list_agents")).toEqual([]);
  });

  it("does not link the owner's account to the owner's login once another GitHub user holds it", async () => {
    await startServer();
    await signIn({ id: 5, login: "owner-gh" });
    // Someone else later takes the owner's old login on GitHub.
    const { client } = await signIn({ id: 6, login: "owner-gh" });
    registerAgent(db, OWNER_ACCOUNT, "owners", "x");
    expect(await call(client, "list_agents")).toEqual([]);
  });

  it("refreshes, replacing the refresh token, and the old one stops working", async () => {
    await startServer();
    const { clientId, code, verifier } = await rawCode();
    const first = (await (await tokenRequest({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: REDIRECT, resource: `${base}/mcp` })).json()) as Record<string, string>;
    expect(first.expires_in).toBe(3600);
    const refreshed = await tokenRequest({ grant_type: "refresh_token", client_id: clientId, refresh_token: first.refresh_token });
    expect(refreshed.status).toBe(200);
    const second = (await refreshed.json()) as Record<string, string>;
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect((await tokenRequest({ grant_type: "refresh_token", client_id: clientId, refresh_token: first.refresh_token })).status).toBe(400);
    // The old access token went with it; the new one works.
    const mcp = (t: string) => fetch(`${base}/wait?agent=nobody`, { headers: { Authorization: `Bearer ${t}` } });
    expect((await mcp(first.access_token)).status).toBe(401);
    expect((await mcp(second.access_token)).status).toBe(404);
    // Another client cannot use it.
    const other = (await (await rawRegister()).json()) as { client_id: string };
    expect((await tokenRequest({ grant_type: "refresh_token", client_id: other.client_id, refresh_token: second.refresh_token })).status).toBe(400);
  });

  it("stores tokens, codes and states only as hashes", async () => {
    await startServer();
    const { client, provider } = await signIn({ id: 1, login: "octo" });
    await call(client, "list_agents");
    const dump = JSON.stringify(
      ["oauth_grants", "oauth_codes", "oauth_pending", "oauth_clients", "github_users"].map((t) => db.prepare(`SELECT * FROM ${t}`).all()),
    );
    expect(dump).not.toContain(provider.saved!.access_token);
    expect(dump).not.toContain(provider.saved!.refresh_token!);
  });

  it("expires access tokens", async () => {
    await startServer();
    const { client, provider } = await signIn({ id: 1, login: "octo" });
    await call(client, "list_agents");
    db.prepare("UPDATE oauth_grants SET access_expires_at = ?").run(Date.now() - 1);
    const res = await fetch(`${base}/wait?agent=x`, { headers: { Authorization: `Bearer ${provider.saved!.access_token}` } });
    expect(res.status).toBe(401);
  });

  it("stops a signed-in login's tokens once it is taken off the allowlist", async () => {
    await startServer();
    const { provider } = await signIn({ id: 1, login: "octo" });
    await http.close();
    await startServer(config({ allowedLogins: new Set(["second"]) }));
    const res = await fetch(`${base}/wait?agent=x`, { headers: { Authorization: `Bearer ${provider.saved!.access_token}` } });
    expect(res.status).toBe(401);
  });
});

describe("the authorization code", () => {
  beforeEach(() => startServer());

  it("is single-use", async () => {
    const { clientId, code, verifier } = await rawCode();
    const params = { grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: REDIRECT };
    expect((await tokenRequest(params)).status).toBe(200);
    expect((await tokenRequest(params)).status).toBe(400);
  });

  it("is bound to the verifier, the client and the redirect URI, and a wrong try uses it up", async () => {
    for (const wrong of [{ code_verifier: pkce().verifier }, { redirect_uri: "http://127.0.0.1:33418/other" }, { client_id: "nope" }]) {
      const { clientId, code, verifier } = await rawCode();
      const params = { grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: REDIRECT };
      expect((await tokenRequest({ ...params, ...wrong })).status).toBeGreaterThanOrEqual(400);
      expect((await tokenRequest(params)).status).toBe(wrong.client_id ? 200 : 400);
    }
  });

  it("is bound to its client: another registered client cannot redeem it", async () => {
    const { code, verifier } = await rawCode();
    const other = (await (await rawRegister()).json()) as { client_id: string };
    expect((await tokenRequest({ grant_type: "authorization_code", client_id: other.client_id, code, code_verifier: verifier, redirect_uri: REDIRECT })).status).toBe(400);
  });

  it("expires", async () => {
    const { clientId, code, verifier } = await rawCode();
    db.prepare("UPDATE oauth_codes SET expires_at = ?").run(Date.now() - 1);
    expect((await tokenRequest({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: REDIRECT })).status).toBe(400);
  });

  it("rejects a resource other than this server's /mcp", async () => {
    const { clientId, code, verifier } = await rawCode();
    const res = await tokenRequest({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: REDIRECT, resource: "https://elsewhere.example/mcp" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_target");
  });
});

describe("/authorize", () => {
  beforeEach(() => startServer());
  const clientId = async () => ((await (await rawRegister()).json()) as { client_id: string }).client_id;
  const go = (u: URL) => fetch(u, { redirect: "manual" });

  it("requires S256 PKCE", async () => {
    const id = await clientId();
    for (const extra of [{ code_challenge_method: "plain" }, { code_challenge: "" }]) {
      const res = await go(authorizeUrl(id, pkce().challenge, extra));
      expect(new URL(res.headers.get("location")!).searchParams.get("error")).toBe("invalid_request");
    }
  });

  it("rejects another resource", async () => {
    const res = await go(authorizeUrl(await clientId(), pkce().challenge, { resource: "https://elsewhere.example/mcp" }));
    expect(new URL(res.headers.get("location")!).searchParams.get("error")).toBe("invalid_target");
  });

  it("never redirects to a URI the client did not register, or for an unknown client", async () => {
    const id = await clientId();
    for (const uri of [`${REDIRECT}/x`, "http://127.0.0.1:33418/callback?x=1", "http://127.0.0.1:1/callback"]) {
      const res = await go(authorizeUrl(id, pkce().challenge, { redirect_uri: uri }));
      expect(res.status).toBe(400);
      expect(res.headers.get("location")).toBeNull();
    }
    expect((await go(authorizeUrl("unknown", pkce().challenge))).status).toBe(400);
  });

  it("refuses a GitHub return with an unknown state, or in a browser other than the one that started it", async () => {
    const res = await go(authorizeUrl(await clientId(), pkce().challenge));
    const toGithub = new URL(res.headers.get("location")!);
    const state = toGithub.searchParams.get("state")!;
    // Our own state, not the client's, goes to GitHub.
    expect(state).not.toBe("s");
    expect(toGithub.searchParams.get("redirect_uri")).toBe(`${base}/oauth/github/callback`);
    const back = await fetch(`${base}/oauth/github/callback?code=x&state=${state}`, { redirect: "manual" });
    expect(back.status).toBe(400);
    expect(await back.text()).toContain("another browser");
    // That attempt used the state up.
    const cookie = res.headers.getSetCookie()[0].split(";")[0];
    const again = await fetch(`${base}/oauth/github/callback?code=x&state=${state}`, { redirect: "manual", headers: { Cookie: cookie } });
    expect(again.status).toBe(400);
    expect((await fetch(`${base}/oauth/github/callback?code=x&state=forged`, { redirect: "manual" })).status).toBe(400);
  });
});

describe("client registration", () => {
  beforeEach(() => startServer());

  it("accepts only loopback http redirect URIs", async () => {
    for (const uri of ["http://localhost:1234/cb", "http://127.0.0.1/cb", "http://[::1]:9/cb"]) expect((await rawRegister([uri])).status).toBe(201);
    for (const uri of ["https://evil.example/cb", "http://evil.example/cb", "http://127.0.0.1.evil.example/cb", "javascript:alert(1)", "http://127.0.0.1/cb#x"]) {
      expect((await rawRegister([uri])).status).toBe(400);
    }
    expect((await rawRegister([])).status).toBe(400);
  });

  it("caps unused registrations, and deletes them once they expire", async () => {
    const insert = db.prepare("INSERT INTO oauth_clients (id, name, redirect_uris, created_at) VALUES (?, NULL, '[]', ?)");
    db.transaction(() => {
      for (let i = 0; i < MAX_UNUSED_CLIENTS; i++) insert.run(`c${i}`, Date.now());
    })();
    expect((await rawRegister()).status).toBe(503);
    db.prepare("UPDATE oauth_clients SET created_at = 0").run();
    expect((await rawRegister()).status).toBe(201);
    expect(db.prepare("SELECT COUNT(*) AS n FROM oauth_clients").get()).toEqual({ n: 1 });
  });

  it("caps sign-ins waiting on GitHub, and deletes them once they expire", async () => {
    const id = ((await (await rawRegister()).json()) as { client_id: string }).client_id;
    const insert = db.prepare("INSERT INTO oauth_pending (state_hash, browser_hash, client_id, redirect_uri, code_challenge, expires_at) VALUES (?, '', ?, '', '', ?)");
    db.transaction(() => {
      for (let i = 0; i < MAX_PENDING; i++) insert.run(`p${i}`, id, Date.now() + 60_000);
    })();
    const full = await fetch(authorizeUrl(id, pkce().challenge), { redirect: "manual" });
    expect(new URL(full.headers.get("location")!).searchParams.get("error")).toBe("temporarily_unavailable");
    db.prepare("UPDATE oauth_pending SET expires_at = 0").run();
    const ok = await fetch(authorizeUrl(id, pkce().challenge), { redirect: "manual" });
    expect(new URL(ok.headers.get("location")!).origin).toBe(github.url);
    expect(db.prepare("SELECT COUNT(*) AS n FROM oauth_pending").get()).toEqual({ n: 1 });
  });
});

describe("waking an agent signed in with GitHub", () => {
  beforeEach(() => startServer());
  const waitWithKey = (agent: string, key: string) => fetch(`${base}/wait?agent=${agent}`, { headers: { "X-Memory-Cp-Agent-Key": key } });

  it("lets /wait take the agent's own key, and only for that agent", async () => {
    const { client } = await signIn({ id: 1, login: "octo" });
    const { key } = await call(client, "register", { name: "alice", bio: "x" });
    await call(client, "register", { name: "bob", bio: "y" });
    await call(client, "send_message", { to: "alice", body: "hi" });
    const res = await waitWithKey("alice", key);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("1 unread message from bob\n");
    // The key reaches only its own agent, not another of the same account, and is no token for /mcp.
    expect((await waitWithKey("bob", key)).status).toBe(401);
    expect((await fetch(`${base}/mcp`, { method: "POST", headers: { "X-Memory-Cp-Agent-Key": key } })).status).toBe(401);
    expect((await waitWithKey("alice", "wrong")).status).toBe(401);
  });

  it("refuses a name and key that two accounts both hold", async () => {
    registerAgent(db, OWNER_ACCOUNT, "twin", "x", "same-key");
    expect((await waitWithKey("twin", "same-key")).status).toBe(204);
    addAccount(db, "other");
    registerAgent(db, 2, "twin", "y", "same-key");
    expect((await waitWithKey("twin", "same-key")).status).toBe(401);
  });

  it("gives a waitCommand and instructions that read the key from the agent's file, and the command wakes", async () => {
    const { client } = await signIn({ id: 1, login: "octo" });
    expect(client.getInstructions()).toContain("~/.memory-cp/agent-keys/<your-name>");
    const reg = await call(client, "register", { name: "alice", bio: "x" });
    await call(client, "register", { name: "bob", bio: "y" });
    expect(reg.waitCommand).not.toContain(reg.key);
    const home = mkdtempSync(join(tmpdir(), "memory-cp-home-"));
    mkdirSync(join(home, ".memory-cp/agent-keys"), { recursive: true });
    writeFileSync(join(home, ".memory-cp/agent-keys/alice"), `${reg.key}\n`, { mode: 0o600 });
    const child = spawn("sh", ["-c", reg.waitCommand], { env: { PATH: process.env.PATH!, HOME: home } });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    const exited = new Promise<number | null>((r) => child.on("close", r));
    await new Promise((r) => setTimeout(r, 500));
    await call(client, "send_message", { to: "alice", body: "wake" });
    expect(await exited).toBe(0);
    expect(out).toBe("1 unread message from bob\n");
  }, 20_000);
});

describe("with sign-in not configured", () => {
  beforeEach(() => startServer(null));

  it("has none of the endpoints, answers 401 as before, and /wait refuses an agent key", async () => {
    const res = await fetch(`${base}/mcp`, { method: "POST" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
    for (const path of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-authorization-server", "/oauth/register", "/oauth/authorize", "/oauth/github/callback", "/oauth/token"]) {
      expect((await fetch(`${base}${path}`)).status).toBe(401);
    }
    registerAgent(db, OWNER_ACCOUNT, "alice", "x", "k");
    sendMessage(db, OWNER_ACCOUNT, "alice", "alice", "x");
    expect((await fetch(`${base}/wait?agent=alice`, { headers: { "X-Memory-Cp-Agent-Key": "k" } })).status).toBe(401);
    expect((await fetch(`${base}/wait?agent=alice`, { headers: { Authorization: `Bearer ${TOKEN}` } })).status).toBe(200);
  });
});

