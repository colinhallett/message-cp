import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
