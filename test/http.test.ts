import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { request } from "node:http";
import { connect as connectSocket, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addAccount } from "../src/accounts.js";
import { addPerson, purgeAgent } from "../src/agents.js";
import { OWNER_ACCOUNT, openDb, type Db } from "../src/db.js";
import { startHttp, type HttpServer } from "../src/http.js";
import { sendMessage } from "../src/messages.js";
import { Session, createServer } from "../src/server.js";

const TOKEN = "s3cret-token";
let db: Db;
let http: HttpServer;
let open: Client[] = [];

beforeEach(async () => {
  db = openDb(join(mkdtempSync(join(tmpdir(), "message-cp-http-")), "db.sqlite"));
  http = await startHttp(db, { token: TOKEN, port: 0 });
});

afterEach(async () => {
  for (const c of open) await c.close().catch(() => {});
  open = [];
  await http.close();
  db.close();
});

const url = () => new URL(`http://127.0.0.1:${http.port}/mcp`);

async function connect(token = TOKEN): Promise<Client> {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(url(), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
  );
  open.push(client);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  return { isError: !!res.isError, text: res.content[0].text };
}

const init = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "raw", version: "0" } },
};
const post = (headers: Record<string, string>) =>
  fetch(url(), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(init),
  });

describe("token", () => {
  it("refuses a missing header, a wrong token and a wrong scheme, and creates no session", async () => {
    expect((await post({})).status).toBe(401);
    expect((await post({ Authorization: "Bearer nope" })).status).toBe(401);
    expect((await post({ Authorization: `Basic ${TOKEN}` })).status).toBe(401);
    expect((await post({ Authorization: TOKEN })).status).toBe(401);
    expect((await fetch(url(), { method: "DELETE" })).status).toBe(401);
    expect(http.sessionCount()).toBe(0);
    await expect(connect("wrong")).rejects.toThrow();
  });

  it("answers GET /health the same with no token, a wrong one and a valid one, and 405 to any other method", async () => {
    const health = new URL("/health", url());
    for (const headers of [{}, { Authorization: "Bearer nope" }, { Authorization: `Bearer ${TOKEN}` }]) {
      const res = await fetch(health, { headers });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/json");
      expect(await res.text()).toBe('{"ok":true}');
    }
    for (const headers of [{}, { Authorization: `Bearer ${TOKEN}` }]) {
      for (const method of ["POST", "DELETE", "HEAD"]) {
        const res = await fetch(health, { method, headers });
        expect(res.status).toBe(405);
        expect(res.headers.get("allow")).toBe("GET");
      }
    }
    expect(await (await fetch(new URL("/health?x=1", url()))).text()).toBe('{"ok":true}');
    expect((await fetch(new URL("/nope", url()))).status).toBe(401);
    expect((await fetch(new URL("/health/", url()))).status).toBe(401);
    expect(http.sessionCount()).toBe(0);
  });

  it("answers GET /health without reading the database", async () => {
    db.close();
    expect(await (await fetch(new URL("/health", url()))).text()).toBe('{"ok":true}');
  });

  it("accepts the right token", async () => {
    const res = await post({ Authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain(TOKEN);
  });

  it("refuses to start with an empty token", async () => {
    await expect(startHttp(db, { token: "", port: 0 })).rejects.toThrow();
  });
});

describe("sessions", () => {
  it("gives each client its own identity and carries a message between them", async () => {
    const a = await connect();
    const b = await connect();
    expect((await call(a, "register", { name: "ann", bio: "x" })).isError).toBe(false);
    const reg = await call(b, "register", { name: "bob", bio: "y" });
    expect(reg.text).not.toContain("waitCommand");
    expect((await call(a, "send_message", { to: "bob", body: "hello bob" })).isError).toBe(false);
    const inbox = await call(b, "read_inbox", {});
    expect(inbox.text).toContain("hello bob");
    expect(inbox.text).toContain("ann");
    // ann's session is still ann, bob's is bob.
    expect((await call(a, "read_inbox", {})).text).not.toContain("hello bob");
    expect(http.sessionCount()).toBe(2);
    // No wait command without a public URL; only the tool that waits in one call.
    expect(a.getInstructions()).not.toContain("/wait");
    expect(a.getInstructions()).not.toContain("sh -c");
    expect(a.getInstructions()).toContain("call wait_for_mail");
  });

  it("drops a session closed with DELETE and refuses its id afterwards", async () => {
    const res = await post({ Authorization: `Bearer ${TOKEN}` });
    const sid = res.headers.get("mcp-session-id")!;
    expect(sid).toBeTruthy();
    expect(http.sessionCount()).toBe(1);
    const auth = { Authorization: `Bearer ${TOKEN}`, "mcp-session-id": sid };
    expect((await fetch(url(), { method: "DELETE", headers: auth })).status).toBe(200);
    expect(http.sessionCount()).toBe(0);
    expect((await post(auth)).status).toBe(404);
  });

  it("drops a session that has been idle past the timeout", async () => {
    await http.close();
    http = await startHttp(db, { token: TOKEN, port: 0, idleTimeoutMs: 50 });
    await post({ Authorization: `Bearer ${TOKEN}` });
    expect(http.sessionCount()).toBe(1);
    await new Promise((r) => setTimeout(r, 300));
    expect(http.sessionCount()).toBe(0);
  });
});

describe("waiting keeps a session", () => {
  const IDLE_MS = 600;

  beforeEach(async () => {
    await http.close();
    http = await startHttp(db, { token: TOKEN, port: 0, idleTimeoutMs: IDLE_MS, waitHoldMs: 300 });
  });

  /** A session registered as `name` with `token`, and its id. */
  async function registered(name: string, token = TOKEN): Promise<{ client: Client; sid: string }> {
    const client = await connect(token);
    expect((await call(client, "register", { name, bio: "x" })).isError).toBe(false);
    return { client, sid: (client.transport as StreamableHTTPClientTransport).sessionId! };
  }

  const wait = (agent: string, token = TOKEN) =>
    fetch(`http://127.0.0.1:${http.port}/wait?agent=${agent}`, { headers: { Authorization: `Bearer ${token}` } });

  /** Runs the wait loop for `agent` for `ms`, asking again at once after each 204, as `waitCommand` does. */
  async function waitLoop(agent: string, ms: number, token = TOKEN): Promise<void> {
    const end = Date.now() + ms;
    while (Date.now() < end) expect((await wait(agent, token)).status).toBe(204);
  }

  /** How many restorable session rows the account named `account` has. */
  const rowsFor = (account: string) =>
    (
      db
        .prepare("SELECT COUNT(*) AS n FROM http_sessions JOIN accounts ON accounts.id = account_id WHERE accounts.name = ?")
        .get(account) as { n: number }
    ).n;

  it("keeps a registered session whose agent waits well past the timeout, acting as its agent after", async () => {
    const ann = await registered("ann");
    const bob = await connect();
    await call(bob, "register", { name: "bob", bio: "y" });
    await waitLoop("ann", IDLE_MS * 3);
    // bob made /mcp requests only before the loop, so only ann's session is left.
    expect(http.sessionCount()).toBe(1);
    expect(rowsFor("owner")).toBe(1);
    // A held wait answers when mail comes, and the old session reads it with no new register.
    const pending = wait("ann");
    await new Promise((r) => setTimeout(r, 50));
    sendMessage(db, OWNER_ACCOUNT, "bob", "ann", "while waiting");
    expect((await pending).status).toBe(200);
    const inbox = await call(ann.client, "read_inbox", {});
    expect(inbox.isError).toBe(false);
    expect(inbox.text).toContain("while waiting");
  });

  it("keeps the session through one hold longer than the timeout, then lets it idle out", async () => {
    await http.close();
    http = await startHttp(db, { token: TOKEN, port: 0, idleTimeoutMs: IDLE_MS, waitHoldMs: IDLE_MS * 4 });
    const ann = await registered("ann");
    expect((await wait("ann")).status).toBe(204);
    expect(http.sessionCount()).toBe(1);
    expect(rowsFor("owner")).toBe(1);
    expect((await call(ann.client, "read_inbox", {})).isError).toBe(false);
    await new Promise((r) => setTimeout(r, IDLE_MS * 3));
    expect(http.sessionCount()).toBe(0);
  });

  it("counts a session as used when a hold for its agent ends, so the gap before the next one cannot drop it", async () => {
    // With a 1000ms timeout the sweep runs every 500ms from start. Times are taken from when registration completed:
    // pass `k` is the first more than 50ms after it, and the hold runs between it and the next one, so no pass sees it
    // held. Pass `k + 2` is the first whose cutoff is past the registration: only the end of the hold can keep the
    // session through it.
    await http.close();
    const start = Date.now();
    http = await startHttp(db, { token: TOKEN, port: 0, idleTimeoutMs: 1000, waitHoldMs: 300 });
    await registered("ann");
    const k = Math.floor((Date.now() + 50 - start) / 500) + 1;
    const until = (ms: number) => new Promise((r) => setTimeout(r, start + ms - Date.now()));
    await until(500 * k + 100);
    expect((await wait("ann")).status).toBe(204);
    expect(Date.now() - start).toBeLessThan(500 * (k + 1));
    await until(500 * (k + 2) + 250);
    expect(http.sessionCount()).toBe(1);
  });

  it("waits out a busy database once at most in a sweep pass, however many waiting sessions it reaches", async () => {
    await http.close();
    http = await startHttp(db, { token: TOKEN, port: 0, idleTimeoutMs: 200, waitHoldMs: 5000 });
    const names = ["a0", "a1", "a2", "a3", "a4", "a5", "a6", "a7"];
    // Each hold starts as soon as its agent registers, so no session sits idle while the later ones register.
    const holds: Promise<Response>[] = [];
    for (const name of names) {
      await registered(name);
      holds.push(wait(name));
    }
    await new Promise((r) => setTimeout(r, 300));
    db.pragma("busy_timeout = 200");
    const other = new Database(db.name);
    other.exec("BEGIN IMMEDIATE");
    // The longest the event loop is blocked while the lock is held: one busy timeout is 200ms, one per session 1600ms.
    let longest = 0;
    try {
      let last = Date.now();
      const end = last + 1200;
      while (Date.now() < end) {
        await new Promise((r) => setTimeout(r, 5));
        longest = Math.max(longest, Date.now() - last);
        last = Date.now();
      }
    } finally {
      other.exec("ROLLBACK");
      other.close();
    }
    expect(longest).toBeLessThan(800);
    expect(http.sessionCount()).toBe(8);
    for (const c of open) await c.close().catch(() => {});
    open = [];
    await http.close();
    await Promise.allSettled(holds);
  });

  it("keeps a restored session whose agent waits", async () => {
    const { sid } = await registered("ann");
    for (const c of open) await c.close().catch(() => {});
    open = [];
    await http.close();
    http = await startHttp(db, { token: TOKEN, port: 0, idleTimeoutMs: IDLE_MS, waitHoldMs: 300 });
    const resumed = new Client({ name: "test", version: "0" });
    await resumed.connect(
      new StreamableHTTPClientTransport(url(), { sessionId: sid, requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }),
    );
    open.push(resumed);
    expect((await call(resumed, "read_inbox", {})).isError).toBe(false);
    await waitLoop("ann", IDLE_MS * 3);
    expect(http.sessionCount()).toBe(1);
    expect(rowsFor("owner")).toBe(1);
    expect((await call(resumed, "read_inbox", {})).isError).toBe(false);
  });

  it("drops a registered session whose agent is not waiting, and forgets its row", async () => {
    await registered("ann");
    await new Promise((r) => setTimeout(r, IDLE_MS * 3));
    expect(http.sessionCount()).toBe(0);
    expect(rowsFor("owner")).toBe(0);
  });

  it("does not keep a session that never registered, or one whose registration is no longer current", async () => {
    const first = await registered("ann");
    await call(first.client, "unregister", {});
    // A new agent takes the name and is waited for; only its own session is kept.
    const second = await registered("ann");
    await post({ Authorization: `Bearer ${TOKEN}` });
    expect(http.sessionCount()).toBe(3);
    await waitLoop("ann", IDLE_MS * 3);
    expect(http.sessionCount()).toBe(1);
    expect(rowsFor("owner")).toBe(1);
    expect((await call(second.client, "read_inbox", {})).isError).toBe(false);
  });

  it("does not keep another agent's session, or another account's session for an agent with the same name", async () => {
    const other = addAccount(db, "other").token;
    await registered("ann");
    await registered("bob");
    await registered("ann", other);
    expect(http.sessionCount()).toBe(3);
    await waitLoop("ann", IDLE_MS * 3, other);
    // Only the other account's ann is left.
    expect(http.sessionCount()).toBe(1);
    expect(rowsFor("owner")).toBe(0);
    expect(rowsFor("other")).toBe(1);
  });
});

describe("limits", () => {
  it("refuses initializes past maxSessions until one ends", async () => {
    await http.close();
    http = await startHttp(db, { token: TOKEN, port: 0, maxSessions: 1 });
    const auth = { Authorization: `Bearer ${TOKEN}` };
    const first = await post(auth);
    expect(first.status).toBe(200);
    expect((await post(auth)).status).toBe(503);
    const sid = first.headers.get("mcp-session-id")!;
    await fetch(url(), { method: "DELETE", headers: { ...auth, "mcp-session-id": sid } });
    expect((await post(auth)).status).toBe(200);
  });

  it("admits only maxSessions concurrent initializes", async () => {
    await http.close();
    http = await startHttp(db, { token: TOKEN, port: 0, maxSessions: 2 });
    const auth = { Authorization: `Bearer ${TOKEN}` };
    const statuses = (await Promise.all([1, 2, 3, 4, 5].map(() => post(auth)))).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 200, 503, 503, 503]);
    expect(http.sessionCount()).toBe(2);
  });

  /**
   * Opens a POST /mcp that declares a body of `declared` bytes and sends one, and answers with the socket and the
   * response's status once one arrives (null while the server is still reading the body).
   */
  const slowPost = (headers: Record<string, string>, declared = 1_000_000) =>
    new Promise<{ socket: Socket; status: () => number | null; closed: Promise<void> }>((resolve, reject) => {
      let status: number | null = null;
      const socket = connectSocket(http.port, "127.0.0.1", () => {
        const lines = [
          "POST /mcp HTTP/1.1",
          `Host: 127.0.0.1:${http.port}`,
          "Content-Type: application/json",
          "Accept: application/json, text/event-stream",
          `Content-Length: ${declared}`,
          ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
        ];
        socket.write(`${lines.join("\r\n")}\r\n\r\n{`);
        resolve({ socket, status: () => status, closed });
      });
      const closed = new Promise<void>((done) => socket.on("close", () => done()));
      socket.on("error", reject);
      socket.on("data", (chunk) => {
        status ??= Number(/^HTTP\/1\.1 (\d{3})/.exec(chunk.toString())?.[1] ?? 0);
      });
    });
  const settle = () => new Promise((r) => setTimeout(r, 200));
  const toolsList = (auth: Record<string, string>, sid: string) =>
    fetch(url(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...auth,
        "mcp-session-id": sid,
        "mcp-protocol-version": "2025-03-26",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });

  it("reads at most maxSessions request bodies for existing sessions at once, and gives each slot back", async () => {
    await http.close();
    http = await startHttp(db, { token: TOKEN, port: 0, maxSessions: 1 });
    const auth = { Authorization: `Bearer ${TOKEN}` };
    const sid = (await post(auth)).headers.get("mcp-session-id")!;
    const slow = [];
    for (let i = 0; i < 8; i++) slow.push(await slowPost({ ...auth, "mcp-session-id": sid }));
    await settle();
    // The first is still being read; the other seven were refused before their bodies, with the connection closed.
    expect(slow.map((s) => s.status())).toEqual([null, 503, 503, 503, 503, 503, 503, 503]);
    await Promise.all(slow.slice(1).map((s) => s.closed));
    // So is a normal request while the slot is held.
    const refused = await toolsList(auth, sid);
    expect(refused.status).toBe(503);
    expect(refused.headers.get("connection")).toBe("close");
    // A client that goes away mid-body gives its slot back.
    slow[0].socket.destroy();
    await slow[0].closed;
    await settle();
    expect((await toolsList(auth, sid)).status).toBe(200);
    expect((await toolsList(auth, sid)).status).toBe(200);
    expect(http.sessionCount()).toBe(1);
  });

  it("answers an unknown session, or another account's, with 404 before reading its body or taking a slot", async () => {
    await http.close();
    http = await startHttp(db, { token: TOKEN, port: 0, maxSessions: 1 });
    const other = addAccount(db, "other").token;
    const auth = { Authorization: `Bearer ${TOKEN}` };
    const sid = (await post(auth)).headers.get("mcp-session-id")!;
    const held = await slowPost({ ...auth, "mcp-session-id": sid });
    const unknown = await slowPost({ ...auth, "mcp-session-id": "no-such-session" });
    const foreign = await slowPost({ Authorization: `Bearer ${other}`, "mcp-session-id": sid });
    await Promise.all([unknown.closed, foreign.closed]);
    expect([held.status(), unknown.status(), foreign.status()]).toEqual([null, 404, 404]);
    held.socket.destroy();
    await held.closed;
    await settle();
    expect((await toolsList(auth, sid)).status).toBe(200);
  });

  it("gives the slot back once a session's body is read, so a held tool call does not keep it", async () => {
    await http.close();
    http = await startHttp(db, { token: TOKEN, port: 0, maxSessions: 1 });
    const a = await connect();
    await call(a, "register", { name: "ann", bio: "x" });
    const waiting = call(a, "wait_for_mail", { timeout_seconds: 2 });
    await settle();
    expect((await call(a, "list_agents", {})).text).toContain("ann");
    expect((await waiting).text).toContain("null");
  });

  it("accepts extra spaces after the Bearer scheme", async () => {
    expect((await post({ Authorization: `Bearer   ${TOKEN}` })).status).toBe(200);
  });

  it("rejects an invalid idle timeout or session cap", async () => {
    await expect(startHttp(db, { token: TOKEN, port: 0, idleTimeoutMs: NaN })).rejects.toThrow(/idleTimeoutMs/);
    await expect(startHttp(db, { token: TOKEN, port: 0, idleTimeoutMs: -1 })).rejects.toThrow(/idleTimeoutMs/);
    await expect(startHttp(db, { token: TOKEN, port: 0, maxSessions: 0 })).rejects.toThrow(/maxSessions/);
  });
});

describe("stdio and HTTP on one database", () => {
  it("lets a stdio-style server read what an HTTP client wrote, with the wait command intact", async () => {
    const remote = await connect();
    await call(remote, "register", { name: "rem", bio: "x" });
    await call(remote, "register", { name: "loc", bio: "x" });
    await call(remote, "send_message", { to: "rem", body: "ping" });
    const server = createServer(db);
    const [s, c] = InMemoryTransport.createLinkedPair();
    const local = new Client({ name: "local", version: "0" });
    await Promise.all([server.connect(s), local.connect(c)]);
    expect((await call(local, "register", { name: "other", bio: "x" })).text).toContain("waitCommand");
    expect((await call(local, "list_agents", {})).text).toContain("rem");
    expect(local.getInstructions()).toContain("wait");
    await local.close();
  });
});

describe("restart", () => {
  const rawUrl = (server: HttpServer) => new URL(`http://127.0.0.1:${server.port}/mcp`);

  /** A client on `sessionId`, as one that held it before the restart reconnects. */
  async function resume(server: HttpServer, sessionId: string, token = TOKEN): Promise<Client> {
    const client = new Client({ name: "test", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(rawUrl(server), {
        sessionId,
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    open.push(client);
    return client;
  }

  /** A registered session on the current server, and its id. */
  async function registered(name: string): Promise<string> {
    const client = await connect();
    expect((await call(client, "register", { name, bio: "x", key: `${name}-key` })).isError).toBe(false);
    return (client.transport as StreamableHTTPClientTransport).sessionId!;
  }

  async function restart(options: { idleTimeoutMs?: number; maxSessions?: number } = {}): Promise<void> {
    for (const c of open) await c.close().catch(() => {});
    open = [];
    await http.close();
    http = await startHttp(db, { token: TOKEN, port: 0, ...options });
  }

  /** The status of one tools/list on `sessionId`, as a raw request so nothing retries or reinitializes. */
  const status = async (sessionId: string, token = TOKEN) =>
    (
      await fetch(rawUrl(http), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${token}`,
          "mcp-session-id": sessionId,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      })
    ).status;

  it("restores a registered session on a new server, acting as its agent", async () => {
    const sid = await registered("ann");
    const bob = await connect();
    await call(bob, "register", { name: "bob", bio: "y", key: "bob-key" });
    await call(bob, "send_message", { to: "ann", body: "before restart" });
    await restart();
    expect(http.sessionCount()).toBe(0);
    const ann = await resume(http, sid);
    expect((await call(ann, "read_inbox", {})).text).toContain("before restart");
    expect(http.sessionCount()).toBe(1);
    expect((await call(ann, "send_message", { to: "bob", body: "after restart" })).isError).toBe(false);
    const bobAgain = await connect();
    await call(bobAgain, "register", { name: "bob", bio: "y", key: "bob-key" });
    const inbox = JSON.parse((await call(bobAgain, "read_inbox", {})).text);
    expect(inbox).toEqual([expect.objectContaining({ from: "ann", body: "after restart" })]);
    // It survives a second restart too.
    await restart();
    expect(await status(sid)).toBe(200);
  });

  it("never stores a session id in plain form", async () => {
    const sid = await registered("ann");
    const rows = db.prepare("SELECT * FROM http_sessions").all();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(sid);
  });

  it("does not restore a session that never registered", async () => {
    const res = await post({ Authorization: `Bearer ${TOKEN}` });
    const sid = res.headers.get("mcp-session-id")!;
    await restart();
    expect(await status(sid)).toBe(404);
  });

  it("refuses another account's token, and still restores for its own", async () => {
    const sid = await registered("ann");
    const other = addAccount(db, "other").token;
    await restart();
    expect(await status(sid, other)).toBe(404);
    expect(http.sessionCount()).toBe(0);
    expect(await status(sid)).toBe(200);
  });

  it("refuses a session ended with DELETE", async () => {
    const sid = await registered("ann");
    const auth = { Authorization: `Bearer ${TOKEN}`, "mcp-session-id": sid };
    expect((await fetch(url(), { method: "DELETE", headers: auth })).status).toBe(200);
    await restart();
    expect(await status(sid)).toBe(404);
  });

  it("forgets a restored session ended with DELETE", async () => {
    const sid = await registered("ann");
    await restart();
    expect(await status(sid)).toBe(200);
    const auth = { Authorization: `Bearer ${TOKEN}`, "mcp-session-id": sid, "mcp-protocol-version": "2025-03-26" };
    expect((await fetch(url(), { method: "DELETE", headers: auth })).status).toBe(200);
    expect(db.prepare("SELECT ended FROM http_sessions").all()).toEqual([{ ended: 1 }]);
    await restart();
    expect(await status(sid)).toBe(404);
  });

  it("answers 500 to a DELETE it cannot record, leaving the session restorable so the DELETE can be sent again", async () => {
    const sid = await registered("ann");
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
      if (sql.startsWith("UPDATE http_sessions SET ended")) {
        throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
      }
      return prepare(sql);
    }) as typeof db.prepare);
    const auth = { Authorization: `Bearer ${TOKEN}`, "mcp-session-id": sid, "mcp-protocol-version": "2025-03-26" };
    const refused = await fetch(url(), { method: "DELETE", headers: auth });
    vi.restoreAllMocks();
    expect(refused.status).toBe(500);
    await restart();
    expect((await fetch(url(), { method: "DELETE", headers: auth })).status).toBe(200);
    await restart();
    expect(await status(sid)).toBe(404);
  });

  it("does not record a register that finishes after DELETE ended a session that had no row", async () => {
    const client = await connect();
    const sid = (client.transport as StreamableHTTPClientTransport).sessionId!;
    // Hold this register's bind until the DELETE has been answered, as a register still running when it arrives would.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const bind = Session.prototype.bind;
    const bound = new Promise<void>((done) => {
      vi.spyOn(Session.prototype, "bind").mockImplementation(function (this: Session, identity) {
        void held.then(() => {
          bind.call(this, identity);
          done();
        });
      });
    });
    await call(client, "register", { name: "ann", bio: "x", key: "ann-key" });
    const auth = { Authorization: `Bearer ${TOKEN}`, "mcp-session-id": sid, "mcp-protocol-version": "2025-03-26" };
    expect((await fetch(url(), { method: "DELETE", headers: auth })).status).toBe(200);
    release();
    await bound;
    vi.restoreAllMocks();
    expect(db.prepare("SELECT count(*) AS n FROM http_sessions").get()).toEqual({ n: 0 });
    await restart();
    expect(await status(sid)).toBe(404);
  });

  it("never lets a session recorded again after DELETE act as an agent that has since unregistered", async () => {
    // As if a server with a longer idle timeout recorded the session again after the ended row was swept.
    const sid = await registered("ann");
    const row = db.prepare("SELECT * FROM http_sessions").get();
    const auth = { Authorization: `Bearer ${TOKEN}`, "mcp-session-id": sid, "mcp-protocol-version": "2025-03-26" };
    expect((await fetch(url(), { method: "DELETE", headers: auth })).status).toBe(200);
    await call(await connect(), "unregister", { name: "ann", key: "ann-key" });
    await call(await connect(), "register", { name: "ann", bio: "new", key: "ann-key" });
    db.prepare("DELETE FROM http_sessions").run();
    db.prepare("INSERT INTO http_sessions (hash, account_id, agent_id, registered_at, instance, last_used) VALUES (?, ?, ?, ?, ?, ?)")
      .run(...Object.values(row as object).slice(0, 5), Date.now());
    await restart();
    expect(await status(sid)).toBe(404);
  });

  it("keeps a DELETE on one server final for another server sharing the database", async () => {
    const sid = await registered("ann");
    const other = await startHttp(db, { token: TOKEN, port: 0 });
    try {
      // The other server restores the session and so holds a live copy of it.
      const onOther = await resume(other, sid);
      expect((await call(onOther, "read_inbox", {})).isError).toBe(false);
      const auth = { Authorization: `Bearer ${TOKEN}`, "mcp-session-id": sid, "mcp-protocol-version": "2025-03-26" };
      expect((await fetch(url(), { method: "DELETE", headers: auth })).status).toBe(200);
      // The other copy is ended too, so a register on it is refused, and nothing records the session again.
      await expect(call(onOther, "register", { name: "ann", bio: "x", key: "ann-key" })).rejects.toThrow("Unknown session");
      expect(other.sessionCount()).toBe(0);
      expect(db.prepare("SELECT ended FROM http_sessions").all()).toEqual([{ ended: 1 }]);
      expect(await status(sid)).toBe(404);
      await restart();
      expect(await status(sid)).toBe(404);
    } finally {
      await other.close();
    }
  });

  it("restores a session without recording its row again", async () => {
    const sid = await registered("ann");
    await restart();
    const prepare = db.prepare.bind(db);
    const writes: string[] = [];
    vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
      if (sql.startsWith("INSERT INTO http_sessions")) writes.push(sql);
      return prepare(sql);
    }) as typeof db.prepare);
    expect(await status(sid)).toBe(200);
    vi.restoreAllMocks();
    expect(writes).toEqual([]);
  });

  it("refuses a session idle past the timeout", async () => {
    await restart({ idleTimeoutMs: 100 });
    const sid = await registered("ann");
    await restart({ idleTimeoutMs: 100 });
    await new Promise((r) => setTimeout(r, 250));
    expect(await status(sid)).toBe(404);
  });

  it("refuses a session whose agent was removed, even after its name is registered again", async () => {
    const sid = await registered("ann");
    const unregistered = await registered("cid");
    await call(await connect(), "unregister", { name: "cid", key: "cid-key" });
    purgeAgent(db, "owner", "ann");
    // A later agent with the same name is not the one the session registered as.
    await call(await connect(), "register", { name: "ann", bio: "new", key: "ann-key" });
    await restart();
    expect(await status(sid)).toBe(404);
    expect(await status(unregistered)).toBe(404);
    expect(http.sessionCount()).toBe(0);
    expect(db.prepare("SELECT count(*) AS n FROM http_sessions").get()).toEqual({ n: 1 });
  });

  it("counts a restore against maxSessions and answers 503 at the cap", async () => {
    const sid = await registered("ann");
    await restart({ maxSessions: 1 });
    const auth = { Authorization: `Bearer ${TOKEN}` };
    const first = await post(auth);
    expect(first.status).toBe(200);
    const refused = await fetch(rawUrl(http), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...auth, "mcp-session-id": sid },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    expect(refused.status).toBe(503);
    expect(refused.headers.get("connection")).toBe("close");
    expect(http.sessionCount()).toBe(1);
    await fetch(url(), { method: "DELETE", headers: { ...auth, "mcp-session-id": first.headers.get("mcp-session-id")! } });
    expect(await status(sid)).toBe(200);
    expect(http.sessionCount()).toBe(1);
  });
});

describe("agent headers", () => {
  const KEY = "ann-secret-key";
  const named = (name = "ann", key = KEY) => ({ "X-Message-CP-Agent": name, "X-Message-CP-Agent-Key": key });

  /** A client whose every request carries the agent headers, as one configured with them does. */
  async function connectAs(headers: Record<string, string>, token = TOKEN): Promise<Client> {
    const client = new Client({ name: "test", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(url(), { requestInit: { headers: { Authorization: `Bearer ${token}`, ...headers } } }),
    );
    open.push(client);
    return client;
  }

  async function restart(): Promise<void> {
    for (const c of open) await c.close().catch(() => {});
    open = [];
    await http.close();
    http = await startHttp(db, { token: TOKEN, port: 0 });
  }

  /** An initialize sent with `rawHeaders` exactly as given, so a header can be repeated. */
  const rawPost = (rawHeaders: string[]) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request(
        url(),
        {
          method: "POST",
          headers: [
            "Content-Type", "application/json",
            "Accept", "application/json, text/event-stream",
            "Authorization", `Bearer ${TOKEN}`,
            ...rawHeaders,
          ],
        },
        (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => resolve({ status: res.statusCode!, body }));
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify(init));
    });

  it("acts as the named agent from the first tool call, with no register", async () => {
    const ann = await connectAs(named());
    expect((await call(ann, "read_inbox", {})).isError).toBe(false);
    const bob = await connect();
    await call(bob, "register", { name: "bob", bio: "y" });
    expect((await call(ann, "send_message", { to: "bob", body: "hi bob" })).isError).toBe(false);
    expect(JSON.parse((await call(bob, "read_inbox", {})).text)).toEqual([expect.objectContaining({ from: "ann", body: "hi bob" })]);
    expect(db.prepare("SELECT count(*) AS n FROM http_sessions").get()).toEqual({ n: 2 });
  });

  it("delivers mail sent before the agent's first header session", async () => {
    const first = await connect();
    await call(first, "register", { name: "Ann", bio: "keeps this", key: KEY });
    const bob = await connect();
    await call(bob, "register", { name: "bob", bio: "y" });
    await call(bob, "send_message", { to: "Ann", body: "waiting for you" });
    // Any case of the name is the same agent.
    const ann = await connectAs(named("ann"));
    expect((await call(ann, "read_inbox", {})).text).toContain("waiting for you");
    expect(JSON.parse((await call(bob, "list_agents", {})).text)).toContainEqual(
      expect.objectContaining({ name: "Ann", bio: "keeps this" }),
    );
  });

  it("is the same agent, with the same mail, in a new session after a restart", async () => {
    const ann = await connectAs(named());
    await call(ann, "read_inbox", {});
    const bob = await connect();
    await call(bob, "register", { name: "bob", bio: "y" });
    await call(bob, "send_message", { to: "ann", body: "before restart" });
    await restart();
    const again = await connectAs(named());
    expect((await call(again, "read_inbox", {})).text).toContain("before restart");
  });

  it("records the session, so its own id is restored after a restart without the headers", async () => {
    const ann = await connectAs(named());
    await call(ann, "read_inbox", {});
    const sid = (ann.transport as StreamableHTTPClientTransport).sessionId!;
    const bob = await connect();
    await call(bob, "register", { name: "bob", bio: "y" });
    await call(bob, "send_message", { to: "ann", body: "before restart" });
    await restart();
    const resumed = new Client({ name: "test", version: "0" });
    await resumed.connect(
      new StreamableHTTPClientTransport(url(), { sessionId: sid, requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }),
    );
    open.push(resumed);
    expect((await call(resumed, "read_inbox", {})).text).toContain("before restart");
    expect(db.prepare("SELECT name FROM agents ORDER BY name").all()).toEqual([{ name: "ann" }, { name: "bob" }]);
  });

  it("refuses a wrong key, a person's name and an invalid name or key with 403 and the register message, and creates no session", async () => {
    const owner = await connect();
    await call(owner, "register", { name: "ann", bio: "x", key: KEY });
    addPerson(db, "owner", "colin");
    await owner.close();
    open = [];
    const before = http.sessionCount();
    const cases: [Record<string, string>, string][] = [
      [named("ann", "wrong-key"), "Agent 'ann' is already registered and has a key. Pass its key to take it over."],
      [named("colin", "any-key"), "The name 'colin' belongs to a person, not an agent. No agent can register or remove it."],
      [named("not a name"), "Invalid name: use 1-32 characters from letters, digits, '-' and '_'."],
      [named("all"), "The name 'all' is reserved."],
      [named("ann", "k".repeat(257)), "Invalid key: use 1-256 characters."],
    ];
    for (const [headers, message] of cases) {
      const res = await post({ Authorization: `Bearer ${TOKEN}`, ...headers });
      expect(res.status).toBe(403);
      const text = await res.text();
      expect(JSON.parse(text).error.message).toBe(message);
      expect(text).not.toContain(headers["X-Message-CP-Agent-Key"]);
      expect(res.headers.get("mcp-session-id")).toBeNull();
    }
    expect(http.sessionCount()).toBe(before);
  });

  it("answers 503 with Retry-After when the database is too busy to register, creating no session", async () => {
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
      if (sql.startsWith("SELECT name, key_hash, person FROM agents")) {
        throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
      }
      return prepare(sql);
    }) as typeof db.prepare);
    const res = await post({ Authorization: `Bearer ${TOKEN}`, ...named() });
    vi.restoreAllMocks();
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("1");
    expect(http.sessionCount()).toBe(0);
  });

  it("answers 400 to one header alone or a repeated header, before the session cap", async () => {
    await http.close();
    http = await startHttp(db, { token: TOKEN, port: 0, maxSessions: 1 });
    expect((await post({ Authorization: `Bearer ${TOKEN}` })).status).toBe(200);
    // At the cap, a malformed pair is still told what is wrong with it.
    const alone = await post({ Authorization: `Bearer ${TOKEN}`, "X-Message-CP-Agent": "ann" });
    expect(alone.status).toBe(400);
    // The body is left unread, so the connection is closed rather than kept for another request.
    expect(alone.headers.get("connection")).toBe("close");
    expect((await post({ Authorization: `Bearer ${TOKEN}`, "X-Message-CP-Agent-Key": KEY })).status).toBe(400);
    const twice = await rawPost(["X-Message-CP-Agent", "ann", "X-Message-CP-Agent", "bob", "X-Message-CP-Agent-Key", KEY]);
    expect(twice.status).toBe(400);
    expect(twice.body).not.toContain(KEY);
    const keyTwice = await rawPost(["X-Message-CP-Agent", "ann", "X-Message-CP-Agent-Key", KEY, "X-Message-CP-Agent-Key", KEY]);
    expect(keyTwice.status).toBe(400);
    expect(http.sessionCount()).toBe(1);
    expect(db.prepare("SELECT count(*) AS n FROM agents").get()).toEqual({ n: 0 });
  });

  it("never touches another account's agent of the same name", async () => {
    const other = addAccount(db, "other").token;
    const owners = await connectAs(named());
    await call(owners, "read_inbox", {});
    // The same headers with another account's token make that account's own ann; the owner's keeps its key.
    const theirs = await connectAs(named("ann", "their-key"), other);
    expect((await call(theirs, "read_inbox", {})).isError).toBe(false);
    const bob = await connect();
    await call(bob, "register", { name: "bob", bio: "y" });
    await call(bob, "send_message", { to: "ann", body: "for the owner's ann" });
    expect((await call(theirs, "read_inbox", {})).text).not.toContain("for the owner's ann");
    expect((await call(owners, "read_inbox", {})).text).toContain("for the owner's ann");
    const res = await post({ Authorization: `Bearer ${TOKEN}`, ...named("ann", "their-key") });
    expect(res.status).toBe(403);
    const rows = db.prepare("SELECT account_id, name FROM agents ORDER BY account_id").all() as { account_id: number }[];
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.account_id)).size).toBe(2);
  });

  it("ignores the headers on a request in an existing session", async () => {
    const ann = await connectAs(named());
    await call(ann, "read_inbox", {});
    const bob = await connect();
    await call(bob, "register", { name: "bob", bio: "y", key: "bob-key" });
    await call(bob, "send_message", { to: "ann", body: "for ann" });
    const sid = (ann.transport as StreamableHTTPClientTransport).sessionId!;
    const res = await fetch(url(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${TOKEN}`,
        "mcp-session-id": sid,
        "mcp-protocol-version": "2025-03-26",
        ...named("bob", "bob-key"),
        // An empty key would be refused if the headers were read there.
        "X-Message-CP-Agent-Key": "",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "read_inbox", arguments: {} } }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("for ann");
    // register still works on a header session, and rebinds it.
    expect((await call(ann, "register", { name: "carol", bio: "z" })).isError).toBe(false);
    expect((await call(ann, "unregister", {})).isError).toBe(false);
  });

  it("never passes the key to console.error", async () => {
    const errors = vi.spyOn(console, "error");
    const ann = await connectAs(named());
    await call(ann, "read_inbox", {});
    await post({ Authorization: `Bearer ${TOKEN}`, ...named("ann", "wrong-key") });
    await post({ Authorization: `Bearer ${TOKEN}`, "X-Message-CP-Agent-Key": KEY });
    // A session that cannot be recorded logs its fixed line, and nothing about the key.
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
      if (sql.startsWith("INSERT INTO http_sessions")) throw new Error("disk I/O error");
      return prepare(sql);
    }) as typeof db.prepare);
    const again = await connectAs(named());
    expect((await call(again, "read_inbox", {})).isError).toBe(false);
    const logged = errors.mock.calls.map((args) => args.map(String).join(" "));
    vi.restoreAllMocks();
    expect(logged).toContain("message-cp serve: could not record a session for restarts");
    for (const line of logged) expect(line).not.toContain(KEY);
  });
});
