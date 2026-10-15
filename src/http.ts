import { randomUUID, timingSafeEqual, createHash } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Db } from "./db.js";
import { Session, createServer } from "./server.js";

export const DEFAULT_HTTP_PORT = 8787;
export const DEFAULT_HTTP_HOST = "127.0.0.1";
export const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
export const DEFAULT_MAX_SESSIONS = 256;

export interface HttpOptions {
  token: string;
  host?: string;
  port?: number;
  idleTimeoutMs?: number;
  /** Most MCP sessions kept at once; further initializes get 503 until one ends or idles out. */
  maxSessions?: number;
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
}

/** Constant-time comparison: both sides are hashed so the lengths match. */
function tokenMatches(header: string | undefined, token: string): boolean {
  const m = /^bearer +(.*)$/i.exec(header ?? "");
  const a = createHash("sha256").update(m?.[1] ?? "").digest();
  const b = createHash("sha256").update(token).digest();
  return timingSafeEqual(a, b) && m !== null;
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
  const sessions = new Map<string, Live>();
  let initializing = 0;

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

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    // The token is the first thing a request meets.
    if (!tokenMatches(req.headers.authorization, options.token)) {
      return reply(res, 401, "Unauthorized", { "WWW-Authenticate": "Bearer" });
    }
    const path = (req.url ?? "").split("?")[0];
    if (path !== "/mcp") return reply(res, 404, "Not found");
    if (req.method !== "POST" && req.method !== "GET" && req.method !== "DELETE") {
      return reply(res, 405, "Method not allowed", { Allow: "GET, POST, DELETE" });
    }

    const header = req.headers["mcp-session-id"];
    const id = Array.isArray(header) ? header[0] : header;
    // A request without a session can only start one: refuse it before buffering its body when the cap is reached.
    if (!id && sessions.size + initializing >= maxSessions) return reply(res, 503, "Too many sessions");
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
      if (!live) return reply(res, 404, "Unknown session");
      live.lastUsed = Date.now();
      await live.transport.handleRequest(req, res, body);
      live.lastUsed = Date.now();
      return;
    }

    if (req.method !== "POST" || !isInitializeRequest(body)) {
      return reply(res, 400, "Send an initialize request first");
    }
    // Re-check: the body read above is async, so another initialize may have been admitted meanwhile.
    if (sessions.size + initializing >= maxSessions) return reply(res, 503, "Too many sessions");
    const live: Live = { lastUsed: Date.now(), transport: undefined as never };
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
    // Count the session from admission, so concurrent initializes cannot all pass the check above.
    initializing++;
    try {
      await createServer(db, new Session(), { remote: true }).connect(transport);
      await transport.handleRequest(req, res, body);
    } finally {
      initializing--;
    }
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
