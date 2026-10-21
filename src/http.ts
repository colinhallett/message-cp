import { randomUUID } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { accountForToken, type TokenAccess } from "./accounts.js";
import { DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT, ToolError } from "./agents.js";
import {
  DEFAULT_CHANNEL_LIMIT,
  MAX_CHANNEL_LIMIT,
  listAccountChannels,
  postAsPerson,
  readAccountChannel,
  type ChannelPage,
} from "./channels.js";
import { DASHBOARD_HEADERS, DASHBOARD_HTML } from "./dashboard.js";
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
import { Session, createServer } from "./server.js";
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
export const DEFAULT_MAX_SESSIONS = 256;
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
}

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

async function readBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new RangeError("body too large");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * Serves the MCP tools over streamable HTTP at /mcp, one `Session` per MCP session. Every request needs the token,
 * except GET / for the dashboard page.
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
  // POST /api/send and /api/post requests between taking a slot and answering, so buffered bodies are bounded.
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

  const drop = (id: string) => {
    const live = sessions.get(id);
    if (!live) return;
    sessions.delete(id);
    void live.transport.close().catch(() => {});
  };

  const sweep = setInterval(
    () => {
      const cutoff = Date.now() - idleTimeoutMs;
      for (const [id, live] of sessions) if (live.lastUsed < cutoff) drop(id);
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

  /** One check for mail; a lock held past the busy timeout counts as no mail this time, as in `message-cp wait`. */
  const poll = (account: AccountId, name: string): Unread | undefined => {
    try {
      return unreadSummary(db, account, name);
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      if (typeof code !== "string" || !code.startsWith("SQLITE_BUSY")) throw err;
      return { count: 0, senders: [], posts: 0, channels: [], mentions: 0, mentionChannels: [] };
    }
  };

  /**
   * Answers 200 with the unread summary as soon as the account's agent has mail or unread posts in a channel it has
   * joined, 204 after `waitHoldMs` without any.
   * Another account's agent is answered like an unknown one.
   */
  const wait = async (req: IncomingMessage, res: ServerResponse, account: AccountId) => {
    if (req.method !== "GET") return reply(res, 405, "Method not allowed", { Allow: "GET" });
    const name = new URL(req.url ?? "", "http://x").searchParams.get("agent");
    const first = name ? poll(account, name) : undefined;
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
      await hold(first, account, name!, deadline, res, () => gone, (w) => (wake = w));
    } finally {
      waiting--;
      holding(account, name!, -1);
    }
  };

  const hold = async (
    first: NonNullable<ReturnType<typeof poll>>,
    account: AccountId,
    name: string,
    deadline: number,
    res: ServerResponse,
    isGone: () => boolean,
    setWake: (w: () => void) => void,
  ) => {
    for (let unread: typeof first | undefined = first; ; unread = poll(account, name)) {
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
   * GET /api/token: whether the request's token is read-only, so the dashboard offers posting only to a full token. It
   * gives nothing else about the token: no token, hash, id or account.
   */
  const apiToken = (req: IncomingMessage, res: ServerResponse, readOnly: boolean) => {
    if (req.method !== "GET") return reply(res, 405, "Method not allowed", { Allow: "GET" });
    sendJson(res, { readOnly });
  };

  /**
   * GET /api/agents: one page of the account's live agents, as `list_agents` pages them, each with its unread message,
   * post and mention counts and whether it is online. Counts only, never a message or post; it reads nothing as read.
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
   * GET /api/channel-posts?channel=<name>: one page of the account's channel, oldest first, without moving any agent's
   * read position. A channel only another account has is answered like one that does not exist.
   */
  const apiChannelPosts = (req: IncomingMessage, res: ServerResponse, account: AccountId) => {
    if (req.method !== "GET") return reply(res, 405, "Method not allowed", { Allow: "GET" });
    const query = new URL(req.url ?? "", "http://x").searchParams;
    const names = query.getAll("channel");
    if (names.length !== 1) return reply(res, 404, "No such channel");
    const paging = page(query, DEFAULT_CHANNEL_LIMIT, MAX_CHANNEL_LIMIT);
    if (paging === undefined) return reply(res, 400, `limit must be 1-${MAX_CHANNEL_LIMIT} and offset 0 or more`);
    let channel: ChannelPage | undefined;
    try {
      channel = unlessBusy(res, () => readAccountChannel(db, account, names[0], paging.limit, paging.offset));
    } catch (err) {
      // An invalid name and a missing channel are the same answer, so neither says more than the other.
      if (err instanceof ToolError) return reply(res, 404, "No such channel");
      throw err;
    }
    if (channel === undefined) return;
    sendJson(res, channel);
  };

  /**
   * GET /api/messages: one page of the account's direct messages, oldest first, each with its recipient and whether
   * it has been read. It marks nothing read, so no unread count, `lastSeen` or /wait answer moves.
   */
  const apiMessages = (req: IncomingMessage, res: ServerResponse, account: AccountId) => {
    if (req.method !== "GET") return reply(res, 405, "Method not allowed", { Allow: "GET" });
    const query = new URL(req.url ?? "", "http://x").searchParams;
    const paging = page(query, DEFAULT_INBOX_LIMIT, MAX_INBOX_LIMIT);
    if (paging === undefined) return reply(res, 400, `limit must be 1-${MAX_INBOX_LIMIT} and offset 0 or more`);
    const messages = unlessBusy(res, () => listAccountMessages(db, account, paging.limit, paging.offset));
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
   * `act` answers undefined for an `as` that is not a live person of the account, which gets 404; a tool's refusal
   * gets 400 with its message, which never quotes the body.
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

  /** POST /api/send: `{ as, to, body }`, sent as `send_message` sends it, from the account's person `as`. */
  const apiSend = (req: IncomingMessage, res: ServerResponse, account: AccountId) =>
    asPerson(req, res, ["as", "to", "body"], (m) => sendAsPerson(db, account, m.as, m.to, m.body));

  /** POST /api/post: `{ as, channel, body }`, posted as `post` posts it, by the account's person `as`. */
  const apiPost = (req: IncomingMessage, res: ServerResponse, account: AccountId) =>
    asPerson(req, res, ["as", "channel", "body"], (m) => postAsPerson(db, account, m.as, m.channel, m.body));

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "").split("?")[0];
    // The dashboard page is the same constant for everyone and holds no data, so it alone comes before the token.
    if (req.method === "GET" && path === "/") {
      res.writeHead(200, DASHBOARD_HEADERS);
      return void res.end(DASHBOARD_HTML);
    }
    // The token is the first thing any other request meets, and decides the account everything after it acts as.
    const access = accountOf(db, req.headers.authorization, options.token);
    if (access === undefined) {
      return reply(res, 401, "Unauthorized", { "WWW-Authenticate": "Bearer" });
    }
    const { account } = access;
    if (path === "/api/token") return apiToken(req, res, access.readOnly);
    if (path === "/api/agents") return apiAgents(req, res, account);
    if (path === "/api/channels") return apiChannels(req, res, account);
    if (path === "/api/channel-posts") return apiChannelPosts(req, res, account);
    if (path === "/api/messages") return apiMessages(req, res, account);
    if (path === "/api/search") return apiSearch(req, res, account);
    if (path === "/api/webhook-deliveries") return apiWebhookDeliveries(req, res, account);
    // A read-only token reaches the read-only endpoints above and nothing else: /mcp can write, and so can any path added later.
    if (access.readOnly) return reply(res, 403, "This token is read-only");
    if (path === "/api/send") return apiSend(req, res, account);
    if (path === "/api/post") return apiPost(req, res, account);
    if (path === "/api/conversation") return apiConversation(req, res, account);
    if (path === "/wait") return wait(req, res, account);
    if (path !== "/mcp") return reply(res, 404, "Not found");
    if (req.method !== "POST" && req.method !== "GET" && req.method !== "DELETE") {
      return reply(res, 405, "Method not allowed", { Allow: "GET, POST, DELETE" });
    }

    const header = req.headers["mcp-session-id"];
    const id = Array.isArray(header) ? header[0] : header;
    // A request without a session can only start one. Refuse it at the cap, closing the connection so an unread
    // body cannot hold it open; otherwise take a slot now, before the body is buffered, and give it back at the end.
    if (!id && sessions.size + initializing >= maxSessions) {
      return reply(res, 503, "Too many sessions", { Connection: "close" });
    }
    const reserved = !id && req.method === "POST";
    if (reserved) initializing++;
    try {
      await serve(req, res, id, account);
    } finally {
      if (reserved) initializing--;
    }
  };

  const serve = async (req: IncomingMessage, res: ServerResponse, id: string | undefined, account: AccountId) => {
    let body: unknown;
    if (req.method === "POST") {
      try {
        body = await readBody(req);
      } catch (err) {
        return err instanceof RangeError ? reply(res, 413, "Request body too large") : reply(res, 400, "Invalid JSON");
      }
    }

    if (id) {
      const live = sessions.get(id);
      // Another account's session looks like one that does not exist.
      if (!live || live.account !== account) return reply(res, 404, "Unknown session");
      live.lastUsed = Date.now();
      await live.transport.handleRequest(req, res, body);
      live.lastUsed = Date.now();
      return;
    }

    if (req.method !== "POST" || !isInitializeRequest(body)) {
      return reply(res, 400, "Send an initialize request first");
    }
    const live: Live = { lastUsed: Date.now(), transport: undefined as never, account };
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        sessions.set(sid, live);
      },
    });
    live.transport = transport;
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    await createServer(db, new Session(account), { remote: true, publicUrl: options.publicUrl }).connect(transport);
    await transport.handleRequest(req, res, body);
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
