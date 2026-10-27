import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addAccount } from "../src/accounts.js";
import { NOT_REGISTERED, identityOf, registerAgent, removeAgent } from "../src/agents.js";
import { joinChannel, post, type Member } from "../src/channels.js";
import { OWNER_ACCOUNT, openDb, type AccountId, type Db } from "../src/db.js";
import { startHttp, type HttpServer } from "../src/http.js";
import { sendMessage } from "../src/messages.js";
import { Session, WAIT_FOR_MAIL_FULL, createServer, type ServerOptions } from "../src/server.js";

const TOKEN = "s3cret-token";
let db: Db;
let clients: Client[] = [];

beforeEach(() => {
  db = openDb(join(mkdtempSync(join(tmpdir(), "message-cp-waitformail-")), "db.sqlite"));
  registerAgent(db, OWNER_ACCOUNT, "bob", "sender");
});

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  db.close();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function connect(options: ServerOptions = {}, account: AccountId = OWNER_ACCOUNT): Promise<Client> {
  const server = createServer(db, new Session(account), options);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  clients.push(client);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}, signal?: AbortSignal) {
  const res = (await client.callTool({ name, arguments: args }, undefined, signal && { signal })) as {
    isError?: boolean;
    content: { text: string }[];
  };
  const text = res.content[0].text;
  return { isError: !!res.isError, text, json: res.isError ? undefined : JSON.parse(text) };
}

/** A client registered as `name`. */
async function agent(name: string, options: ServerOptions = {}, account: AccountId = OWNER_ACCOUNT) {
  const client = await connect(options, account);
  expect((await call(client, "register", { name, bio: "waits" })).isError).toBe(false);
  return client;
}

const member = (name: string): Member => ({ ...identityOf(db, OWNER_ACCOUNT, name)!, name });

/** A hold that allows `max` slots at once and shows how many are taken. */
function counted(max: number) {
  const slots = { taken: 0 };
  const hold = () => {
    if (slots.taken >= max) return undefined;
    slots.taken++;
    return () => void slots.taken--;
  };
  return { slots, hold };
}

describe("wait_for_mail", () => {
  it("needs register first", async () => {
    const client = await connect();
    const res = await call(client, "wait_for_mail", { timeout_seconds: 1 });
    expect(res).toMatchObject({ isError: true, text: NOT_REGISTERED });
  });

  it("answers at once with the wait line when mail is already unread, and marks nothing read", async () => {
    const alice = await agent("alice");
    sendMessage(db, OWNER_ACCOUNT, "bob", "alice", "secret body");
    const started = Date.now();
    expect((await call(alice, "wait_for_mail")).json).toEqual({ unread: "1 unread message from bob" });
    expect(Date.now() - started).toBeLessThan(500);
    expect((await call(alice, "wait_for_mail")).json).toEqual({ unread: "1 unread message from bob" });
    const inbox = (await call(alice, "read_inbox")).json;
    expect(inbox).toHaveLength(1);
    expect(inbox[0].body).toBe("secret body");
  });

  it("answers when a message arrives while it waits", async () => {
    const alice = await agent("alice");
    const pending = call(alice, "wait_for_mail", { timeout_seconds: 10 });
    await sleep(300);
    sendMessage(db, OWNER_ACCOUNT, "bob", "alice", "hi");
    const started = Date.now();
    expect((await pending).json).toEqual({ unread: "1 unread message from bob" });
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("wakes for a post in a joined channel and for a mention", async () => {
    const alice = await agent("alice");
    expect((await call(alice, "join_channel", { channel: "build" })).isError).toBe(false);
    const posted = call(alice, "wait_for_mail", { timeout_seconds: 10 });
    await sleep(300);
    post(db, OWNER_ACCOUNT, member("bob"), "build", "green");
    expect((await posted).json).toEqual({ unread: "1 unread post in #build" });
    expect((await call(alice, "read_channel", { channel: "build" })).isError).toBe(false);

    const mentioned = call(alice, "wait_for_mail", { timeout_seconds: 10 });
    await sleep(300);
    post(db, OWNER_ACCOUNT, member("bob"), "ops", "@alice look");
    expect((await mentioned).json).toEqual({ unread: "1 unread mention in #ops" });
  });

  it("returns null after the timeout without mail, and gives its slot back", async () => {
    const { slots, hold } = counted(5);
    const alice = await agent("alice", { hold });
    const started = Date.now();
    const pending = call(alice, "wait_for_mail", { timeout_seconds: 1 });
    await sleep(200);
    expect(slots.taken).toBe(1);
    expect((await pending).json).toEqual({ unread: null });
    expect(Date.now() - started).toBeGreaterThanOrEqual(950);
    expect(slots.taken).toBe(0);
  });

  it("refuses a timeout that is not an integer from 1 to 240", async () => {
    const alice = await agent("alice");
    for (const timeout_seconds of [0, 241, 1.5]) {
      const res = await call(alice, "wait_for_mail", { timeout_seconds });
      expect(res.isError).toBe(true);
      expect(res.text).toContain("timeout_seconds");
    }
  });

  it("fails at once past the cap, answers mail already unread whatever the cap, and frees the slot after", async () => {
    const { slots, hold } = counted(1);
    const alice = await agent("alice", { hold });
    const carol = await agent("carol", { hold });
    const held = call(alice, "wait_for_mail", { timeout_seconds: 1 });
    await sleep(200);
    const started = Date.now();
    expect(await call(carol, "wait_for_mail", { timeout_seconds: 10 })).toMatchObject({ isError: true, text: WAIT_FOR_MAIL_FULL });
    expect(Date.now() - started).toBeLessThan(500);
    sendMessage(db, OWNER_ACCOUNT, "bob", "carol", "hi");
    expect((await call(carol, "wait_for_mail")).json).toEqual({ unread: "1 unread message from bob" });
    expect((await held).json).toEqual({ unread: null });
    expect(slots.taken).toBe(0);
    expect((await call(carol, "read_inbox")).isError).toBe(false);
    const again = call(carol, "wait_for_mail", { timeout_seconds: 1 });
    await sleep(200);
    expect(slots.taken).toBe(1);
    expect((await again).json).toEqual({ unread: null });
  });

  it("frees its slot when marking the caller waiting fails with an error other than busy", async () => {
    const { slots, hold } = counted(1);
    const alice = await agent("alice", { hold });
    db.exec("CREATE TRIGGER no_mark BEFORE UPDATE OF waiting_until ON agents BEGIN SELECT RAISE(ABORT, 'no mark'); END");
    expect((await call(alice, "wait_for_mail", { timeout_seconds: 1 })).isError).toBe(true);
    expect(slots.taken).toBe(0);
    db.exec("DROP TRIGGER no_mark");
    expect((await call(alice, "wait_for_mail", { timeout_seconds: 1 })).json).toEqual({ unread: null });
  });

  it("ends the hold and frees its slot within about a second when the client cancels", async () => {
    const { slots, hold } = counted(5);
    const alice = await agent("alice", { hold });
    const cancel = new AbortController();
    const pending = call(alice, "wait_for_mail", { timeout_seconds: 60 }, cancel.signal).catch((err) => err);
    await sleep(200);
    expect(slots.taken).toBe(1);
    cancel.abort();
    await pending;
    const started = Date.now();
    while (slots.taken > 0 && Date.now() - started < 2000) await sleep(50);
    expect(slots.taken).toBe(0);
    expect(Date.now() - started).toBeLessThan(1200);
  });

  it("ends with the not-registered error when its agent is removed, even if another agent takes the name", async () => {
    const alice = await agent("alice");
    const pending = call(alice, "wait_for_mail", { timeout_seconds: 10 });
    await sleep(300);
    removeAgent(db, OWNER_ACCOUNT, "alice", undefined, identityOf(db, OWNER_ACCOUNT, "alice"));
    registerAgent(db, OWNER_ACCOUNT, "alice", "someone else");
    sendMessage(db, OWNER_ACCOUNT, "bob", "alice", "for the new alice");
    expect(await pending).toMatchObject({ isError: true, text: NOT_REGISTERED });
  });

  it("is never woken by another account's mail for an agent of the same name", async () => {
    addAccount(db, "other");
    const other = (db.prepare("SELECT id FROM accounts WHERE name = 'other'").get() as { id: number }).id;
    registerAgent(db, other, "bob", "other sender");
    registerAgent(db, other, "alice", "other alice");
    const alice = await agent("alice");
    const pending = call(alice, "wait_for_mail", { timeout_seconds: 2 });
    await sleep(300);
    sendMessage(db, other, "bob", "alice", "not yours");
    expect((await pending).json).toEqual({ unread: null });
  });
});

describe("wait_for_mail over HTTP", () => {
  let http: HttpServer;

  beforeEach(async () => {
    registerAgent(db, OWNER_ACCOUNT, "alice", "receiver");
    // One slot, shared by GET /wait and wait_for_mail.
    http = await startHttp(db, { token: TOKEN, port: 0, maxSessions: 1, waitHoldMs: 500 });
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close().catch(() => {});
    await http.close();
  });

  const base = () => `http://127.0.0.1:${http.port}`;
  const wait = (agent: string) => fetch(`${base()}/wait?agent=${agent}`, { headers: { Authorization: `Bearer ${TOKEN}` } });

  async function remote(): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
    const client = new Client({ name: "test", version: "0" });
    const transport = new StreamableHTTPClientTransport(new URL("/mcp", base()), {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    });
    await client.connect(transport);
    clients.push(client);
    return { client, transport };
  }

  it("answers when mail arrives, and shares its cap with GET /wait", async () => {
    const { client } = await remote();
    expect((await call(client, "register", { name: "carol", bio: "waits" })).isError).toBe(false);
    const pending = call(client, "wait_for_mail", { timeout_seconds: 10 });
    await sleep(300);
    // The one slot is held, so a GET /wait for an agent with no mail is refused, and one with mail is answered.
    expect((await wait("alice")).status).toBe(503);
    sendMessage(db, OWNER_ACCOUNT, "bob", "alice", "hi");
    expect((await wait("alice")).status).toBe(200);
    sendMessage(db, OWNER_ACCOUNT, "bob", "carol", "hi");
    expect((await pending).json).toEqual({ unread: "1 unread message from bob" });
    // The slot is back: a GET /wait for carol answers at once on the same mail, and one for bob holds and gets 204.
    expect((await wait("carol")).status).toBe(200);
    expect((await wait("bob")).status).toBe(204);
  });

  it("fails at once while a GET /wait holds the slot", async () => {
    const { client } = await remote();
    expect((await call(client, "register", { name: "carol", bio: "waits" })).isError).toBe(false);
    const held = wait("alice");
    await sleep(100);
    expect(await call(client, "wait_for_mail", { timeout_seconds: 10 })).toMatchObject({ isError: true, text: WAIT_FOR_MAIL_FULL });
    expect((await held).status).toBe(204);
  });

  it("frees its slot within about a second when the connection carrying the call closes", async () => {
    const { client, transport } = await remote();
    expect((await call(client, "register", { name: "carol", bio: "waits" })).isError).toBe(false);
    const abort = new AbortController();
    const res = fetch(new URL("/mcp", base()), {
      method: "POST",
      signal: abort.signal,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "Mcp-Session-Id": transport.sessionId!,
        "Mcp-Protocol-Version": transport.protocolVersion!,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 99,
        method: "tools/call",
        params: { name: "wait_for_mail", arguments: { timeout_seconds: 60 } },
      }),
    }).catch(() => undefined);
    await sleep(300);
    expect((await wait("alice")).status).toBe(503);
    abort.abort();
    await res;
    await sleep(1200);
    expect((await wait("alice")).status).toBe(204);
  });
});
