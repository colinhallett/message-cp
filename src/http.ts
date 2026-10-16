import { randomUUID } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { accountForToken } from "./accounts.js";
import { accountForAgentKey } from "./agents.js";
import type { AccountId, Db } from "./db.js";
import { unreadSummary } from "./messages.js";
import { OAuth, type OAuthConfig } from "./oauth.js";
import { Session, createServer } from "./server.js";
import { DEFAULT_WAIT_HOLD_MS, formatUnread } from "./wait.js";

export const DEFAULT_HTTP_PORT = 8787;
export const DEFAULT_HTTP_HOST = "127.0.0.1";
export const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
export const DEFAULT_MAX_SESSIONS = 256;

export interface HttpOptions {
  /** The owner's token (MEMORY_CP_HTTP_TOKEN). Tokens created with `memory-cp token add` work as well, as their account. */
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
  /** Sign-in with GitHub; without it none of its endpoints exist and only the tokens above get in. */
  oauth?: OAuthConfig;
}

/** The header an agent signed in by OAuth sends its own key in on GET /wait, having no token that lasts. */
export const AGENT_KEY_HEADER = "x-memory-cp-agent-key";
/** The shortest key /wait accepts in that header: as long as the 64 hex characters `register` generates. */
export const MIN_WAIT_KEY_LENGTH = 64;

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

/**
 * The account the request's bearer token belongs to, checked afresh on every request so a revoked token stops at
 * once: an account token, or with sign-in on, an access token from it.
 */
function accountOf(db: Db, header: string | undefined, ownerToken: string, oauth: OAuth | undefined): AccountId | undefined {
  const m = /^bearer +(.*)$/i.exec(header ?? "");
  // Hash something even without a header, so a refusal takes about as long either way.
  const account = accountForToken(db, m?.[1] ?? "", ownerToken);
  if (m === null) return undefined;
  return account ?? oauth?.accountFor(m[1]);
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
  const oauth = options.oauth && new OAuth(db, options.oauth);
  const sessions = new Map<string, Live>();
  let initializing = 0;
  let waiting = 0;

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

  /** One check for mail; a lock held past the busy timeout counts as no mail this time, as in `memory-cp wait`. */
  const poll = (account: AccountId, name: string) => {
    try {
      return unreadSummary(db, account, name);
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      if (typeof code !== "string" || !code.startsWith("SQLITE_BUSY")) throw err;
      return { count: 0, senders: [] as string[] };
    }
  };

  /**
   * Answers 200 with the unread summary as soon as the account's agent has mail, 204 after `waitHoldMs` without any.
   * Another account's agent is answered like an unknown one.
   */
  const wait = async (req: IncomingMessage, res: ServerResponse, account: AccountId) => {
    if (req.method !== "GET") return reply(res, 405, "Method not allowed", { Allow: "GET" });
    const name = new URL(req.url ?? "", "http://x").searchParams.get("agent");
    const first = name ? poll(account, name) : undefined;
    if (!first) return reply(res, 404, "No such agent");
    // Mail that is already there is answered at once, whatever the cap.
    if (first.count > 0) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return void res.end(`${formatUnread(first)}\n`);
    }
    // Held requests are capped like sessions, so a runaway client cannot pin the server's connections.
    if (waiting >= maxSessions) return reply(res, 503, "Too many waiting requests", { "Retry-After": "5" });
    waiting++;
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
      if (unread.count > 0) {
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
   * With sign-in on, an agent without a token may wait on itself alone, with its name and its own key. Anyone can
   * try this, across every account, so only a key as long as a generated one counts: short keys an agent chose itself
   * cannot be guessed here.
   */
  const keyAccount = (req: IncomingMessage, path: string): AccountId | undefined => {
    const key = req.headers[AGENT_KEY_HEADER];
    if (!oauth || path !== "/wait" || typeof key !== "string" || req.headers.authorization !== undefined) return undefined;
    if (key.length < MIN_WAIT_KEY_LENGTH) return undefined;
    const name = new URL(req.url ?? "", "http://x").searchParams.get("agent");
    return name ? accountForAgentKey(db, name, key) : undefined;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "").split("?")[0];
    // Sign-in's own endpoints need no token; everything else does, but for an agent's /wait on itself with its key.
    if (oauth && (await oauth.handle(req, res, path))) return;
    // The token is the first thing a request meets, and decides the account everything after it acts as.
    const account = accountOf(db, req.headers.authorization, options.token, oauth) ?? keyAccount(req, path);
    if (account === undefined) {
      return reply(res, 401, "Unauthorized", { "WWW-Authenticate": oauth ? oauth.challenge : "Bearer" });
    }
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
    await createServer(db, new Session(account), { remote: true, publicUrl: options.publicUrl, agentKeyWait: !!oauth }).connect(transport);
    await transport.handleRequest(req, res, body);
  };

  const server = createHttpServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error(`memory-cp serve: ${err instanceof Error ? err.message : String(err)}`);
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
