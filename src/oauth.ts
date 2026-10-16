import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { OWNER_ACCOUNT, type AccountId, type Db } from "./db.js";

// Sign-in with GitHub, through the authorization flow in the MCP specification. This server is its own OAuth
// authorization server: MCP clients register here, sign in here and get tokens from here. GitHub is asked only who
// the person is, once per sign-in, and its token is dropped straight after; it is never stored or handed on.
// Every token and code is stored only as its hash, and nothing here logs one, or anything GitHub answers.

export interface OAuthConfig {
  /** The URL clients reach this server at, without /mcp. */
  publicUrl: string;
  githubClientId: string;
  githubClientSecret: string;
  /** Lower-cased GitHub logins that may sign in. Empty lets nobody in. */
  allowedLogins: Set<string>;
  /** Lower-cased GitHub login linked to the owner's account at its first sign-in. */
  ownerLogin?: string;
  /** github.com and api.github.com; other values are for tests against a fake GitHub. */
  githubUrl: string;
  githubApiUrl: string;
}

/** Sign-in is configured only when the GitHub app's id and secret and the public URL are all set. */
export function oauthConfigFromEnv(env: NodeJS.ProcessEnv, publicUrl: string | undefined): OAuthConfig | undefined {
  const githubClientId = env.MEMORY_CP_GITHUB_CLIENT_ID;
  const githubClientSecret = env.MEMORY_CP_GITHUB_CLIENT_SECRET;
  if (!githubClientId || !githubClientSecret || !publicUrl) return undefined;
  const logins = (s: string | undefined) =>
    (s ?? "")
      .split(",")
      .map((l) => l.trim().toLowerCase())
      .filter((l) => l !== "");
  return {
    publicUrl: publicUrl.replace(/\/+$/, ""),
    githubClientId,
    githubClientSecret,
    allowedLogins: new Set(logins(env.MEMORY_CP_GITHUB_ALLOWED_LOGINS)),
    ownerLogin: logins(env.MEMORY_CP_OWNER_GITHUB_LOGIN)[0],
    githubUrl: (env.MEMORY_CP_GITHUB_URL || "https://github.com").replace(/\/+$/, ""),
    githubApiUrl: (env.MEMORY_CP_GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, ""),
  };
}

export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const CODE_TTL_MS = 10 * 60 * 1000;
/** How long a sign-in may stay with GitHub. */
export const PENDING_TTL_MS = 10 * 60 * 1000;
/** How long a registered client is kept without ever being signed in with. */
export const UNUSED_CLIENT_TTL_MS = 24 * 60 * 60 * 1000;
// Registration, /authorize and the callback can be called by anyone, so what they store is capped.
export const MAX_UNUSED_CLIENTS = 1000;
export const MAX_PENDING = 1000;
export const MAX_CODES = 1000;
/** Sign-ins kept per account; the oldest goes when another is made. */
export const MAX_GRANTS_PER_ACCOUNT = 100;
const MAX_FORM_BYTES = 16 * 1024;
const MAX_REDIRECT_URIS = 5;
const MAX_URI_LENGTH = 512;
const GITHUB_TIMEOUT_MS = 10_000;
/**
 * Binds the GitHub leg of a sign-in to the browser that started it, so GitHub's answer for one person's sign-in,
 * handed to another browser, does nothing. One cookie per sign-in, named after a prefix of its state, so two at
 * once in one browser do not overwrite each other.
 */
const browserCookie = (githubState: string) => `memory_cp_signin_${githubState.slice(0, 8)}`;
export const CALLBACK_PATH = "/oauth/github/callback";
const NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const secret = () => randomBytes(32).toString("base64url");
const sameHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * Redirect URIs a client may register: plain http on a loopback address, which is what Claude Code and other local
 * MCP clients use. A sign-in can only ever be handed back to the person's own machine, never to a web site.
 */
function isLoopbackRedirect(uri: unknown): uri is string {
  if (typeof uri !== "string" || uri.length > MAX_URI_LENGTH) return false;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  return (
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
    !url.username &&
    !url.password &&
    !url.hash
  );
}

/** The account a sign-in's access token acts as, while it has not expired and its login is still allowed. */
export function accountForAccessToken(db: Db, config: OAuthConfig, token: string): AccountId | undefined {
  const row = db
    .prepare(
      `SELECT g.account_id, u.login FROM oauth_grants g JOIN github_users u ON u.account_id = g.account_id
       WHERE g.access_hash = ? AND g.access_expires_at > ?`,
    )
    .get(hash(token), Date.now()) as { account_id: number; login: string } | undefined;
  return row && config.allowedLogins.has(row.login.toLowerCase()) ? row.account_id : undefined;
}

/** Deletes everything that has expired, and registered clients nobody ever signed in with. */
function prune(db: Db, now = Date.now()): void {
  db.prepare("DELETE FROM oauth_pending WHERE expires_at <= ?").run(now);
  db.prepare("DELETE FROM oauth_codes WHERE expires_at <= ?").run(now);
  db.prepare("DELETE FROM oauth_grants WHERE refresh_expires_at <= ?").run(now);
  db.prepare(
    `DELETE FROM oauth_clients WHERE created_at <= ? AND id NOT IN (SELECT client_id FROM oauth_grants)
     AND id NOT IN (SELECT client_id FROM oauth_codes) AND id NOT IN (SELECT client_id FROM oauth_pending)`,
  ).run(now - UNUSED_CLIENT_TTL_MS);
}

const count = (db: Db, sql: string) => (db.prepare(sql).get() as { n: number }).n;

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

const oauthError = (res: ServerResponse, status: number, error: string, description: string) =>
  json(res, status, { error, error_description: description });

/** A page for a person in a browser, where there is no client to send the error back to. */
function page(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(`memory-cp sign-in: ${message}\n`);
}

function redirect(res: ServerResponse, to: string, headers: Record<string, string> = {}): void {
  res.writeHead(302, { Location: to, "Cache-Control": "no-store", ...headers });
  res.end();
}

/** Sends the error back to the client's redirect URI, as OAuth does once the client and its redirect are known. */
function redirectError(res: ServerResponse, redirectUri: string, state: string | null, error: string, description: string): void {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  url.searchParams.set("error_description", description);
  if (state !== null) url.searchParams.set("state", state);
  redirect(res, url.href);
}

async function readRaw(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_FORM_BYTES) throw new RangeError("body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

/** The OAuth endpoints. `handle` answers a request it owns and returns true, or returns false for anything else. */
export class OAuth {
  readonly resource: string;
  readonly resourceMetadataUrl: string;
  private readonly callbackUrl: string;
  private readonly cookieAttributes: string;

  constructor(
    private readonly db: Db,
    private readonly config: OAuthConfig,
  ) {
    this.resource = `${config.publicUrl}/mcp`;
    this.resourceMetadataUrl = `${config.publicUrl}/.well-known/oauth-protected-resource/mcp`;
    this.callbackUrl = `${config.publicUrl}${CALLBACK_PATH}`;
    // Sent only to the callback, never readable by a script, and only over https when the server is.
    const secure = config.publicUrl.startsWith("https:") ? "; Secure" : "";
    this.cookieAttributes = `HttpOnly; SameSite=Lax; Path=${new URL(this.callbackUrl).pathname}${secure}`;
  }

  /** The challenge a request without a working token is answered with, pointing the client at the metadata. */
  get challenge(): string {
    return `Bearer resource_metadata="${this.resourceMetadataUrl}"`;
  }

  accountFor(token: string): AccountId | undefined {
    return accountForAccessToken(this.db, this.config, token);
  }

  async handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    const issuerPath = new URL(this.config.publicUrl).pathname.replace(/\/+$/, "");
    const route = (() => {
      if (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp") return "resource";
      if (path === "/.well-known/oauth-authorization-server" || path === `/.well-known/oauth-authorization-server${issuerPath}`) {
        return "metadata";
      }
      if (path === "/oauth/register") return "register";
      if (path === "/oauth/authorize") return "authorize";
      if (path === CALLBACK_PATH) return "callback";
      if (path === "/oauth/token") return "token";
      return undefined;
    })();
    if (route === undefined) return false;
    const method = route === "register" || route === "token" ? "POST" : "GET";
    if (req.method !== method) {
      res.writeHead(405, { Allow: method });
      res.end();
      return true;
    }
    if (route === "resource") this.resourceMetadata(res);
    else if (route === "metadata") this.metadata(res);
    else if (route === "register") await this.register(req, res);
    else if (route === "authorize") this.authorize(req, res);
    else if (route === "callback") await this.callback(req, res);
    else await this.token(req, res);
    return true;
  }

  private resourceMetadata(res: ServerResponse): void {
    json(res, 200, { resource: this.resource, authorization_servers: [this.config.publicUrl], bearer_methods_supported: ["header"] });
  }

  private metadata(res: ServerResponse): void {
    const base = this.config.publicUrl;
    json(res, 200, {
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
  }

  /** Dynamic client registration (RFC 7591), for public clients with loopback redirect URIs only. */
  private async register(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(await readRaw(req));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new SyntaxError("not an object");
      body = parsed as Record<string, unknown>;
    } catch (err) {
      return oauthError(res, err instanceof RangeError ? 413 : 400, "invalid_client_metadata", "Send the client metadata as a JSON object.");
    }
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || uris.length < 1 || uris.length > MAX_REDIRECT_URIS || !uris.every(isLoopbackRedirect)) {
      return oauthError(
        res,
        400,
        "invalid_redirect_uri",
        `Give 1-${MAX_REDIRECT_URIS} redirect URIs, each plain http on localhost, 127.0.0.1 or [::1]; this server signs in only local clients.`,
      );
    }
    const method = body.token_endpoint_auth_method ?? "none";
    if (method !== "none") return oauthError(res, 400, "invalid_client_metadata", "Only public clients (token_endpoint_auth_method none) are supported.");
    const grants = body.grant_types ?? ["authorization_code", "refresh_token"];
    if (!Array.isArray(grants) || !grants.every((g) => g === "authorization_code" || g === "refresh_token")) {
      return oauthError(res, 400, "invalid_client_metadata", "Only the authorization_code and refresh_token grants are supported.");
    }
    const responses = body.response_types ?? ["code"];
    if (!Array.isArray(responses) || !responses.every((r) => r === "code")) {
      return oauthError(res, 400, "invalid_client_metadata", "Only the code response type is supported.");
    }
    const name = typeof body.client_name === "string" ? body.client_name.slice(0, 100) : undefined;
    const id = secret();
    const now = Date.now();
    const stored = this.db.transaction(() => {
      prune(this.db, now);
      const unused = count(this.db, "SELECT COUNT(*) AS n FROM oauth_clients WHERE id NOT IN (SELECT client_id FROM oauth_grants)");
      if (unused >= MAX_UNUSED_CLIENTS) return false;
      this.db
        .prepare("INSERT INTO oauth_clients (id, name, redirect_uris, created_at) VALUES (?, ?, ?, ?)")
        .run(id, name ?? null, JSON.stringify(uris), now);
      return true;
    }).immediate();
    if (!stored) {
      return json(res, 503, { error: "temporarily_unavailable", error_description: "Too many clients are registered; try again later." }, { "Retry-After": "60" });
    }
    json(res, 201, {
      client_id: id,
      client_id_issued_at: Math.floor(now / 1000),
      ...(name === undefined ? {} : { client_name: name }),
      redirect_uris: uris,
      token_endpoint_auth_method: "none",
      grant_types: grants,
      response_types: ["code"],
    });
  }

  /** The client's redirect URIs, or undefined for a client that is not registered. */
  private redirectUris(clientId: string | null): string[] | undefined {
    if (!clientId) return undefined;
    const row = this.db.prepare("SELECT redirect_uris FROM oauth_clients WHERE id = ?").get(clientId) as { redirect_uris: string } | undefined;
    return row && (JSON.parse(row.redirect_uris) as string[]);
  }

  /** Checks the client's request and hands the person to GitHub, remembering where to send them back. */
  private authorize(req: IncomingMessage, res: ServerResponse): void {
    const q = new URL(req.url ?? "", "http://x").searchParams;
    const clientId = q.get("client_id");
    const redirectUri = q.get("redirect_uri");
    const uris = this.redirectUris(clientId);
    // Until the client and its redirect URI check out, there is nowhere safe to send an error but the browser.
    if (!uris) return page(res, 400, "unknown client. Start the sign-in again from your MCP client.");
    if (redirectUri === null || !uris.includes(redirectUri)) return page(res, 400, "the redirect URI is not one this client registered.");
    const state = q.get("state");
    const fail = (error: string, description: string) => redirectError(res, redirectUri, state, error, description);
    if (q.get("response_type") !== "code") return fail("unsupported_response_type", "Only response_type=code is supported.");
    const challenge = q.get("code_challenge");
    if (q.get("code_challenge_method") !== "S256" || !challenge || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
      return fail("invalid_request", "PKCE with code_challenge_method S256 is required.");
    }
    const resource = q.get("resource");
    if (resource !== null && resource !== this.resource) return fail("invalid_target", `The resource must be ${this.resource}.`);
    if (state !== null && state.length > MAX_URI_LENGTH) return fail("invalid_request", "The state is too long.");

    const githubState = secret();
    const browser = secret();
    const now = Date.now();
    const stored = this.db.transaction(() => {
      prune(this.db, now);
      if (count(this.db, "SELECT COUNT(*) AS n FROM oauth_pending") >= MAX_PENDING) return false;
      this.db
        .prepare(
          `INSERT INTO oauth_pending (state_hash, browser_hash, client_id, redirect_uri, client_state, code_challenge, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(hash(githubState), hash(browser), clientId, redirectUri, state, challenge, now + PENDING_TTL_MS);
      return true;
    }).immediate();
    if (!stored) return fail("temporarily_unavailable", "Too many sign-ins are under way; try again in a few minutes.");

    const to = new URL(`${this.config.githubUrl}/login/oauth/authorize`);
    to.searchParams.set("client_id", this.config.githubClientId);
    to.searchParams.set("redirect_uri", this.callbackUrl);
    to.searchParams.set("state", githubState);
    to.searchParams.set("allow_signup", "false");
    redirect(res, to.href, {
      "Set-Cookie": `${browserCookie(githubState)}=${browser}; ${this.cookieAttributes}; Max-Age=${PENDING_TTL_MS / 1000}`,
    });
  }

  /** Who the GitHub code belongs to, as GitHub's user id and current login. GitHub's token is dropped here. */
  private async githubUser(code: string): Promise<{ id: number; login: string } | undefined> {
    const exchange = await fetch(`${this.config.githubUrl}/login/oauth/access_token`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.config.githubClientId,
        client_secret: this.config.githubClientSecret,
        code,
        redirect_uri: this.callbackUrl,
      }),
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
    const token = exchange.ok ? ((await exchange.json()) as { access_token?: unknown }).access_token : undefined;
    if (typeof token !== "string" || token === "") return undefined;
    const user = await fetch(`${this.config.githubApiUrl}/user`, {
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "User-Agent": "memory-cp" },
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
    if (!user.ok) return undefined;
    const { id, login } = (await user.json()) as { id?: unknown; login?: unknown };
    return Number.isSafeInteger(id) && typeof login === "string" && login !== "" ? { id: id as number, login } : undefined;
  }

  /**
   * The account of GitHub user `id`: the one already tied to that id, else the owner's for the owner's login if no
   * GitHub user has it yet, else a new one. Called only for an allowed login.
   */
  private accountForGithubUser(id: number, login: string): AccountId {
    return this.db.transaction((): AccountId => {
      const now = Date.now();
      const linked = this.db.prepare("SELECT account_id FROM github_users WHERE github_id = ?").get(id) as { account_id: number } | undefined;
      if (linked) {
        this.db.prepare("UPDATE github_users SET login = ? WHERE github_id = ?").run(login, id);
        return linked.account_id;
      }
      let account: AccountId;
      const ownerFree = !this.db.prepare("SELECT 1 FROM github_users WHERE account_id = ?").get(OWNER_ACCOUNT);
      if (this.config.ownerLogin === login.toLowerCase() && ownerFree) account = OWNER_ACCOUNT;
      else {
        // Named after the login if that is free, so `account list` is readable; after the GitHub id otherwise, with a
        // suffix in the unlikely case the operator already made an account of that name.
        const taken = (name: string) => !!this.db.prepare("SELECT 1 FROM accounts WHERE name = ?").get(name);
        let name = NAME_PATTERN.test(login) && !taken(login) ? login : `github-${id}`;
        for (let n = 2; taken(name); n++) name = `github-${id}-${n}`;
        account = (this.db.prepare("INSERT INTO accounts (name, created_at) VALUES (?, ?) RETURNING id").get(name, now) as { id: number }).id;
      }
      this.db.prepare("INSERT INTO github_users (github_id, account_id, login, linked_at) VALUES (?, ?, ?, ?)").run(id, account, login, now);
      return account;
    }).immediate();
  }

  /** GitHub sends the person back here. Checks our own state and the browser, learns who they are, and hands the client a code. */
  private async callback(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const q = new URL(req.url ?? "", "http://x").searchParams;
    const githubState = q.get("state");
    // Single use: the pending sign-in is taken out whatever happens next.
    const pending = githubState
      ? (this.db.prepare("DELETE FROM oauth_pending WHERE state_hash = ? AND expires_at > ? RETURNING *").get(hash(githubState), Date.now()) as
          | { browser_hash: string; client_id: string; redirect_uri: string; client_state: string | null; code_challenge: string }
          | undefined)
      : undefined;
    if (!pending) return page(res, 400, "this sign-in is unknown or has expired. Start again from your MCP client.");
    const name = browserCookie(githubState!);
    // The cookie has done its job either way.
    res.setHeader("Set-Cookie", `${name}=; ${this.cookieAttributes}; Max-Age=0`);
    const browser = cookie(req, name);
    if (!browser || !sameHash(hash(browser), pending.browser_hash)) {
      return page(res, 400, "this sign-in was started in another browser. Start again from your MCP client.");
    }
    const fail = (error: string, description: string) => redirectError(res, pending.redirect_uri, pending.client_state, error, description);
    const code = q.get("code");
    if (!code) return fail("access_denied", "GitHub sign-in was cancelled.");
    let user: { id: number; login: string } | undefined;
    try {
      user = await this.githubUser(code);
    } catch {
      user = undefined;
    }
    if (!user) return fail("server_error", "GitHub did not confirm who you are.");
    if (!this.config.allowedLogins.has(user.login.toLowerCase())) {
      return fail("access_denied", `The GitHub login ${user.login} is not allowed on this server.`);
    }
    const account = this.accountForGithubUser(user.id, user.login);
    const issued = secret();
    const now = Date.now();
    const stored = this.db.transaction(() => {
      prune(this.db, now);
      if (count(this.db, "SELECT COUNT(*) AS n FROM oauth_codes") >= MAX_CODES) return false;
      this.db
        .prepare("INSERT INTO oauth_codes (hash, account_id, client_id, redirect_uri, code_challenge, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(hash(issued), account, pending.client_id, pending.redirect_uri, pending.code_challenge, now + CODE_TTL_MS);
      return true;
    }).immediate();
    if (!stored) return fail("temporarily_unavailable", "Too many sign-ins are under way; try again in a few minutes.");
    const to = new URL(pending.redirect_uri);
    to.searchParams.set("code", issued);
    if (pending.client_state !== null) to.searchParams.set("state", pending.client_state);
    redirect(res, to.href);
  }

  /**
   * A new access and refresh token for `account`, replacing those of `grant` when it is a refresh. A refresh never
   * extends the sign-in: it ends REFRESH_TOKEN_TTL_MS after the person signed in with GitHub, and they sign in again.
   */
  private issue(account: AccountId, clientId: string, grant?: number): Record<string, unknown> {
    const access = secret();
    const refresh = secret();
    const now = Date.now();
    if (grant === undefined) {
      this.db
        .prepare(
          `INSERT INTO oauth_grants (account_id, client_id, access_hash, access_expires_at, refresh_hash, refresh_expires_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(account, clientId, hash(access), now + ACCESS_TOKEN_TTL_MS, hash(refresh), now + REFRESH_TOKEN_TTL_MS, now);
      this.db
        .prepare("DELETE FROM oauth_grants WHERE account_id = ? AND id NOT IN (SELECT id FROM oauth_grants WHERE account_id = ? ORDER BY id DESC LIMIT ?)")
        .run(account, account, MAX_GRANTS_PER_ACCOUNT);
    } else {
      this.db
        .prepare("UPDATE oauth_grants SET access_hash = ?, access_expires_at = MIN(?, refresh_expires_at), refresh_hash = ? WHERE id = ?")
        .run(hash(access), now + ACCESS_TOKEN_TTL_MS, hash(refresh), grant);
    }
    return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TOKEN_TTL_MS / 1000, refresh_token: refresh };
  }

  /** The token endpoint: an authorization code, or a refresh token, for a new pair of tokens. */
  private async token(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let q: URLSearchParams;
    try {
      q = new URLSearchParams(await readRaw(req));
    } catch {
      return oauthError(res, 413, "invalid_request", "The request is too large.");
    }
    const clientId = q.get("client_id");
    if (!this.redirectUris(clientId)) return oauthError(res, 401, "invalid_client", "Unknown client.");
    const resource = q.get("resource");
    if (resource !== null && resource !== this.resource) return oauthError(res, 400, "invalid_target", `The resource must be ${this.resource}.`);
    const grantType = q.get("grant_type");
    const now = Date.now();

    if (grantType === "authorization_code") {
      const code = q.get("code");
      const verifier = q.get("code_verifier");
      const tokens = this.db.transaction(() => {
        // Single use: the code is gone after this, whether or not the rest checks out.
        const row = code
          ? (this.db.prepare("DELETE FROM oauth_codes WHERE hash = ? RETURNING *").get(hash(code)) as
              | { account_id: number; client_id: string; redirect_uri: string; code_challenge: string; expires_at: number }
              | undefined)
          : undefined;
        if (!row || row.expires_at <= now || row.client_id !== clientId || row.redirect_uri !== q.get("redirect_uri")) return undefined;
        if (!verifier || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return undefined;
        if (!sameHash(createHash("sha256").update(verifier).digest("base64url"), row.code_challenge)) return undefined;
        prune(this.db, now);
        return this.issue(row.account_id, clientId!);
      }).immediate();
      if (!tokens) return oauthError(res, 400, "invalid_grant", "The code is invalid, used, expired, or was issued for another client, redirect URI or verifier.");
      return json(res, 200, tokens, { Pragma: "no-cache" });
    }

    if (grantType === "refresh_token") {
      const refresh = q.get("refresh_token");
      const tokens = this.db.transaction(() => {
        const row = refresh
          ? (this.db
              .prepare(
                `SELECT g.id, g.account_id, g.client_id, u.login FROM oauth_grants g JOIN github_users u ON u.account_id = g.account_id
                 WHERE g.refresh_hash = ? AND g.refresh_expires_at > ?`,
              )
              .get(hash(refresh), now) as { id: number; account_id: number; client_id: string; login: string } | undefined)
          : undefined;
        if (!row || row.client_id !== clientId || !this.config.allowedLogins.has(row.login.toLowerCase())) return undefined;
        return this.issue(row.account_id, clientId!, row.id);
      }).immediate();
      if (!tokens) return oauthError(res, 400, "invalid_grant", "The refresh token is invalid, used or expired.");
      return json(res, 200, tokens, { Pragma: "no-cache" });
    }

    oauthError(res, 400, "unsupported_grant_type", "Use authorization_code or refresh_token.");
  }
}
