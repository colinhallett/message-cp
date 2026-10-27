import { randomUUID } from "node:crypto";
import { IncomingMessage, ServerResponse, createServer as createHttpServer, type Server } from "node:http";
import { PassThrough } from "node:stream";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { LATEST_PROTOCOL_VERSION, isInitializeRequest, isJSONRPCRequest, type RequestId } from "@modelcontextprotocol/sdk/types.js";
import { accountForToken, accountName, listApprovals, type BoundAgent, type TokenAccess } from "./accounts.js";
import { DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT, PersonError, ToolError, WrongPersonError, registerWithIdentity, type Identity } from "./agents.js";
import {
  DEFAULT_CHANNEL_LIMIT,
  MAX_CHANNEL_LIMIT,
  listAccountChannels,
  postAsPerson,
  readAccountChannel,
  type AccountChannelPage,
} from "./channels.js";
import { APPROVE_HEADERS, approvePage, errorPage } from "./approve.js";
import { mcpEndpoint } from "./connect.js";
import { DASHBOARD_FONTS, DASHBOARD_HEADERS, DASHBOARD_HTML } from "./dashboard.js";
import { LoginError, LoginRefused, NotAdminError, addInvitedPerson, cancelInvite, dashboardUrl, listInvites, loginLink, makeInvite, redeemLoginCode, type Invite } from "./login.js";
import type { AccountId, Db } from "./db.js";
import {
  DEFAULT_INBOX_LIMIT,
  MAX_INBOX_LIMIT,
  deleteConversation,
  hasUnread,
  listAccountMessages,
  listAgentsUnread,
  searchAccount,
  sendAsPerson,
  unreadSummary,
  type SearchFilters,
  type Unread,
} from "./messages.js";
import { fetchClientMetadata } from "./client-metadata.js";
import {
  OAuthError,
  approveAuthorization,
  checkMetadataUrl,
  clientFromMetadata,
  exchangeCode,
  isMetadataUrl,
  redirectTo,
  registerClient,
  startAuthorization,
  freeAgentName,
  type Client,
} from "./oauth.js";
import { DEFAULT_MAX_SESSIONS, Session, createServer, type ServerOptions } from "./server.js";
import { endSession, forgetIdleSessions, restorableSession, saveSession, sessionEnded, touchSession } from "./sessions.js";
import { DEFAULT_WAIT_HOLD_MS, formatUnread } from "./wait.js";
import { listAccountDeliveries, sendOptions, sendPending, type SendOptions } from "./webhooks.js";

export const DEFAULT_HTTP_PORT = 8787;
export const DEFAULT_HTTP_HOST = "127.0.0.1";
export const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
/**
 * The body limit for POST /api/send and /api/post. A 4000-character body is at most 48 KiB as JSON (12 bytes for an
 * escaped astral character), so this fits any valid request, and a full cap of them buffers at most 16 MiB.
 */
const MAX_PERSON_BODY_BYTES = 64 * 1024;
/** What POST /api/send and /api/post answer a full token, which acts as no person, with its 403. */
const FULL_TOKEN_SENDS =
  "A full token cannot send or post as a person. Sign in as a person to send: run message-cp login-link --url <public url> --account <account> --person <name> on the server";
/** What POST /api/people and the /api/invites routes answer a full token, which is no admin person, with its 403. */
const FULL_TOKEN_INVITES =
  "A full token cannot add people or make invites. Sign in as an admin person: run message-cp login-link --url <public url> --account <account> --person <name> on the server";
/** The body limit for the OAuth registration, approval and token endpoints, which take a few short fields. */
const MAX_OAUTH_BODY_BYTES = 16 * 1024;
/** An agent seen this recently counts as online in GET /api/agents, as does one with a GET /wait held now. */
export const ONLINE_WINDOW_MS = 5 * 60 * 1000;
/** How often a pass over the webhook delivery queue is due; a tick while a pass is still running is skipped. */
export const DEFAULT_WEBHOOK_INTERVAL_MS = 5000;

export interface HttpOptions {
  /** The owner's token (MESSAGE_CP_HTTP_TOKEN). Tokens created with `message-cp token add` work as well, as their account. */
  token: string;
  host?: string;
  port?: number;
  idleTimeoutMs?: number;
  /** Most MCP sessions kept at once; further initializes get 503 until one ends or idles out. */
  maxSessions?: number;
  /** The URL clients reach this server at (it may sit behind a proxy); without it no wait command is offered. */
  publicUrl?: string;
  /** How long GET /wait holds a request with no mail before answering 204. */
  waitHoldMs?: number;
  /** How often a pass sends queued webhook deliveries. */
  webhookIntervalMs?: number;
  /** Passed to `sendPending`, so tests can shorten the timeout. */
  webhookOptions?: Omit<SendOptions, "signal">;
  /**
   * Fetches a Client ID Metadata Document, so tests can serve one from a loopback server; `fetchClientMetadata` by
   * default. `serve` never passes it: src/cli.ts passes only `token`, `host`, `port` and `publicUrl`.
   */
  fetchClientMetadata?: (url: string) => Promise<unknown>;
}

export interface HttpServer {
  server: Server;
  /** The port actually bound (useful with port 0). */
  port: number;
  /** Number of live MCP sessions. */
  sessionCount(): number;
  close(): Promise<void>;
}

interface Live {
  transport: StreamableHTTPServerTransport;
  lastUsed: number;
  /** The account whose token started the session; only that account's tokens can use it. */
  account: AccountId;
  /** For a restored session, settles once its transport has been initialized; requests wait for it. */
  ready?: Promise<void>;
  /** The session its tools act through, which knows the agent it is currently registered as. */
  session?: Session;
  /** For each request on the session whose response is still open, aborted when that response closes. */
  open: Map<RequestId, AbortController>;
}

const isBusy = (err: unknown) => {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.startsWith("SQLITE_BUSY");
};

/**
 * Runs the database work that keeps a registered session restorable. It never throws: if it fails, the session works
 * as before, but the work is not retried, so a restart may lose the session. A lock held past the busy timeout is
 * skipped quietly; any other error logs one fixed line, never anything about the session. Returns false if the lock was
 * held past the busy timeout.
 */
function recordSession(work: () => void): boolean {
  try {
    work();
  } catch (err) {
    if (isBusy(err)) return false;
    console.error("message-cp serve: could not record a session for restarts");
  }
  return true;
}

/**
 * Initializes a new transport for a restored session in-process, so that it accepts the client's requests on the
 * session id it already holds. The transport accepts nothing but an initialize until it has handled one. Its answer
 * is discarded; the server reads nothing from it.
 */
async function prime(transport: StreamableHTTPServerTransport): Promise<void> {
  const socket = new PassThrough();
  socket.resume();
  const req = new IncomingMessage(socket as never);
  req.method = "POST";
  req.url = "/mcp";
  // The transport builds a URL from the Host header, so it needs one; nothing else reads it.
  const headers = { host: DEFAULT_HTTP_HOST, "content-type": "application/json", accept: "application/json, text/event-stream" };
  req.headers = headers;
  req.rawHeaders = Object.entries(headers).flat();
  req.push(null);
  const res = new ServerResponse(req);
  res.assignSocket(socket as never);
  const finished = new Promise<void>((resolve) => res.on("finish", () => resolve()));
  await transport.handleRequest(req, res, {
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "message-cp restore", version: "0" } },
  });
  await finished;
  socket.destroy();
  if (res.statusCode !== 200) throw new Error("could not restore a session");
}

interface AgentHeaders {
  name: string;
  key: string;
}

/**
 * The agent and key a request names in X-Message-CP-Agent and X-Message-CP-Agent-Key: undefined if it sends neither,
 * null if it sends only one or either more than once. `headersDistinct` keeps a repeated header's values apart, where
 * `headers` would join them into one.
 */
function agentHeaders(req: IncomingMessage): AgentHeaders | undefined | null {
  const name = req.headersDistinct["x-message-cp-agent"];
  const key = req.headersDistinct["x-message-cp-agent-key"];
  if (name === undefined && key === undefined) return undefined;
  if (name?.length !== 1 || key?.length !== 1) return null;
  return { name: name[0], key: key[0] };
}

/** Whether `identity` is the registration `agent` holds now; false for none. */
const isAgent = (identity: Identity | undefined, agent: BoundAgent) =>
  identity !== undefined && identity.id === agent.id && identity.registeredAt === agent.registeredAt && identity.instance === agent.instance;

/** The account the request's bearer token belongs to, checked afresh on every request so a revoked token stops at once. */
function accountOf(db: Db, header: string | undefined, ownerToken: string): TokenAccess | undefined {
  const m = /^bearer +(.*)$/i.exec(header ?? "");
  // Hash something even without a header, so a refusal takes about as long either way.
  const account = accountForToken(db, m?.[1] ?? "", ownerToken);
  return m === null ? undefined : account;
}

function reply(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

function sendJson(res: ServerResponse, value: unknown): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}

/**
 * The `limit` and `offset` of a GET /api/* query, or undefined if either is bad. A key given twice is refused like a
 * bad value, so no value supplied is silently ignored.
 */
function page(query: URLSearchParams, defaultLimit: number, maxLimit: number): { limit: number; offset: number } | undefined {
  const number = (key: string, fallback: number, min: number, max: number) => {
    const values = query.getAll(key);
    if (values.length === 0) return fallback;
    if (values.length > 1) return undefined;
    const raw = values[0];
    const n = /^[0-9]+$/.test(raw) ? Number(raw) : NaN;
    return Number.isSafeInteger(n) && n >= min && n <= max ? n : undefined;
  };
  const limit = number("limit", defaultLimit, 1, maxLimit);
  const offset = number("offset", 0, 0, Number.MAX_SAFE_INTEGER);
  return limit === undefined || offset === undefined ? undefined : { limit, offset };
}

/**
 * Runs the database work of an /api/* request. A lock held past the busy timeout is transient, so it answers 503 with
 * Retry-After rather than 500, and returns undefined; any other error is thrown.
 */
function unlessBusy<T>(res: ServerResponse, work: () => T): T | undefined {
  try {
    return work();
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (typeof code !== "string" || !code.startsWith("SQLITE_BUSY")) throw err;
    reply(res, 503, "Database busy", { "Retry-After": "1" });
    return undefined;
  }
}

async function readText(req: IncomingMessage, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new RangeError("body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const readBody = async (req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<unknown> => JSON.parse(await readText(req, maxBytes));

/** An OAuth error answer (RFC 6749 section 5.2), never cached. Its description never quotes the request. */
function oauthError(res: ServerResponse, status: number, error: string, description: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify({ error, error_description: description }));
}

function sendOAuthJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}

/**
 * What `serve --public-url` advertises for MCP's authorization flow: the protected resource metadata (RFC 9728) for
 * /mcp, the authorization server metadata (RFC 8414), and the 401's WWW-Authenticate challenge pointing at the first.
 * `publicUrl` is one `serve` checked with `publicUrl` in connect.ts.
 */
function oauthUrls(publicUrl: string) {
  const base = new URL(publicUrl);
  const prefix = base.pathname.replace(/\/+$/, "");
  const at = (path: string) => {
    const url = new URL(base.href);
    // Set as the path, never resolved as a reference, so no path can change the host.
    url.pathname = `${prefix}${path}`;
    return url.href;
  };
  // The public URL, without the slash a URL with no path gets, as an issuer is usually written.
  const issuer = prefix ? at("") : base.origin;
  const resourceMetadata = at("/.well-known/oauth-protected-resource/mcp");
  return {
    resource: { resource: mcpEndpoint(publicUrl).href, authorization_servers: [issuer], bearer_methods_supported: ["header"] },
    server: {
      issuer,
      authorization_endpoint: at("/oauth/authorize"),
      token_endpoint: at("/oauth/token"),
      registration_endpoint: at("/oauth/register"),
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      client_id_metadata_document_supported: true,
    },
    challenge: `Bearer resource_metadata="${resourceMetadata}"`,
    // Where each metadata document is asked for: at the root, and, for a public URL with a path, with that path after
    // the well-known part, as RFC 8414 and RFC 9728 build it from an issuer or resource with a path.
    resourcePaths: new Set([
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
      `/.well-known/oauth-protected-resource${prefix}/mcp`,
    ]),
    serverPaths: new Set(["/.well-known/oauth-authorization-server", `/.well-known/oauth-authorization-server${prefix}`]),
    // The origin a browser names in Origin on a request from the approval page or the dashboard, and the path the
    // sign-in cookie is sent under: the approval page's directory, /oauth/ under the public URL's path.
    origin: base.origin,
    cookiePath: `${prefix}/oauth/`,
    // Whether the sign-in cookie is offered at all: only under an https public URL, so the cookie is always Secure. A
    // browser sends a cookie to every port of its host, so over http one would also reach any other server on that host
    // that the browser opens, such as a client's loopback redirect URI, with the token in it.
    signin: base.protocol === "https:",
  };
}

/** Who a sign-in approves as, as GET /oauth/signin answers and POST /oauth/approve's `as` repeats. */
type SignedIn = { account: string; person?: string };

/** The cookie the approval page signs in with: the dashboard's token, set by POST /oauth/signin. */
const SIGNIN_COOKIE = "message-cp-signin";

/** The value of the sign-in cookie in `header`, or undefined for none or more than one. */
function signinCookie(header: string | undefined): string | undefined {
  const values = (header ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${SIGNIN_COOKIE}=`))
    .map((part) => part.slice(SIGNIN_COOKIE.length + 1));
  if (values.length !== 1) return undefined;
  try {
    return decodeURIComponent(values[0]);
  } catch {
    return undefined;
  }
}

/**
 * Whether `req` comes from a page of this server's own origin, as a browser says: Origin, which it sends on every
 * POST and DELETE, equal to `origin`; or, without Origin (a same-origin GET), Sec-Fetch-Site "same-origin". A request
 * with neither, as from a script outside a browser, is not.
 */
function sameOrigin(req: IncomingMessage, origin: string): boolean {
  const named = req.headersDistinct.origin;
  if (named !== undefined) return named.length === 1 && named[0] === origin;
  const site = req.headersDistinct["sec-fetch-site"];
  return site?.length === 1 && site[0] === "same-origin";
}

/**
 * Serves the MCP tools over streamable HTTP at /mcp, one `Session` per MCP session. Every request needs the token,
 * except GET / for the dashboard page, GET on each of the dashboard's font paths (`DASHBOARD_FONTS`), /health and, with
 * a public URL, the authorization flow's metadata, registration, authorization page and token endpoint, and
 * /oauth/signin and a token-less /oauth/approve, which use the sign-in cookie from this server's own origin instead.
 */
export async function startHttp(db: Db, options: HttpOptions): Promise<HttpServer> {
  if (!options.token) throw new Error("an HTTP token is required");
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs < 0) throw new Error("idleTimeoutMs must be a finite number >= 0");
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  if (!Number.isInteger(maxSessions) || maxSessions < 1) throw new Error("maxSessions must be a positive integer");
  const waitHoldMs = options.waitHoldMs ?? DEFAULT_WAIT_HOLD_MS;
  if (!Number.isFinite(waitHoldMs) || waitHoldMs < 0) throw new Error("waitHoldMs must be a finite number >= 0");
  const webhookIntervalMs = options.webhookIntervalMs ?? DEFAULT_WEBHOOK_INTERVAL_MS;
  if (!Number.isFinite(webhookIntervalMs) || webhookIntervalMs < 10) throw new Error("webhookIntervalMs must be a finite number >= 10");
  const webhookOptions = sendOptions(options.webhookOptions ?? {});
  const sessions = new Map<string, Live>();
  let initializing = 0;
  let waiting = 0;
  // POST /mcp requests for an existing session whose body is being read, so a session cannot buffer bodies unbounded.
  let reading = 0;
  // POST /api/send, /api/post, /api/people and /api/invites requests between taking a slot and answering, so buffered
  // bodies are bounded.
  let actingAsPerson = 0;
  // Held GET /wait requests per account and agent name (lower-cased, as names are unique regardless of case).
  const held = new Map<AccountId, Map<string, number>>();
  const holding = (account: AccountId, name: string, delta: number) => {
    const agents = held.get(account) ?? new Map<string, number>();
    const key = name.toLowerCase();
    const n = (agents.get(key) ?? 0) + delta;
    if (n > 0) agents.set(key, n);
    else agents.delete(key);
    if (agents.size > 0) held.set(account, agents);
    else held.delete(account);
  };

  /**
   * The lower-cased name of the agent `live` is currently registered as, or undefined if none. It never throws: a lock
   * held past the busy timeout is `null`, to try again later; any other error logs one fixed line and counts as none.
   */
  const agentOf = (live: Live): string | undefined | null => {
    try {
      return live.session?.current()?.toLowerCase();
    } catch (err) {
      if (isBusy(err)) return null;
      console.error("message-cp serve: could not check a session's agent");
      return undefined;
    }
  };

  /** Whether `live`'s current agent has a GET /wait held, looked up under the session's own account only. */
  const agentWaiting = (live: Live): boolean | null => {
    const waits = held.get(live.account);
    if (!waits) return false;
    const name = agentOf(live);
    return name === null ? null : name !== undefined && waits.has(name);
  };

  /**
   * Marks used now every session of `account` currently registered as `name`. It waits out the busy timeout once at
   * most: after a busy write the rest are marked used here but not recorded, and a busy read ends the pass.
   */
  const touchSessionsOf = (account: AccountId, name: string) => {
    const key = name.toLowerCase();
    const now = Date.now();
    let busy = false;
    for (const [id, live] of sessions) {
      if (live.account !== account) continue;
      const agent = agentOf(live);
      if (agent === null) return;
      if (agent !== key) continue;
      live.lastUsed = now;
      if (!busy) busy = !recordSession(() => touchSession(db, id, now));
    }
  };

  const drop = (id: string) => {
    const live = sessions.get(id);
    if (!live) return;
    sessions.delete(id);
    void live.transport.close().catch(() => {});
  };

  // Dropping a session in close() keeps its row, so the restart it is part of can restore it; the sweep forgets it.
  // Ended rows are kept for a second idle timeout, which covers every server's live copy only while the servers sharing
  // the database use the same timeout (`serve` always uses the default). Should one be swept early and recorded again,
  // it can still only restore the registration that recorded it, and not once that is removed.
  // A session whose agent has a GET /wait held counts as used now, so an agent stays registered while it waits. After the
  // first busy result a pass does no more database work, so it waits out the busy timeout once at most: an idle session
  // whose account has a wait held is kept for this pass, any other is dropped, and rows are forgotten on a later pass.
  const sweep = setInterval(
    () => {
      const now = Date.now();
      const cutoff = now - idleTimeoutMs;
      let busy = false;
      for (const [id, live] of sessions) {
        if (live.lastUsed >= cutoff) continue;
        const waiting = busy ? (held.has(live.account) ? null : false) : agentWaiting(live);
        if (waiting === false) drop(id);
        else if (waiting === null) busy = true;
        else {
          live.lastUsed = now;
          if (!recordSession(() => touchSession(db, id, now))) busy = true;
        }
      }
      if (!busy) recordSession(() => forgetIdleSessions(db, cutoff, cutoff - idleTimeoutMs));
    },
    Math.max(10, Math.min(60_000, idleTimeoutMs / 2)),
  );
  sweep.unref();

  // Webhook deliveries go out from here only: one pass at a time, each sending at most a batch, so outbound work is
  // bounded. `close()` stops new claims and waits for the pass in progress.
  const stopping = new AbortController();
  let sending: Promise<void> | undefined;
  const deliver = setInterval(() => {
    if (sending) return;
    sending = (async () => {
      try {
        await sendPending(db, { ...webhookOptions, signal: stopping.signal });
      } catch (err) {
        // A lock held past the busy timeout is retried on the next pass; nothing about a delivery is logged.
        const code = (err as { code?: unknown } | null)?.code;
        if (typeof code !== "string" || !code.startsWith("SQLITE_BUSY")) console.error("message-cp serve: webhook pass failed");
      } finally {
        sending = undefined;
      }
    })();
  }, webhookIntervalMs);
  deliver.unref();

  /**
   * What each session's tools are given: `wait_for_mail` and `ask` holds count with waiting GET /wait requests against
   * the same cap, and a hold ends once the response that would carry its answer has closed.
   */
  const serverOptions = (live: Live): ServerOptions => ({
    remote: true,
    publicUrl: options.publicUrl,
    hold: () => {
      if (waiting >= maxSessions) return undefined;
      waiting++;
      return () => void waiting--;
    },
    closed: (id) => live.open.get(id)?.signal,
  });

  /**
   * One check for mail, for a name or for one registration; a lock held past the busy timeout counts as no mail this
   * time, as in `message-cp wait`.
   */
  const poll = (account: AccountId, reader: string | Identity): Unread | undefined => {
    try {
      return unreadSummary(db, account, reader);
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      if (typeof code !== "string" || !code.startsWith("SQLITE_BUSY")) throw err;
      return { count: 0, senders: [], posts: 0, channels: [], mentions: 0, mentionChannels: [] };
    }
  };

  /**
   * Answers 200 with the unread summary as soon as the account's agent has mail or unread posts in a channel it has
   * joined, 204 after `waitHoldMs` without any.
   * Another account's agent is answered like an unknown one. A token bound to an agent waits only for that agent: for it
   * when `agent` is left out, and as for an unknown agent when `agent` names another. Every poll of a bound wait reads
   * the token's registration, not its name, so a hold whose agent is removed meanwhile answers 404 rather than another
   * agent's mail under the same name.
   */
  const wait = async (req: IncomingMessage, res: ServerResponse, account: AccountId, bound?: BoundAgent) => {
    if (req.method !== "GET") return reply(res, 405, "Method not allowed", { Allow: "GET" });
    const asked = new URL(req.url ?? "", "http://x").searchParams.get("agent");
    if (bound && asked && asked.toLowerCase() !== bound.name.toLowerCase()) return reply(res, 404, "No such agent");
    const name = bound ? bound.name : asked;
    const reader: string | Identity | null = bound ?? asked;
    const first = reader ? poll(account, reader) : undefined;
    if (!first) return reply(res, 404, "No such agent");
    // Mail that is already there is answered at once, whatever the cap.
    if (hasUnread(first)) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return void res.end(`${formatUnread(first)}\n`);
    }
    // Held requests are capped like sessions, so a runaway client cannot pin the server's connections.
    if (waiting >= maxSessions) return reply(res, 503, "Too many waiting requests", { "Retry-After": "5" });
    waiting++;
    holding(account, name!, 1);
    let gone = false;
    let wake: () => void = () => {};
    res.on("close", () => {
      gone = true;
      wake();
    });
    const deadline = Date.now() + waitHoldMs;
    try {
      await hold(first, account, reader!, deadline, res, () => gone, (w) => (wake = w));
    } finally {
      waiting--;
      holding(account, name!, -1);
      // The agent's sessions count as used as the hold ends, so the gap before the wait loop asks again cannot drop them.
      touchSessionsOf(account, name!);
    }
  };

  const hold = async (
    first: NonNullable<ReturnType<typeof poll>>,
    account: AccountId,
    reader: string | Identity,
    deadline: number,
    res: ServerResponse,
    isGone: () => boolean,
    setWake: (w: () => void) => void,
  ) => {
    for (let unread: typeof first | undefined = first; ; unread = poll(account, reader)) {
      if (isGone()) return;
      if (!unread) return reply(res, 404, "No such agent");
      if (hasUnread(unread)) {
        res.writeHead(200, { "Content-Type": "text/plain" });
        return void res.end(`${formatUnread(unread)}\n`);
      }
      const left = deadline - Date.now();
      if (left <= 0) {
        res.writeHead(204);
        return void res.end();
      }
      // Sleep a second, or until the client goes away; the timer is cleared either way.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(1000, left));
        setWake(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  };

  /**
   * GET /api/token: whether the request's token is read-only and whether it is agent-only, so the dashboard tells an
   * agent token that it cannot use the page, and for a person token the person's name, which the dashboard then posts
   * and sends as (the server still refuses any other), and `admin: true` while that person is an admin, so the
   * dashboard offers Delete. A full token is neither and has no person: the dashboard offers it Delete but no posting,
   * which the server refuses it. It gives nothing else about the token: no token, hash, id or account.
   */
  const apiToken = (req: IncomingMessage, res: ServerResponse, access: TokenAccess) => {
    if (req.method !== "GET") return reply(res, 405, "Method not allowed", { Allow: "GET" });
    sendJson(res, {
      readOnly: access.readOnly,
      agentOnly: access.agentOnly,
      ...(access.person && { person: access.person.name }),
      ...(access.person?.admin && { admin: true }),
    });
  };

  /**
   * GET /api/agents: one page of the account's live agents, as `list_agents` pages them, each with its unread message,
   * post and mention counts, its status line while current (null otherwise) and whether it is online. Counts only,
   * never a message or post; it reads nothing as read.
   */
  const apiAgents = (req: IncomingMessage, res: ServerResponse, account: AccountId) => {
    if (req.method !== "GET") return reply(res, 405, "Method not allowed", { Allow: "GET" });
    const query = new URL(req.url ?? "", "http://x").searchParams;
    const paging = page(query, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
    if (paging === undefined) return reply(res, 400, `limit must be 1-${MAX_LIST_LIMIT} and offset 0 or more`);
    const waits = held.get(account);
    const recent = Date.now() - ONLINE_WINDOW_MS;
    // One query, so the page and its counts describe the same moment.
    const agents = unlessBusy(res, () => listAgentsUnread(db, account, paging.limit, paging.offset));
    if (agents === undefined) return;
    sendJson(
      res,
      agents.map((a) => ({
        ...a,
        // A person is never online: their lastSeen is when they were added, and they do not wait.
        online: !a.person && ((waits?.get(a.name.toLowerCase()) ?? 0) > 0 || Date.parse(a.lastSeen) >= recent),
      })),
    );
  };

  /**
   * GET /api/channels: one page of the account's channels by name, each with its post count, last post time and the
   * names of the live agents that have joined it. No post bodies; it marks nothing read.
   */
  const apiChannels = (req: IncomingMessage, res: ServerResponse, account: AccountId) => {
    if (req.method !== "GET") return reply(res, 405, "Method not allowed", { Allow: "GET" });
    const query = new URL(req.url ?? "", "http://x").searchParams;
    const paging = page(query, DEFAULT_CHANNEL_LIMIT, MAX_CHANNEL_LIMIT);
    if (paging === undefined) return reply(res, 400, `limit must be 1-${MAX_CHANNEL_LIMIT} and offset 0 or more`);
    const channels = unlessBusy(res, () => listAccountChannels(db, account, paging.limit, paging.offset));
    if (channels === undefined) return;
    sendJson(res, channels);
  };

  /**
   * GET /api/channel-posts?channel=<name>: one page of the account's channel, oldest first, each post with whether each
   * agent of the account it mentions has read the mention. `?unread=true` answers only the posts with at least one
   * unread mention of an agent. It moves no agent's read position and marks nothing read. A channel only another account
   * has is answered like one that does not exist.
   */
  const apiChannelPosts = (req: IncomingMessage, res: ServerResponse, account: AccountId) => {
    if (req.method !== "GET") return reply(res, 405, "Method not allowed", { Allow: "GET" });
    const query = new URL(req.url ?? "", "http://x").searchParams;
    const names = query.getAll("channel");
    if (names.length !== 1) return reply(res, 404, "No such channel");
    const paging = page(query, DEFAULT_CHANNEL_LIMIT, MAX_CHANNEL_LIMIT);
    if (paging === undefined) return reply(res, 400, `limit must be 1-${MAX_CHANNEL_LIMIT} and offset 0 or more`);
    const unread = query.getAll("unread");
    if (unread.length > 1 || (unread.length === 1 && unread[0] !== "true")) return reply(res, 400, "unread must be true");
    const unreadOnly = unread.length === 1;
    let channel: AccountChannelPage | undefined;
    try {
      channel = unlessBusy(res, () => readAccountChannel(db, account, names[0], paging.limit, paging.offset, unreadOnly));
    } catch (err) {
      // An invalid name and a missing channel are the same answer, so neither says more than the other.
      if (err instanceof ToolError) return reply(res, 404, "No such channel");
      throw err;
    }
    if (channel === undefined) return;
    sendJson(res, channel);
  };

  /**
   * GET /api/messages: one page of the account's direct messages, oldest first, each with its recipient, whether it
   * has been read, and `starting`: whether it is to an agent that has not read it and a webhook delivered it.
   * `?unread=true` answers only the messages to an agent, not to a person, whose recipient has not read them. It marks
   * nothing read, so no unread count, `lastSeen` or /wait answer moves.
   */
  const apiMessages = (req: IncomingMessage, res: ServerResponse, account: AccountId) => {
    if (req.method !== "GET") return reply(res, 405, "Method not allowed", { Allow: "GET" });
    const query = new URL(req.url ?? "", "http://x").searchParams;
    const paging = page(query, DEFAULT_INBOX_LIMIT, MAX_INBOX_LIMIT);
    if (paging === undefined) return reply(res, 400, `limit must be 1-${MAX_INBOX_LIMIT} and offset 0 or more`);
    const unread = query.getAll("unread");
    if (unread.length > 1 || (unread.length === 1 && unread[0] !== "true")) return reply(res, 400, "unread must be true");
    const unreadOnly = unread.length === 1;
    const messages = unlessBusy(res, () => listAccountMessages(db, account, paging.limit, paging.offset, unreadOnly));
    if (messages === undefined) return;
    sendJson(res, messages);
  };

  /**
   * DELETE /api/conversation?a=<name>&b=<name>: deletes the account's direct messages between a and b, either way, and
   * answers how many. Reads no body and holds nothing open, so it takes no slot.
   */
  const apiConversation = (req: IncomingMessage, res: ServerResponse, account: AccountId) => {
    if (req.method !== "DELETE") return reply(res, 405, "Method not allowed", { Allow: "DELETE" });
    const query = new URL(req.url ?? "", "http://x").searchParams;
    const [a, b] = [query.getAll("a"), query.getAll("b")];
    if (a.length !== 1 || b.length !== 1 || a[0] === "" || b[0] === "") return reply(res, 400, "Give a and b once each");
    const deleted = unlessBusy(res, () => deleteConversation(db, account, a[0], b[0]));
    if (deleted === undefined) return;
    sendJson(res, { deleted });
  };

  /**
   * GET /api/webhook-deliveries: one page of the deliveries for the account's webhooks, newest first, each with its
   * status under this server's `maxAttempts`. Never a webhook's URL or secret, or a message or post body.
   */
  const apiWebhookDeliveries = (req: IncomingMessage, res: ServerResponse, account: AccountId) => {
    if (req.method !== "GET") return reply(res, 405, "Method not allowed", { Allow: "GET" });
    const query = new URL(req.url ?? "", "http://x").searchParams;
    const paging = page(query, DEFAULT_INBOX_LIMIT, MAX_INBOX_LIMIT);
    if (paging === undefined) return reply(res, 400, `limit must be 1-${MAX_INBOX_LIMIT} and offset 0 or more`);
    const deliveries = unlessBusy(res, () =>
      listAccountDeliveries(db, account, webhookOptions.maxAttempts, paging.limit, paging.offset),
    );
    if (deliveries === undefined) return;
    sendJson(res, deliveries);
  };

  /**
   * GET /api/approvals: one page of the account's unrevoked tokens the OAuth code exchange issued, newest first, each with
   * its id, its agent's name, the client's name and metadata host (each null for none) and when it was issued. A token
   * whose agent was removed is left out. Never a token, hash, code or redirect URI.
   */
  const apiApprovals = (req: IncomingMessage, res: ServerResponse, account: AccountId) => {
    if (req.method !== "GET") return reply(res, 405, "Method not allowed", { Allow: "GET" });
    const query = new URL(req.url ?? "", "http://x").searchParams;
    const paging = page(query, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
    if (paging === undefined) return reply(res, 400, `limit must be 1-${MAX_LIST_LIMIT} and offset 0 or more`);
    const approvals = unlessBusy(res, () => listApprovals(db, account, paging.limit, paging.offset));
    if (approvals === undefined) return;
    sendJson(res, approvals);
  };

  /**
   * GET /api/search?text=<text>: one page of the account's messages and channel posts whose body contains `text`,
   * newest first, with the `search` tool's filters and errors. It marks nothing read and moves no read position.
   */
  const apiSearch = (req: IncomingMessage, res: ServerResponse, account: AccountId) => {
    if (req.method !== "GET") return reply(res, 405, "Method not allowed", { Allow: "GET" });
    const query = new URL(req.url ?? "", "http://x").searchParams;
    const texts = query.getAll("text");
    if (texts.length !== 1) return reply(res, 400, "Give text once");
    const filters: SearchFilters = {};
    for (const key of ["channel", "from", "since", "until"] as const) {
      const values = query.getAll(key);
      if (values.length > 1) return reply(res, 400, `Give ${key} at most once`);
      if (values.length === 1) filters[key] = values[0];
    }
    const paging = page(query, DEFAULT_INBOX_LIMIT, MAX_INBOX_LIMIT);
    if (paging === undefined) return reply(res, 400, `limit must be 1-${MAX_INBOX_LIMIT} and offset 0 or more`);
    let found: ReturnType<typeof searchAccount> | undefined;
    try {
      found = unlessBusy(res, () => searchAccount(db, account, texts[0], filters, paging.limit, paging.offset));
    } catch (err) {
      if (err instanceof ToolError) return reply(res, 400, err.message);
      throw err;
    }
    if (found === undefined) return;
    sendJson(res, found);
  };

  /**
   * POST /api/send and /api/post: reads a JSON object whose `fields` are all strings and answers with what `act` returns
   * for it. A slot is taken before the body is read and given back at the end, so held bodies are capped like sessions.
   * Only a person token reaches it, and an `as` that is not the token's own live person, an unknown or removed name
   * included, gets 403; `act` answers undefined, which gets 404, only when given no person to match, which no route does.
   * A tool's refusal gets 400 with its message, which never quotes the body.
   */
  const asPerson = async <K extends string>(
    req: IncomingMessage,
    res: ServerResponse,
    fields: readonly K[],
    act: (input: Record<K, string>) => unknown,
  ) => {
    if (req.method !== "POST") return reply(res, 405, "Method not allowed", { Allow: "POST" });
    if (actingAsPerson >= maxSessions) return reply(res, 503, "Too many requests", { Connection: "close" });
    actingAsPerson++;
    try {
      let input: unknown;
      try {
        input = await readBody(req, MAX_PERSON_BODY_BYTES);
      } catch (err) {
        return err instanceof RangeError ? reply(res, 413, "Request body too large") : reply(res, 400, "Invalid JSON");
      }
      // Anything but an object with each field a string, an array or `null` included, has some field missing.
      if (fields.some((f) => typeof (input as Record<string, unknown> | null)?.[f] !== "string")) {
        return reply(res, 400, `Give ${fields.join(", ")} as strings`);
      }
      let done: unknown;
      try {
        // null for no such person, kept apart from the undefined `unlessBusy` gives once it has answered 503.
        done = unlessBusy(res, () => act(input as Record<K, string>) ?? null);
      } catch (err) {
        if (err instanceof WrongPersonError) return reply(res, 403, err.message);
        if (err instanceof ToolError) return reply(res, 400, err.message);
        throw err;
      }
      if (done === undefined) return;
      if (done === null) return reply(res, 404, "No such person");
      sendJson(res, done);
    } finally {
      actingAsPerson--;
    }
  };

  /**
   * POST /api/send: `{ as, to, body }`, sent as `send_message` sends it, from the account's person `as`, who must be
   * `only`, the person token's person.
   */
  const apiSend = (req: IncomingMessage, res: ServerResponse, account: AccountId, only: number) =>
    asPerson(req, res, ["as", "to", "body"], (m) => {
      // The stored ids are send_message's alone: this answer stays `{ delivered, recipients }`.
      const sent = sendAsPerson(db, account, m.as, m.to, m.body, only);
      return sent && { delivered: sent.delivered, recipients: sent.recipients };
    });

  /** POST /api/post: `{ as, channel, body }`, posted as `post` posts it, by the account's person `as`; as `apiSend` limits it. */
  const apiPost = (req: IncomingMessage, res: ServerResponse, account: AccountId, only: number) =>
    asPerson(req, res, ["as", "channel", "body"], (m) => postAsPerson(db, account, m.as, m.channel, m.body, only));

  /** An invite as POST /api/people and /api/invites answer it: with its link only when `serve` has a public URL. */
  const inviteJson = (invite: Invite) => ({
    id: invite.id,
    code: invite.code,
    expiresAt: new Date(invite.expiresAt).toISOString(),
    ...(options.publicUrl !== undefined && { link: loginLink(dashboardUrl(options.publicUrl), invite.code).href }),
  });

  /**
   * POST /api/people and /api/invites: reads a JSON object and answers with what `act` makes of it, never cached, as it
   * carries an invite's code. A slot is taken before the body is read and given back at the end, sharing `asPerson`'s
   * count. `act` answers a string for 400, undefined for 404, and throws `PersonError` for 400, `LoginError` for 503 and
   * `NotAdminError`, for a token's person removed or unmarked while the body was read, for 403.
   */
  const asAdmin = async (req: IncomingMessage, res: ServerResponse, act: (input: Record<string, unknown>) => unknown) => {
    if (actingAsPerson >= maxSessions) return reply(res, 503, "Too many requests", { Connection: "close" });
    actingAsPerson++;
    try {
      let input: unknown;
      try {
        input = await readBody(req, MAX_PERSON_BODY_BYTES);
      } catch (err) {
        return err instanceof RangeError ? reply(res, 413, "Request body too large") : reply(res, 400, "Invalid JSON");
      }
      let done: unknown;
      try {
        // null for no such person, kept apart from the undefined `unlessBusy` gives once it has answered 503.
        done = unlessBusy(res, () => act(typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {}) ?? null);
      } catch (err) {
        if (err instanceof PersonError) return reply(res, 400, err.message);
        if (err instanceof NotAdminError) return reply(res, 403, err.message);
        if (err instanceof LoginError) return reply(res, 503, err.message);
        throw err;
      }
      if (done === undefined) return;
      if (done === null) return reply(res, 404, "No such person");
      if (typeof done === "string") return reply(res, 400, done);
      sendOAuthJson(res, 200, done);
    } finally {
      actingAsPerson--;
    }
  };

  /**
   * POST /api/people: `{ name, admin }`, adds the person `name`, an admin with `admin` true, to the account and makes
   * their first invite, as `addInvitedPerson` does. Answers `{ name, admin, invite: { id, code, expiresAt, link? } }`.
   */
  const apiPeople = (req: IncomingMessage, res: ServerResponse, account: AccountId, by: number) => {
    if (req.method !== "POST") return reply(res, 405, "Method not allowed", { Allow: "POST" });
    return asAdmin(req, res, (input) => {
      if (typeof input.name !== "string" || typeof input.admin !== "boolean") return "Give name as a string and admin as true or false";
      const added = addInvitedPerson(db, account, by, input.name, input.admin);
      return { name: added.name, admin: added.admin, invite: inviteJson(added.invite) };
    });
  };

  /**
   * /api/invites. POST `{ person }`: a new invite for the account's live person `person` (any case), answered as POST
   * /api/people answers, or 404 for any other name. GET: one page of the account's invites not used, cancelled or
   * expired, newest first, never a code. DELETE `?id=<id>`: cancels the account's invite `id` while it is not used,
   * cancelled or expired, else 404, the same for another account's. GET and DELETE read no body and take no slot.
   */
  const apiInvites = (req: IncomingMessage, res: ServerResponse, account: AccountId, by: number) => {
    const query = new URL(req.url ?? "", "http://x").searchParams;
    if (req.method === "POST") {
      return asAdmin(req, res, (input) => {
        if (typeof input.person !== "string") return "Give person as a string";
        const made = makeInvite(db, account, by, input.person);
        return made && { name: made.name, admin: made.admin, invite: inviteJson(made.invite) };
      });
    }
    if (req.method === "GET") {
      const paging = page(query, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
      if (paging === undefined) return reply(res, 400, `limit must be 1-${MAX_LIST_LIMIT} and offset 0 or more`);
      const invites = unlessBusy(res, () => listInvites(db, account, paging.limit, paging.offset));
      if (invites === undefined) return;
      return sendJson(res, invites);
    }
    if (req.method === "DELETE") {
      const ids = query.getAll("id");
      if (ids.length !== 1) return reply(res, 400, "Give id once");
      const id = /^[1-9][0-9]{0,15}$/.test(ids[0]) ? Number(ids[0]) : NaN;
      const cancelled = Number.isSafeInteger(id) ? unlessBusy(res, () => cancelInvite(db, account, id)) : false;
      if (cancelled === undefined) return;
      if (!cancelled) return reply(res, 404, "No such invite");
      return sendJson(res, { cancelled: true });
    }
    return reply(res, 405, "Method not allowed", { Allow: "GET, POST, DELETE" });
  };

  // MCP's authorization flow, served only with a public URL, from which every address it advertises is built: as
  // `mcpEndpoint` builds /mcp, each path is set on the parsed URL, never resolved as a reference.
  const oauth = options.publicUrl === undefined ? undefined : oauthUrls(options.publicUrl);
  // POST /oauth/register, /oauth/approve, /oauth/token and /api/login requests between taking a slot and answering.
  let authorizing = 0;
  // GET /oauth/authorize requests fetching a client's metadata document, from before the fetch begins until it ends.
  let fetchingMetadata = 0;
  const fetchMetadata = options.fetchClientMetadata ?? ((url: string) => fetchClientMetadata(url));

  /**
   * Takes a slot for an OAuth or POST /api/login request with a body, before it is read, and answers what `act` does with
   * the body's text (at most MAX_OAUTH_BODY_BYTES); the slot is given back at the end. A lock held past the busy timeout
   * answers 503. /api/login uses it with or without a public URL.
   */
  const withOAuthBody = async (req: IncomingMessage, res: ServerResponse, act: (text: string) => void) => {
    if (req.method !== "POST") return reply(res, 405, "Method not allowed", { Allow: "POST" });
    if (authorizing >= maxSessions) return oauthError(res, 503, "temporarily_unavailable", "Too many requests", { Connection: "close", "Retry-After": "5" });
    authorizing++;
    try {
      let text: string;
      try {
        text = await readText(req, MAX_OAUTH_BODY_BYTES);
      } catch (err) {
        if (err instanceof RangeError) return oauthError(res, 413, "invalid_request", "Request body too large");
        throw err;
      }
      try {
        act(text);
      } catch (err) {
        if (!isBusy(err)) throw err;
        oauthError(res, 503, "temporarily_unavailable", "Database busy", { "Retry-After": "1" });
      }
    } finally {
      authorizing--;
    }
  };

  /** POST /oauth/register: registers a public client (RFC 7591) from a JSON body, with no token. */
  const oauthRegister = (req: IncomingMessage, res: ServerResponse) =>
    withOAuthBody(req, res, (text) => {
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return oauthError(res, 400, "invalid_client_metadata", "The body must be JSON.");
      }
      try {
        const client = registerClient(db, body);
        sendOAuthJson(res, 201, {
          client_id: client.clientId,
          ...(client.clientName === null ? {} : { client_name: client.clientName }),
          redirect_uris: client.redirectUris,
          grant_types: ["authorization_code"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        });
      } catch (err) {
        if (err instanceof OAuthError) return oauthError(res, 400, err.error, err.message);
        throw err;
      }
    });

  const showError = (res: ServerResponse, message: string) => {
    res.writeHead(400, APPROVE_HEADERS);
    res.end(errorPage(message));
  };

  /**
   * GET /oauth/authorize: checks the request, then shows the approval page, an error page for a client or redirect URI
   * that is not registered, or redirects back with the error for anything else. A `client_id` that starts with https://
   * is the URL of the client's metadata document: once the URL is checked, a slot is taken and the document fetched,
   * outside any transaction and with nothing of this request; a URL, fetch or document refused gets the error page with
   * a fixed reason, never a redirect.
   */
  const oauthAuthorize = async (req: IncomingMessage, res: ServerResponse, resource: string) => {
    if (req.method !== "GET") return reply(res, 405, "Method not allowed", { Allow: "GET" });
    const query = new URL(req.url ?? "", "http://x").searchParams;
    const ids = query.getAll("client_id");
    let fetched: Client | undefined;
    if (ids.length === 1 && isMetadataUrl(ids[0])) {
      let url: string;
      try {
        url = checkMetadataUrl(ids[0]);
      } catch (err) {
        if (err instanceof OAuthError) return showError(res, err.message);
        throw err;
      }
      // An HTML page, not an OAuth error's JSON as for the other caps: this request is a person's browser.
      if (fetchingMetadata >= maxSessions) {
        res.writeHead(503, { ...APPROVE_HEADERS, "Retry-After": "5" });
        return void res.end(errorPage("Too many clients are connecting at once. Try again in a moment."));
      }
      fetchingMetadata++;
      let doc: unknown;
      try {
        doc = await fetchMetadata(url);
      } catch {
        return showError(res, "This server could not fetch the client's description. Start connecting again from the client.");
      } finally {
        fetchingMetadata--;
      }
      try {
        fetched = clientFromMetadata(url, doc);
      } catch (err) {
        if (err instanceof OAuthError) return showError(res, err.message);
        throw err;
      }
    }
    const outcome = unlessBusy(res, () => startAuthorization(db, query, resource, fetched));
    if (outcome === undefined) return;
    if (outcome.page === "redirect") {
      res.writeHead(302, { Location: outcome.location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
      return void res.end();
    }
    if (outcome.page === "error") return showError(res, outcome.message);
    const { authorization: a } = outcome;
    res.writeHead(200, APPROVE_HEADERS);
    res.end(approvePage(a, redirectTo(a.redirectUri, { error: "access_denied" }, a.state), oauth?.signin === true));
  };

  /** Who `access`, a full or person token's, approves as: its account's name and, for a person token, its person's. */
  const signedInAs = (access: TokenAccess): SignedIn => ({
    account: accountName(db, access.account),
    ...(access.person && { person: access.person.name }),
  });

  /**
   * POST /oauth/approve: `{ request, state, agent, fresh, as }` from the approval page, with a full or person token of the
   * account the client's agent is made or found in. `fresh: true` says `agent` is the name the page suggested, left as
   * it was, so a live agent of that name is refused rather than connected as. Signed in by the cookie (`signedIn`, who
   * GET /oauth/signin says it signs in as now), `as` must be the `{ account, person? }` the page showed, so a sign-in
   * that changed since the page showed it is refused with 409 rather than approving into another account. Answers
   * `{ location }`, the redirect URI with the code, or 400 or 409 with the reason.
   */
  const oauthApprove = (req: IncomingMessage, res: ServerResponse, account: AccountId, signedIn?: SignedIn) =>
    withOAuthBody(req, res, (text) => {
      let input: Record<string, unknown> | undefined;
      try {
        input = JSON.parse(text) as Record<string, unknown>;
      } catch {
        input = undefined;
      }
      const state = input?.state;
      if (typeof input?.request !== "string" || typeof input.agent !== "string" || (state !== null && typeof state !== "string")) {
        return sendOAuthJson(res, 400, { message: "Give request, state and agent." });
      }
      const fresh = input.fresh === true;
      const as = input.as as { account?: unknown; person?: unknown } | null | undefined;
      if (signedIn && (typeof as !== "object" || as === null || as.account !== signedIn.account || (as.person ?? undefined) !== signedIn.person)) {
        return sendOAuthJson(res, 409, { message: "This browser is now signed in as someone else. Check who approves, then approve again." });
      }
      try {
        sendOAuthJson(res, 200, { location: approveAuthorization(db, account, input.request, state as string | null, input.agent, fresh) });
      } catch (err) {
        if (err instanceof OAuthError || err instanceof ToolError) return sendOAuthJson(res, 400, { message: err.message });
        throw err;
      }
    });

  /**
   * /oauth/signin: the approval page's sign-in, a cookie holding the dashboard's token, `HttpOnly` so no page script reads
   * it, `SameSite=Strict` so the browser sends it only on requests from this site, `Secure`, and sent only under the
   * approval page's path. It exists only under an https public URL (`signin` in `oauthUrls`). Every method needs a request from this server's own origin (`sameOrigin`).
   * POST, from the dashboard once a token is confirmed, sets it to the request's bearer token, which must be a full or
   * person token (403 for any other, 401 for none). GET, from the approval page, answers who the cookie's token signs in
   * as: `{ account, person? }`, with `name`, a name for the client's agent no live agent or person of the account has,
   * made from the query's `base` when it gives one; a missing or refused cookie gets 401 (and a refused one is cleared).
   * DELETE, from the dashboard's "Forget token", clears it. The token is checked afresh on each GET and approval, so a
   * revoked token stops at the next request.
   */
  const oauthSignin = (req: IncomingMessage, res: ServerResponse, o: NonNullable<typeof oauth>) => {
    if (req.method !== "GET" && req.method !== "POST" && req.method !== "DELETE") {
      return reply(res, 405, "Method not allowed", { Allow: "GET, POST, DELETE" });
    }
    if (!sameOrigin(req, o.origin)) return reply(res, 403, "Only this server's own pages can sign in");
    const attributes = `Path=${o.cookiePath}; HttpOnly; SameSite=Strict; Secure`;
    const clear = `${SIGNIN_COOKIE}=; ${attributes}; Max-Age=0`;
    const noStore = { "Cache-Control": "no-store" };
    if (req.method === "DELETE") {
      res.writeHead(204, { "Set-Cookie": clear, ...noStore });
      return void res.end();
    }
    if (req.method === "POST") {
      const m = /^bearer +(.*)$/i.exec(req.headers.authorization ?? "");
      const access = accountOf(db, req.headers.authorization, options.token);
      if (!m || access === undefined) return reply(res, 401, "Unauthorized");
      if (access.agentOnly || access.readOnly) return reply(res, 403, "Only a full or person token can approve a client");
      res.writeHead(204, { "Set-Cookie": `${SIGNIN_COOKIE}=${encodeURIComponent(m[1])}; ${attributes}`, ...noStore });
      return void res.end();
    }
    const token = signinCookie(req.headers.cookie);
    const query = new URL(req.url ?? "", "http://x").searchParams;
    const bases = query.getAll("base");
    const base = bases.length === 1 && /^[a-z0-9_-]{1,24}$/.test(bases[0]) ? bases[0] : undefined;
    const answer = unlessBusy(res, () => {
      const access = token === undefined ? undefined : accountForToken(db, token, options.token);
      if (access === undefined || access.agentOnly || access.readOnly) return null;
      const name = base === undefined ? undefined : freeAgentName(db, access.account, base);
      return { ...signedInAs(access), ...(name !== undefined && { name }) };
    });
    if (answer === undefined) return;
    if (answer === null) {
      return reply(res, 401, "Not signed in", token === undefined ? noStore : { "Set-Cookie": clear, ...noStore });
    }
    res.writeHead(200, { "Content-Type": "application/json", ...noStore });
    res.end(JSON.stringify(answer));
  };

  /** POST /oauth/token: exchanges a code for an agent token, from a form-encoded body (`authorization_code` only). */
  const oauthToken = (req: IncomingMessage, res: ServerResponse) =>
    withOAuthBody(req, res, (text) => {
      const form = new URLSearchParams(text);
      const one = (key: string) => {
        const values = form.getAll(key);
        return values.length === 1 ? values[0] : undefined;
      };
      if (form.getAll("grant_type").length !== 1) return oauthError(res, 400, "invalid_request", "Give grant_type once.");
      if (one("grant_type") !== "authorization_code") return oauthError(res, 400, "unsupported_grant_type", "Only authorization_code is supported.");
      const [code, clientId, redirectUri, verifier] = ["code", "client_id", "redirect_uri", "code_verifier"].map(one);
      const resources = form.getAll("resource");
      if (!code || !clientId || !redirectUri || !verifier || resources.length > 1) {
        return oauthError(res, 400, "invalid_request", "Give code, client_id, redirect_uri and code_verifier once each, and resource at most once.");
      }
      let token: string;
      try {
        token = exchangeCode(db, { code, clientId, redirectUri, verifier, resource: resources[0] ?? null });
      } catch (err) {
        if (err instanceof OAuthError) return oauthError(res, 400, err.error, err.message);
        throw err;
      }
      sendOAuthJson(res, 200, { access_token: token, token_type: "Bearer" });
    });

  /**
   * POST /api/login: `{ code }`, a one-time code from a `message-cp login-link` link or an invite, with no token. Answers `{ token }`,
   * a new full or person token of the code's account, or 400 with `reason` "cancelled" (an invite an admin cancelled),
   * "used" or "invalid" and a message that never quotes the code.
   */
  const apiLogin = (req: IncomingMessage, res: ServerResponse) =>
    withOAuthBody(req, res, (text) => {
      let code: unknown;
      try {
        code = (JSON.parse(text) as Record<string, unknown> | null)?.code;
      } catch {
        code = undefined;
      }
      if (typeof code !== "string") return sendOAuthJson(res, 400, { reason: "invalid", message: "Give code." });
      try {
        sendOAuthJson(res, 200, { token: redeemLoginCode(db, code) });
      } catch (err) {
        if (err instanceof LoginRefused) return sendOAuthJson(res, 400, { reason: err.reason, message: err.message });
        throw err;
      }
    });

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "").split("?")[0];
    // The dashboard page is the same constant for everyone and holds no data, so it comes before the token.
    if (req.method === "GET" && path === "/") {
      res.writeHead(200, DASHBOARD_HEADERS);
      return void res.end(DASHBOARD_HTML);
    }
    // The dashboard's fonts are the same bytes for everyone, read when the module loaded, and found by exact path only, so
    // they too come before the token. The paths carry no version and a package upgrade can change the bytes, so caches keep a
    // font for a day and are not told it is immutable.
    const font = req.method === "GET" ? DASHBOARD_FONTS.get(path) : undefined;
    if (font) {
      res.writeHead(200, {
        "Content-Type": "font/woff2",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "public, max-age=86400",
      });
      return void res.end(font);
    }
    // The health check is the same constant for everyone, reads nothing and touches no account, so it too comes before the token.
    if (path === "/health") {
      if (req.method !== "GET") return reply(res, 405, "Method not allowed", { Allow: "GET" });
      return sendJson(res, { ok: true });
    }
    // The authorization flow's metadata, registration, authorization page and token endpoint are the same for everyone and
    // reveal no account, so they too come before the token; without a public URL none of them exists.
    if (oauth && (oauth.serverPaths.has(path) || oauth.resourcePaths.has(path))) {
      if (req.method !== "GET") return reply(res, 405, "Method not allowed", { Allow: "GET" });
      return sendJson(res, oauth.serverPaths.has(path) ? oauth.server : oauth.resource);
    }
    if (oauth && path === "/oauth/register") return oauthRegister(req, res);
    if (oauth && path === "/oauth/authorize") return oauthAuthorize(req, res, oauth.resource.resource);
    if (oauth && path === "/oauth/token") return oauthToken(req, res);
    // The sign-in cookie is checked by its own route, which checks any token it is given itself.
    if (oauth?.signin && path === "/oauth/signin") return oauthSignin(req, res, oauth);
    // A full or person token approves a client, into its own account: an agent or read-only token is refused before a slot is
    // taken or a body read. The token is the request's Authorization header, as for every other path; only a request with
    // none, from a page of this server's own origin, is signed in by the sign-in cookie instead (under an https public URL
    // only), so another site cannot make a signed-in browser approve, and a script's Bearer token works as before.
    if (oauth && path === "/oauth/approve") {
      const cookie =
        oauth.signin && req.headers.authorization === undefined && sameOrigin(req, oauth.origin) ? signinCookie(req.headers.cookie) : undefined;
      const access = cookie === undefined ? accountOf(db, req.headers.authorization, options.token) : accountForToken(db, cookie, options.token);
      if (access === undefined) return reply(res, 401, "Unauthorized", { "WWW-Authenticate": oauth.challenge, Connection: "close" });
      if (access.agentOnly || access.readOnly) {
        return reply(res, 403, "Only a full or person token can approve a client", { Connection: "close" });
      }
      return oauthApprove(req, res, access.account, cookie === undefined ? undefined : signedInAs(access));
    }
    // A login link's code stands in for the token, and redeeming it reveals nothing of any account but to its holder, so
    // it too comes before the token, with or without a public URL.
    if (path === "/api/login") return apiLogin(req, res);
    // The token is the first thing any other request meets, and decides the account everything after it acts as.
    const access = accountOf(db, req.headers.authorization, options.token);
    if (access === undefined) {
      return reply(res, 401, "Unauthorized", { "WWW-Authenticate": oauth ? oauth.challenge : "Bearer" });
    }
    const { account } = access;
    // A POST to /api/people or /api/invites carries a body its 403 leaves unread, so their 403s close the connection.
    const inviting = path === "/api/people" || path === "/api/invites";
    // An agent token reaches /mcp and /wait, where it reads as its agent does, and of the /api paths only GET /api/token,
    // so the dashboard can say why it will not work; it cannot read or delete the account's conversations there. It is
    // refused before a slot is taken or a body read.
    if (
      access.agentOnly &&
      (path === "/api" || path.startsWith("/api/")) &&
      !(path === "/api/token" && req.method === "GET")
    ) {
      return reply(res, 403, "Agent tokens cannot use the dashboard API", inviting ? { Connection: "close" } : {});
    }
    if (path === "/api/token") return apiToken(req, res, access);
    if (path === "/api/agents") return apiAgents(req, res, account);
    if (path === "/api/channels") return apiChannels(req, res, account);
    if (path === "/api/channel-posts") return apiChannelPosts(req, res, account);
    if (path === "/api/messages") return apiMessages(req, res, account);
    if (path === "/api/search") return apiSearch(req, res, account);
    if (path === "/api/webhook-deliveries") return apiWebhookDeliveries(req, res, account);
    if (path === "/api/approvals") return apiApprovals(req, res, account);
    // A read-only token reaches the read-only endpoints above and nothing else: /mcp can write, and so can any path added later.
    if (access.readOnly) return reply(res, 403, "This token is read-only", inviting ? { Connection: "close" } : {});
    // A person token also sends and posts, only as its person (checked by row once the body is read), approves clients
    // (above), and, while its person is an admin, deletes the account's conversations as a full token does, adds people
    // and makes, lists and cancels invites. It reaches nothing else: not /mcp, /wait, nor any path added later. It is
    // refused before a slot is taken or a body read.
    if (access.person && path !== "/api/send" && path !== "/api/post" && !(access.person.admin && (inviting || path === "/api/conversation"))) {
      return reply(res, 403, access.person.admin ? "An admin person token only reads, sends, posts, deletes and invites" : "A person token only reads, sends and posts", { Connection: "close" });
    }
    // Only a person token sends and posts, as its own person, so nobody acts as another person: a full token, which has
    // no person, is refused before a slot is taken or a body read.
    if (path === "/api/send" || path === "/api/post") {
      if (!access.person) return reply(res, 403, FULL_TOKEN_SENDS, { Connection: "close" });
      return (path === "/api/send" ? apiSend : apiPost)(req, res, account, access.person.id);
    }
    // Only an admin person adds people and makes invites: a full token, which is no person, is refused before a slot is
    // taken or a body read. A plain person token was refused above.
    if (inviting) {
      if (!access.person) return reply(res, 403, FULL_TOKEN_INVITES, { Connection: "close" });
      return (path === "/api/people" ? apiPeople : apiInvites)(req, res, account, access.person.id);
    }
    if (path === "/api/conversation") return apiConversation(req, res, account);
    if (path === "/wait") return wait(req, res, account, access.agent);
    if (path !== "/mcp") return reply(res, 404, "Not found");
    if (req.method !== "POST" && req.method !== "GET" && req.method !== "DELETE") {
      return reply(res, 405, "Method not allowed", { Allow: "GET, POST, DELETE" });
    }

    const header = req.headers["mcp-session-id"];
    const id = Array.isArray(header) ? header[0] : header;
    // A session id this server does not hold may be one a server before it gave out: one that registered is restored
    // if it still may be. Anything else is answered at once, so that only a restore can meet the cap below.
    if (id && !sessions.has(id)) {
      const identity = unlessBusy(res, () => restorableSession(db, id, account, Date.now() - idleTimeoutMs) ?? null);
      if (identity === undefined) return;
      // A token bound to an agent restores only a session of that agent; any other looks like one that does not exist.
      if (identity === null || (access.agent && !isAgent(identity, access.agent))) {
        return reply(res, 404, "Unknown session", { Connection: "close" });
      }
      if (sessions.size + initializing >= maxSessions) return reply(res, 503, "Too many sessions", { Connection: "close" });
      restore(id, account, identity);
    }
    // A request without a session may name the agent its new session acts as. A malformed pair is answered before the
    // cap, so the cap limits only work that can go ahead, closing the connection so its unread body cannot hold it open.
    const named = id ? undefined : agentHeaders(req);
    if (named === null) {
      return reply(res, 400, "Send both X-Message-CP-Agent and X-Message-CP-Agent-Key once each, or neither", {
        Connection: "close",
      });
    }
    // A token bound to an agent acts as it with no headers; headers naming another agent are refused before the cap.
    if (named && access.agent && named.name.toLowerCase() !== access.agent.name.toLowerCase()) {
      return reply(res, 403, `This token acts only as agent '${access.agent.name}'`, { Connection: "close" });
    }
    // A request without a session can only start one. Refuse it at the cap, closing the connection so an unread
    // body cannot hold it open; otherwise take a slot now, before the body is buffered, and give it back at the end.
    if (!id && sessions.size + initializing >= maxSessions) {
      return reply(res, 503, "Too many sessions", { Connection: "close" });
    }
    // A request for a session takes a slot before its body is read, once the session is known to be the token's account's
    // (another account's looks like one that does not exist), and gives it back as soon as the body has been read, so a
    // tool call held open afterwards does not keep it.
    if (id) {
      const live = sessions.get(id);
      if (!live || live.account !== account || (access.agent && !isAgent(live.session?.registration, access.agent))) {
        return reply(res, 404, "Unknown session", { Connection: "close" });
      }
    }
    let slot = !!id && req.method === "POST";
    if (slot && reading >= maxSessions) return reply(res, 503, "Too many requests", { Connection: "close" });
    if (slot) reading++;
    const bodyRead = () => {
      if (slot) reading--;
      slot = false;
    };
    const reserved = !id && req.method === "POST";
    if (reserved) initializing++;
    try {
      await serve(req, res, id, access, named, bodyRead);
    } finally {
      bodyRead();
      if (reserved) initializing--;
    }
  };

  const serve = async (
    req: IncomingMessage,
    res: ServerResponse,
    id: string | undefined,
    access: TokenAccess,
    named?: AgentHeaders,
    bodyRead?: () => void,
  ) => {
    const { account, agent: bound } = access;
    // Tools read the token's agent from here, so a bound token cannot `register` or remove another name on any session.
    if (bound) (req as IncomingMessage & { auth?: AuthInfo }).auth = { token: "", clientId: "", scopes: [], extra: { agent: bound.name } };
    let body: unknown;
    if (req.method === "POST") {
      try {
        body = await readBody(req);
      } catch (err) {
        return err instanceof RangeError ? reply(res, 413, "Request body too large") : reply(res, 400, "Invalid JSON");
      } finally {
        bodyRead?.();
      }
    }

    if (id) {
      const live = sessions.get(id);
      // Another account's session looks like one that does not exist, as does another agent's to a bound token.
      if (!live || live.account !== account || (bound && !isAgent(live.session?.registration, bound))) {
        return reply(res, 404, "Unknown session");
      }
      await live.ready;
      // A client that went away while the session was restored is not listening, and its close has already fired, so
      // `track` would never see it.
      if (res.closed) return;
      // A session another server sharing the database ended with DELETE is ended here too.
      const ended = unlessBusy(res, () => sessionEnded(db, id));
      if (ended === undefined) return;
      if (ended) {
        drop(id);
        return reply(res, 404, "Unknown session");
      }
      live.lastUsed = Date.now();
      track(live, res, body);
      await live.transport.handleRequest(req, res, body);
      live.lastUsed = Date.now();
      // A session dropped by close() while a request was open keeps its row, so the restart can restore it; any other
      // request keeps a registered one restorable for another idle timeout.
      if (req.method !== "DELETE" && sessions.get(id) === live) recordSession(() => touchSession(db, id, live.lastUsed));
      return;
    }

    if (req.method !== "POST" || !isInitializeRequest(body)) {
      return reply(res, 400, "Send an initialize request first");
    }
    // Registers the named agent as `register` would, in the token's account. A refusal is 403, not 401, so a client
    // does not take it for a bad token; its message names no key.
    let identity: Identity | undefined;
    if (named) {
      let registered: { identity: Identity } | undefined;
      try {
        registered = unlessBusy(res, () => registerWithIdentity(db, account, named.name, undefined, named.key));
      } catch (err) {
        if (err instanceof ToolError) return reply(res, 403, err.message);
        throw err;
      }
      if (registered === undefined) return;
      identity = registered.identity;
    } else if (bound) {
      identity = { id: bound.id, registeredAt: bound.registeredAt, instance: bound.instance };
    }
    const live: Live = { lastUsed: Date.now(), transport: undefined as never, account, open: new Map() };
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        sessions.set(sid, live);
        // Now that the session is held, binding it records it, as a `register` on it would.
        if (identity) session.bind(identity);
      },
      onsessionclosed: endRecorded,
    });
    live.transport = transport;
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    // Only a session this server still holds is recorded: a `register` that finishes after a DELETE ended it, before it
    // had a row to mark, must not make it restorable.
    const session = new Session(account, (identity) => {
      const sid = transport.sessionId!;
      if (sessions.get(sid) === live) recordSession(() => saveSession(db, sid, account, identity));
    });
    live.session = session;
    await createServer(db, session, { ...serverOptions(live), agent: bound?.name }).connect(transport);
    await transport.handleRequest(req, res, body);
  };

  /**
   * Notes each JSON-RPC request in a POST body as open until its response closes, whether answered or abandoned by the
   * client, so a held tool call can stop. A later request reusing an id replaces the entry, and is the one kept.
   */
  const track = (live: Live, res: ServerResponse, body: unknown) => {
    for (const message of Array.isArray(body) ? body : [body]) {
      if (!isJSONRPCRequest(message)) continue;
      const controller = new AbortController();
      live.open.set(message.id, controller);
      res.once("close", () => {
        controller.abort();
        if (live.open.get(message.id) === controller) live.open.delete(message.id);
      });
    }
  };

  /**
   * Called by a transport once it has accepted a DELETE, before it answers. If the session cannot be marked ended, this
   * throws, so the transport answers 500 instead of 200. The row stays restorable, so the DELETE can be sent again.
   */
  const endRecorded = (sid: string) => endSession(db, sid);

  /**
   * Holds session `id` again, bound to `identity`, which `restorableSession` has just checked. It takes its place in
   * `sessions` at once, so it counts against the cap and a second request on it waits for this one; if it cannot be
   * initialized it is dropped again.
   */
  const restore = (id: string, account: AccountId, identity: Identity) => {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => id, onsessionclosed: endRecorded });
    const live: Live = { lastUsed: Date.now(), transport, account, open: new Map() };
    sessions.set(id, live);
    transport.onclose = () => {
      if (sessions.get(id) === live) sessions.delete(id);
    };
    // Its row is already there, so it is not recorded again: one another server deleted meanwhile stays deleted. The
    // session is set at once, so a bound token's request on it meanwhile can check whose it is.
    const session = new Session(account, (bound) => {
      if (sessions.get(id) === live) recordSession(() => saveSession(db, id, account, bound));
    });
    session.restore(identity);
    live.session = session;
    live.ready = (async () => {
      try {
        await createServer(db, session, serverOptions(live)).connect(transport);
        await prime(transport);
      } catch (err) {
        drop(id);
        throw err;
      }
    })();
    // Each request awaits it and answers 500 if it failed; this keeps the failure from going unhandled meanwhile.
    live.ready.catch(() => {});
  };

  const server = createHttpServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error(`message-cp serve: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) reply(res, 500, "Internal error");
      else res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? DEFAULT_HTTP_PORT, options.host ?? DEFAULT_HTTP_HOST, () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : (options.port ?? DEFAULT_HTTP_PORT);

  return {
    server,
    port,
    sessionCount: () => sessions.size,
    close: async () => {
      clearInterval(sweep);
      clearInterval(deliver);
      stopping.abort();
      await sending;
      for (const id of [...sessions.keys()]) drop(id);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
