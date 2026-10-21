import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addAccount } from "../src/accounts.js";
import { purgeAgent } from "../src/agents.js";
import { openDb, type Db } from "../src/db.js";
import { startHttp, type HttpServer } from "../src/http.js";
import { createServer } from "../src/server.js";

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
    expect(a.getInstructions()).not.toContain("wait");
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
