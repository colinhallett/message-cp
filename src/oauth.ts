import { createHash, randomBytes } from "node:crypto";
import { AccountError, addToken, recordClient } from "./accounts.js";
import { ToolError, registerWithIdentity, validateName } from "./agents.js";
import type { AccountId, Db } from "./db.js";

// MCP's authorization flow for `serve --public-url`: a client registers itself (RFC 7591) or names the URL of its Client
// ID Metadata Document as its `client_id`, which the authorization endpoint fetches, a person approves it in the
// browser with a full or person token of their account, and the client exchanges the code it is sent back with for an
// agent token bound to the approved agent (OAuth 2.1 authorization code with PKCE). Authorization requests and codes are
// stored only as hashes, as is the client's `state`; nothing here logs anything.

export class OAuthError extends Error {
  constructor(
    readonly error: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Client registrations kept at once, besides those with an authorization request or code not yet used or expired;
 * registering past this forgets the oldest of the rest, which has to register again.
 */
export const MAX_CLIENTS = 1000;
/** Authorization requests and codes not yet used or expired, kept at once; past this a new request is refused. */
export const MAX_AUTHORIZATIONS = 1000;
/** How long a person has to approve a request once its page is shown. */
export const AUTHORIZATION_TTL_MS = 10 * 60 * 1000;
/** How long a client has to exchange its code. */
export const CODE_TTL_MS = 2 * 60 * 1000;
const MAX_REDIRECT_URIS = 10;
const MAX_URI_LENGTH = 2000;
const MAX_CLIENT_NAME_LENGTH = 100;
const MAX_STATE_LENGTH = 1000;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Whether `url`'s host is this machine: 127.x.x.x, [::1] or the name localhost. */
export const isLoopback = (url: URL) =>
  /^127(\.\d{1,3}){3}$/.test(url.hostname) || url.hostname === "[::1]" || url.hostname === "localhost";

/**
 * Checks a redirect URI a client registers, parsed with `new URL()`: https, or http on a loopback host, with no username,
 * password, query or fragment. Unlike `publicUrl` in connect.ts, `localhost` is allowed: current clients register
 * `http://localhost:<port>/callback`, the MCP spec allows a redirect URI that is "either `localhost` or use HTTPS", and
 * what the server sends there is a code, useless without the client's PKCE verifier, never a token.
 */
export function checkRedirectUri(raw: unknown): string {
  if (typeof raw !== "string" || raw.length > MAX_URI_LENGTH) throw new OAuthError("invalid_redirect_uri", "Each redirect URI must be a URL.");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OAuthError("invalid_redirect_uri", "Each redirect URI must be a URL.");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url))) {
    throw new OAuthError("invalid_redirect_uri", "A redirect URI must be https, or http on localhost, 127.x.x.x or [::1].");
  }
  // `href` keeps an empty `?` or `#`, which `search` and `hash` report as "".
  if (url.username || url.password || url.href.includes("?") || url.href.includes("#")) {
    throw new OAuthError("invalid_redirect_uri", "A redirect URI must not carry a username, password, query or fragment.");
  }
  return raw;
}

/**
 * `raw` parsed, when it is an http URI on a loopback host written exactly as `new URL()` writes it (so no other letter
 * case, default port or encoding), with no username, password, query or fragment; otherwise undefined.
 */
function loopbackUri(raw: string): URL | undefined {
  if (raw.length > MAX_URI_LENGTH) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.href !== raw || url.protocol !== "http:" || !isLoopback(url)) return undefined;
  return url.username || url.password || raw.includes("?") || raw.includes("#") ? undefined : url;
}

/**
 * Whether `requested` is one of a client's `registered` redirect URIs: the same string, or, for an http loopback URI,
 * the same but for the port, which OAuth 2.1 (section 2.3.1) and RFC 8252 (section 7.3) let a native client choose when
 * it asks. Codex registers `http://127.0.0.1/callback/<id>` and asks with a port of its choosing. Scheme, host and path
 * are compared parsed, and both URIs must pass `loopbackUri`, so `localhost` never matches `127.0.0.1`.
 */
export function matchesRedirectUri(registered: string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  const asked = loopbackUri(requested);
  if (!asked) return false;
  return registered.some((raw) => {
    const url = loopbackUri(raw);
    return url !== undefined && url.hostname === asked.hostname && url.pathname === asked.pathname;
  });
}

export interface Client {
  clientId: string;
  clientName: string | null;
  redirectUris: string[];
}

/** Whether `clientId` names a Client ID Metadata Document by its URL, rather than a registration: it starts with https://. */
export const isMetadataUrl = (clientId: string) => clientId.startsWith("https://");

/**
 * Checks a `client_id` that `isMetadataUrl` takes for a metadata document's URL before anything is fetched, parsed with
 * `new URL()`: https, a path other than /, no username, password, query or fragment, at most MAX_URI_LENGTH characters,
 * and its own canonical form, so no dot segments and nothing `new URL()` would rewrite. The address it names is checked
 * when it is fetched (client-metadata.ts). Throws `OAuthError` with fixed text.
 */
export function checkMetadataUrl(raw: string): string {
  const bad = () => new OAuthError("invalid_client", "This client's address is not one this server fetches a description from.");
  if (raw.length > MAX_URI_LENGTH) throw bad();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw bad();
  }
  // `href` keeps an empty `?` or `#`, which `search` and `hash` report as "".
  if (url.protocol !== "https:" || url.pathname === "/" || url.username || url.password || url.href.includes("?") || url.href.includes("#")) throw bad();
  if (url.href !== raw) throw bad();
  return raw;
}

/**
 * The client a fetched Client ID Metadata Document describes, for the metadata URL `url`: a JSON object whose `client_id`
 * is `url` exactly, with 1-MAX_REDIRECT_URIS `redirect_uris`, each passing `checkRedirectUri`, an optional `client_name`
 * of at most MAX_CLIENT_NAME_LENGTH characters, `token_endpoint_auth_method` absent or "none", and no `client_secret`.
 * Other fields are ignored. Throws `OAuthError` with fixed text that never quotes the document.
 */
export function clientFromMetadata(url: string, doc: unknown): Client {
  const bad = (why: string) => new OAuthError("invalid_client_metadata", `This client's description ${why}`);
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) throw bad("is not a JSON object.");
  const input = doc as Record<string, unknown>;
  if (input.client_id !== url) throw bad("names another client_id than its own address.");
  const uris = input.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS) {
    throw bad(`must list 1-${MAX_REDIRECT_URIS} redirect URIs.`);
  }
  let redirectUris: string[];
  try {
    redirectUris = uris.map(checkRedirectUri);
  } catch {
    throw bad("lists a redirect URI this server does not accept.");
  }
  const name = input.client_name;
  if (name !== undefined && (typeof name !== "string" || name.length > MAX_CLIENT_NAME_LENGTH)) {
    throw bad(`has a client_name that is not a string of at most ${MAX_CLIENT_NAME_LENGTH} characters.`);
  }
  if ((input.token_endpoint_auth_method !== undefined && input.token_endpoint_auth_method !== "none") || "client_secret" in input) {
    throw bad("is not for a public client.");
  }
  return { clientId: url, clientName: (name as string | undefined) ?? null, redirectUris };
}

/**
 * Forgets the oldest client rows past MAX_CLIENTS that have no authorization request or code still live, with their
 * expired ones. Run inside the transaction that added a row.
 */
function pruneClients(db: Db): void {
  db.prepare(
    `DELETE FROM mcp_clients WHERE id IN (
       SELECT id FROM mcp_clients
       WHERE NOT EXISTS (SELECT 1 FROM mcp_authorizations WHERE client_id = mcp_clients.id AND expires_at > ?)
       ORDER BY id DESC LIMIT -1 OFFSET ?)`,
  ).run(Date.now(), MAX_CLIENTS);
}

/**
 * Registers a public client from an RFC 7591 request body: `client_name` (optional) and `redirect_uris`, each checked by
 * `checkRedirectUri` as the client sent it. A bad request stores nothing. Past `MAX_CLIENTS` the oldest registrations
 * with no authorization request or code still live are forgotten, with their expired ones, so registering never ends
 * another client's flow; tokens already issued are not affected. Those kept with a live one number at most
 * `MAX_AUTHORIZATIONS`.
 */
export const registerClient = (db: Db, body: unknown): Client =>
  db.transaction((): Client => {
    const input = (typeof body === "object" && body !== null && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
    const name = input.client_name;
    if (name !== undefined && (typeof name !== "string" || name.length > MAX_CLIENT_NAME_LENGTH)) {
      throw new OAuthError("invalid_client_metadata", `client_name must be a string of at most ${MAX_CLIENT_NAME_LENGTH} characters.`);
    }
    const uris = input.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS) {
      throw new OAuthError("invalid_redirect_uri", `redirect_uris must list 1-${MAX_REDIRECT_URIS} URIs.`);
    }
    const redirectUris = uris.map(checkRedirectUri);
    const clientId = randomBytes(16).toString("hex");
    db.prepare("INSERT INTO mcp_clients (client_id, client_name, redirect_uris, created_at) VALUES (?, ?, ?, ?)").run(
      clientId,
      name ?? null,
      JSON.stringify(redirectUris),
      Date.now(),
    );
    pruneClients(db);
    return { clientId, clientName: (name as string | undefined) ?? null, redirectUris };
  }).immediate();

/** The registered client `clientId`, or undefined for none. */
export function findClient(db: Db, clientId: string): (Client & { id: number }) | undefined {
  const row = db.prepare("SELECT id, client_id, client_name, redirect_uris FROM mcp_clients WHERE client_id = ?").get(clientId) as
    | { id: number; client_id: string; client_name: string | null; redirect_uris: string }
    | undefined;
  return row && { id: row.id, clientId: row.client_id, clientName: row.client_name, redirectUris: JSON.parse(row.redirect_uris) as string[] };
}

/** An authorization request shown to a person, and what the page needs to approve or refuse it. */
export interface Authorization {
  /** The handle the page sends back to approve; only its hash is stored. */
  request: string;
  client: Client;
  redirectUri: string;
  state: string | null;
}

/**
 * Where a GET on the authorization endpoint goes: an error page for a missing or unregistered client or redirect URI,
 * which is never redirected to; a redirect back with `error=invalid_request` for any other bad parameter; else the
 * approval page for a stored request.
 */
export type AuthorizeOutcome =
  | { page: "error"; message: string }
  | { page: "redirect"; location: string }
  | { page: "approve"; authorization: Authorization };

/** `redirectUri` with the query `params` (and `state`, when given) added. `redirectUri` passed `matchesRedirectUri`. */
export function redirectTo(redirectUri: string, params: Record<string, string>, state: string | null): string {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  if (state !== null) url.searchParams.set("state", state);
  return url.href;
}

/**
 * Stores the client a metadata document describes, keyed by its URL: the existing row's name and redirect URIs replaced,
 * keeping its id so requests and codes already made for it stay, or a new row, after which the oldest past MAX_CLIENTS
 * are forgotten as for a registration. Shared by every account, as a registration is.
 */
function storeMetadataClient(db: Db, client: Client): Client & { id: number } {
  const known = findClient(db, client.clientId);
  if (known) {
    db.prepare("UPDATE mcp_clients SET client_name = ?, redirect_uris = ? WHERE id = ?").run(client.clientName, JSON.stringify(client.redirectUris), known.id);
    return { ...client, id: known.id };
  }
  const id = db
    .prepare("INSERT INTO mcp_clients (client_id, client_name, redirect_uris, created_at) VALUES (?, ?, ?, ?)")
    .run(client.clientId, client.clientName, JSON.stringify(client.redirectUris), Date.now()).lastInsertRowid as number;
  pruneClients(db);
  return { ...client, id };
}

/**
 * Checks an authorization request's query and, if it may go ahead, stores it hashed with an expiry. `resource` is the
 * server's `/mcp` address, the only resource it accepts. A parameter given twice counts as bad. `fetched` is the client
 * a metadata document described, for a `client_id` that is its URL (see `clientFromMetadata`); it is stored in the same
 * transaction, in place of looking up a registration, even when the request then redirects back with an error.
 */
export const startAuthorization = (db: Db, query: URLSearchParams, resource: string, fetched?: Client): AuthorizeOutcome =>
  db.transaction((): AuthorizeOutcome => {
    const one = (key: string): string | null | undefined => {
      const values = query.getAll(key);
      return values.length === 0 ? null : values.length === 1 ? values[0] : undefined;
    };
    const clientId = one("client_id");
    let client: (Client & { id: number }) | undefined;
    if (clientId && fetched) client = fetched.clientId === clientId ? storeMetadataClient(db, fetched) : undefined;
    else if (clientId) client = findClient(db, clientId);
    if (!client) return { page: "error", message: "This client is not registered with this server. Start connecting again from the client." };
    const redirectUri = one("redirect_uri");
    if (!redirectUri || !matchesRedirectUri(client.redirectUris, redirectUri)) {
      return { page: "error", message: "The address this client asked to be sent back to is not one it registered." };
    }
    const state = one("state");
    const echoed = typeof state === "string" && state.length <= MAX_STATE_LENGTH ? state : null;
    const invalid = (): AuthorizeOutcome => ({ page: "redirect", location: redirectTo(redirectUri, { error: "invalid_request" }, echoed) });
    if (state === undefined || (state !== null && state.length > MAX_STATE_LENGTH)) return invalid();
    const challenge = one("code_challenge");
    const asked = one("resource");
    if (
      one("response_type") !== "code" ||
      !challenge ||
      !CHALLENGE.test(challenge) ||
      one("code_challenge_method") !== "S256" ||
      asked === undefined ||
      (asked !== null && asked !== resource)
    ) {
      return invalid();
    }
    const now = Date.now();
    db.prepare("DELETE FROM mcp_authorizations WHERE expires_at <= ?").run(now);
    const pending = db.prepare("SELECT count(*) FROM mcp_authorizations").pluck().get() as number;
    if (pending >= MAX_AUTHORIZATIONS) {
      return { page: "redirect", location: redirectTo(redirectUri, { error: "temporarily_unavailable" }, echoed) };
    }
    const request = randomBytes(32).toString("hex");
    db.prepare(
      `INSERT INTO mcp_authorizations (request_hash, client_id, redirect_uri, code_challenge, resource, state_hash, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(sha256(request), client.id, redirectUri, challenge, asked, state === null ? null : sha256(state), now + AUTHORIZATION_TTL_MS);
    return { page: "approve", authorization: { request, client, redirectUri, state } };
  }).immediate();

/**
 * Approves the stored request `request` for the account `account` (the approving token's), as its agent `name`: a live
 * agent of that name in the account is bound to as it is, with its key and sessions left alone; a new name makes that
 * agent, as `connectAgent` does. In one transaction it checks the request is unexpired and unused and that `state` is
 * the one it was made with, and stores a code bound to the account, agent, client, redirect URI, challenge and resource.
 * Returns where to send the person: the redirect URI with the code and state. A refusal throws `OAuthError` or
 * `ToolError` and stores nothing.
 */
export const approveAuthorization = (db: Db, account: AccountId, request: string, state: string | null, name: string): string =>
  db.transaction((): string => {
    const now = Date.now();
    const row = db
      .prepare("SELECT id, redirect_uri, state_hash FROM mcp_authorizations WHERE request_hash = ? AND code_hash IS NULL AND expires_at > ?")
      .get(sha256(request), now) as { id: number; redirect_uri: string; state_hash: string | null } | undefined;
    if (!row || row.state_hash !== (state === null ? null : sha256(state))) {
      throw new OAuthError("invalid_request", "This approval has expired or was already used. Start connecting again from the client.");
    }
    validateName(name);
    const live = db
      .prepare("SELECT id, name, person FROM agents WHERE account_id = ? AND name = ? AND removed_at IS NULL")
      .get(account, name) as { id: number; name: string; person: number } | undefined;
    if (live?.person === 1) throw new ToolError(`The name '${live.name}' belongs to a person, not an agent.`);
    const agent = live ? live.id : registerWithIdentity(db, account, name).identity.id;
    const code = randomBytes(32).toString("hex");
    db.prepare("UPDATE mcp_authorizations SET code_hash = ?, account_id = ?, agent_id = ?, expires_at = ? WHERE id = ?").run(
      sha256(code),
      account,
      agent,
      now + CODE_TTL_MS,
      row.id,
    );
    return redirectTo(row.redirect_uri, { code }, state);
  }).immediate();

export interface CodeExchange {
  code: string;
  clientId: string;
  redirectUri: string;
  verifier: string;
  /** The `resource` sent with the exchange, null for none. */
  resource: string | null;
}

/**
 * Exchanges a code for an agent token bound to the approved agent, made with `addToken` in the approving account. In one
 * transaction it finds the code and deletes it, so it is used up by its first exchange, successful or not; then it
 * checks it is unexpired, and that the client, redirect URI and resource are those of its request and the verifier
 * matches the challenge (S256). Any mismatch, or an agent removed meanwhile, throws `OAuthError` `invalid_grant` and
 * issues nothing; the code stays used up.
 */
export function exchangeCode(db: Db, exchange: CodeExchange): string {
  const result = db
    .transaction((): { token: string } | { refused: true } => {
      const row = db
        .prepare(
          `SELECT mcp_authorizations.id, mcp_clients.client_id, mcp_clients.client_name, redirect_uri, code_challenge, resource, account_id, agent_id, expires_at,
             (SELECT name FROM accounts WHERE accounts.id = mcp_authorizations.account_id) AS account
           FROM mcp_authorizations JOIN mcp_clients ON mcp_clients.id = mcp_authorizations.client_id
           WHERE code_hash = ?`,
        )
        .get(sha256(exchange.code)) as
        | {
            id: number;
            client_id: string;
            client_name: string | null;
            redirect_uri: string;
            code_challenge: string;
            resource: string | null;
            agent_id: number;
            expires_at: number;
            account: string;
          }
        | undefined;
      if (!row) return { refused: true };
      db.prepare("DELETE FROM mcp_authorizations WHERE id = ?").run(row.id);
      const challenge = createHash("sha256").update(exchange.verifier).digest("base64url");
      if (
        row.expires_at <= Date.now() ||
        row.client_id !== exchange.clientId ||
        row.redirect_uri !== exchange.redirectUri ||
        row.resource !== exchange.resource ||
        !VERIFIER.test(exchange.verifier) ||
        challenge !== row.code_challenge
      ) {
        return { refused: true };
      }
      try {
        const issued = addToken(db, row.account, false, true, row.agent_id);
        // The client row may be forgotten later (pruneClients), so what the account's approvals show is kept on the token.
        recordClient(db, issued.id, { name: row.client_name, host: isMetadataUrl(row.client_id) ? new URL(row.client_id).host : null });
        return { token: issued.token };
      } catch (err) {
        // The agent was removed since the approval: its savepoint is rolled back, the code stays used up.
        if (err instanceof AccountError) return { refused: true };
        throw err;
      }
    })
    .immediate();
  if ("refused" in result) throw new OAuthError("invalid_grant", "The code is invalid, expired or already used, or does not match this request.");
  return result.token;
}
