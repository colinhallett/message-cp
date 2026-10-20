import { randomUUID } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { accountForToken, type TokenAccess } from "./accounts.js";
import { DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT, listAgents } from "./agents.js";
import type { AccountId, Db } from "./db.js";
import { hasUnread, unreadSummary, type Unread } from "./messages.js";
import { Session, createServer } from "./server.js";
import { DEFAULT_WAIT_HOLD_MS, formatUnread } from "./wait.js";

export const DEFAULT_HTTP_PORT = 8787;
export const DEFAULT_HTTP_HOST = "127.0.0.1";
export const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
export const DEFAULT_MAX_SESSIONS = 256;
/** An agent seen this recently counts as online in GET /api/agents, as does one with a GET /wait held now. */
export const ONLINE_WINDOW_MS = 5 * 60 * 1000;

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

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new RangeError("body too large");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Serves the MCP tools over streamable HTTP at /mcp, one `Session` per MCP session. Every request needs the token. */
export async function startHttp(db: Db, options: HttpOptions): Promise<HttpServer> {
  if (!options.token) throw new Error("an HTTP token is required");
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs < 0) throw new Error("idleTimeoutMs must be a finite number >= 0");
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  if (!Number.isInteger(maxSessions) || maxSessions < 1) throw new Error("maxSessions must be a positive integer");
  const waitHoldMs = options.waitHoldMs ?? DEFAULT_WAIT_HOLD_MS;
  if (!Number.isFinite(waitHoldMs) || waitHoldMs < 0) throw new Error("waitHoldMs must be a finite number >= 0");
  const sessions = new Map<string, Live>();
  let initializing = 0;
  let waiting = 0;
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

  /** One check for mail; a lock held past the busy timeout counts as no mail this time, as in `message-cp wait`. */
  const poll = (account: AccountId, name: string): Unread | undefined => {
    try {
      return unreadSummary(db, account, name);
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      if (typeof code !== "string" || !code.startsWith("SQLITE_BUSY")) throw err;
      return { count: 0, senders: [], posts: 0, channels: [] };
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
   * GET /api/agents: one page of the account's live agents, as `list_agents` pages them, each with its unread counts
   * and whether it is online. Counts only, never a message or post; it reads nothing as read.
   */
  const apiAgents = (req: IncomingMessage, res: ServerResponse, account: AccountId) => {
    if (req.method !== "GET") return reply(res, 405, "Method not allowed", { Allow: "GET" });
    const query = new URL(req.url ?? "", "http://x").searchParams;
    const number = (key: string, fallback: number, min: number, max: number) => {
      const raw = query.get(key);
      if (raw === null) return fallback;
      const n = /^[0-9]+$/.test(raw) ? Number(raw) : NaN;
      return Number.isSafeInteger(n) && n >= min && n <= max ? n : undefined;
    };
    const limit = number("limit", DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT);
    const offset = number("offset", 0, 0, Number.MAX_SAFE_INTEGER);
    if (limit === undefined || offset === undefined) {
      return reply(res, 400, `limit must be 1-${MAX_LIST_LIMIT} and offset 0 or more`);
    }
    const waits = held.get(account);
    const recent = Date.now() - ONLINE_WINDOW_MS;
    // One read transaction, so the page and its counts describe the same moment.
    const agents = db.transaction(() =>
      listAgents(db, account, limit, offset).map((a) => {
        const unread = unreadSummary(db, account, a.name);
        return {
          name: a.name,
          bio: a.bio,
          lastSeen: a.lastSeen,
          unreadMessages: unread?.count ?? 0,
          unreadPosts: unread?.posts ?? 0,
          online: (waits?.get(a.name.toLowerCase()) ?? 0) > 0 || Date.parse(a.lastSeen) >= recent,
        };
      }),
    )();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(agents));
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    // The token is the first thing a request meets, and decides the account everything after it acts as.
    const access = accountOf(db, req.headers.authorization, options.token);
    if (access === undefined) {
      return reply(res, 401, "Unauthorized", { "WWW-Authenticate": "Bearer" });
    }
    const { account } = access;
    const path = (req.url ?? "").split("?")[0];
    if (path === "/api/agents") return apiAgents(req, res, account);
    // A read-only token reaches the read-only endpoints above and nothing else: /mcp can write, and so can any path added later.
    if (access.readOnly) return reply(res, 403, "This token is read-only");
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
      for (const id of [...sessions.keys()]) drop(id);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
