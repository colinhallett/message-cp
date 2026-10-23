import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addAccount } from "../src/accounts.js";
import { NOT_REGISTERED, addPerson, identityOf, registerAgent, removeAgent } from "../src/agents.js";
import { OWNER_ACCOUNT, openDb, type AccountId, type Db } from "../src/db.js";
import { startHttp, type HttpServer } from "../src/http.js";
import { TAKE_REPLY_SQL, sendMessage } from "../src/messages.js";
import { ASK_FULL, Session, WAIT_FOR_MAIL_FULL, createServer, type ServerOptions } from "../src/server.js";
import { addWebhook } from "../src/webhooks.js";

const TOKEN = "s3cret-token";
let db: Db;
let clients: Client[] = [];
let bobKey: string;

beforeEach(() => {
  db = openDb(join(mkdtempSync(join(tmpdir(), "message-cp-ask-")), "db.sqlite"));
  bobKey = registerAgent(db, OWNER_ACCOUNT, "bob", "answers").key!;
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
  const key = name === "bob" && account === OWNER_ACCOUNT ? bobKey : undefined;
  expect((await call(client, "register", { name, bio: "asks", key })).isError).toBe(false);
  return client;
}

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

const messageCount = () => (db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n;

/** The id of the one message stored to `name`, once it is there. */
async function questionTo(name: string): Promise<number> {
  for (;;) {
    const row = db
      .prepare("SELECT m.id FROM messages m JOIN agents a ON a.id = m.recipient_id WHERE a.name = ? AND a.removed_at IS NULL ORDER BY m.id DESC")
      .get(name) as { id: number } | undefined;
    if (row) return row.id;
    await sleep(20);
  }
}

describe("ask", () => {
  it("needs register first, and sends nothing", async () => {
    const client = await connect();
    expect(await call(client, "ask", { to: "bob", body: "q", timeout_seconds: 1 })).toMatchObject({ isError: true, text: NOT_REGISTERED });
    expect(messageCount()).toBe(0);
  });

  it("sends the question, returns the reply that arrives while it waits, and marks the reply read", async () => {
    const alice = await agent("alice");
    const bob = await agent("bob");
    expect((await call(alice, "set_status", { text: "asking bob" })).isError).toBe(false);
    const pending = call(alice, "ask", { to: "bob", body: "which port?", timeout_seconds: 10 });
    const question = await questionTo("bob");
    // The question is a plain direct message to bob, and sending it cleared alice's status line.
    const [received] = (await call(bob, "read_inbox")).json;
    expect(received).toMatchObject({ id: question, from: "alice", body: "which port?", inReplyTo: null, broadcast: false });
    expect(db.prepare("SELECT status FROM agents WHERE name = 'alice'").get()).toEqual({ status: null });
    // An unrelated message and a reply to another message do not end the wait.
    sendMessage(db, OWNER_ACCOUNT, "bob", "alice", "unrelated");
    const sent = await call(bob, "send_message", { to: "alice", body: "8080", in_reply_to: question });
    const replyId = sent.json.messages[0].id;
    const started = Date.now();
    const { json } = await pending;
    expect(Date.now() - started).toBeLessThan(1500);
    expect(json).toEqual({
      id: question,
      reply: { id: replyId, inReplyTo: question, from: "bob", sentAt: expect.any(String), body: "8080", broadcast: false },
    });
    // The reply is read; the unrelated message is not.
    expect((await call(alice, "read_inbox")).json.map((m: { body: string }) => m.body)).toEqual(["unrelated"]);
    expect((await call(bob, "message_status", { ids: [replyId] })).json[0].read).toBe(true);
  });

  it("returns the earliest reply by id when several have come, leaving the others unread", async () => {
    const alice = await agent("alice");
    const bob = await agent("bob");
    const pending = call(alice, "ask", { to: "bob", body: "q", timeout_seconds: 10 });
    const question = await questionTo("bob");
    expect((await call(bob, "read_inbox")).isError).toBe(false);
    // Both are stored in one go, before ask's next check.
    db.transaction(() => {
      sendMessage(db, OWNER_ACCOUNT, "bob", "alice", "first", identityOf(db, OWNER_ACCOUNT, "bob"), question);
      sendMessage(db, OWNER_ACCOUNT, "bob", "alice", "second", identityOf(db, OWNER_ACCOUNT, "bob"), question);
    })();
    expect((await pending).json.reply.body).toBe("first");
    expect((await call(alice, "read_inbox")).json.map((m: { body: string }) => m.body)).toEqual(["second"]);
  });

  it("passes over replies to the question that went to other agents", async () => {
    registerAgent(db, OWNER_ACCOUNT, "carol", "also hears");
    const alice = await agent("alice");
    const bob = await agent("bob");
    const pending = call(alice, "ask", { to: "bob", body: "q", timeout_seconds: 10 });
    const question = await questionTo("bob");
    db.transaction(() => {
      sendMessage(db, OWNER_ACCOUNT, "bob", "carol", "to carol", identityOf(db, OWNER_ACCOUNT, "bob"), question);
      sendMessage(db, OWNER_ACCOUNT, "bob", "alice", "to alice", identityOf(db, OWNER_ACCOUNT, "bob"), question);
    })();
    expect((await pending).json.reply.body).toBe("to alice");
    expect((await call(bob, "read_inbox")).isError).toBe(false);
  });

  it("polls without waiting for the write lock while no reply has come", async () => {
    const alice = await agent("alice");
    const pending = call(alice, "ask", { to: "bob", body: "q", timeout_seconds: 10 });
    const question = await questionTo("bob");
    // Another connection holds the write lock over two of ask's checks; a check that waited for it would stall the
    // event loop for the busy timeout and this sleep with it.
    const other = new Database(db.name);
    other.exec("BEGIN IMMEDIATE");
    const started = Date.now();
    await sleep(2200);
    other.exec("ROLLBACK");
    other.close();
    expect(Date.now() - started).toBeLessThan(3000);
    sendMessage(db, OWNER_ACCOUNT, "bob", "alice", "a", identityOf(db, OWNER_ACCOUNT, "bob"), question);
    expect((await pending).json.reply).toMatchObject({ inReplyTo: question, body: "a" });
  });

  it("queues the recipient's agent webhooks for the question", async () => {
    addWebhook(db, "owner", "https://example.com/hook", "agent:bob", false);
    const alice = await agent("alice");
    expect((await call(alice, "ask", { to: "bob", body: "q", timeout_seconds: 1 })).isError).toBe(false);
    const question = await questionTo("bob");
    expect(db.prepare("SELECT message_id FROM webhook_deliveries").all()).toEqual([{ message_id: question }]);
  });

  it("returns reply null with the question's id after the timeout, and gives its slot back", async () => {
    const { slots, hold } = counted(5);
    const alice = await agent("alice", { hold });
    const started = Date.now();
    const pending = call(alice, "ask", { to: "bob", body: "q", timeout_seconds: 1 });
    await sleep(200);
    expect(slots.taken).toBe(1);
    const { json } = await pending;
    expect(json).toEqual({ id: await questionTo("bob"), reply: null });
    expect(Date.now() - started).toBeGreaterThanOrEqual(950);
    expect(slots.taken).toBe(0);
  });

  it("refuses all, a person and an unknown agent, and sends nothing", async () => {
    addPerson(db, "owner", "colin");
    const alice = await agent("alice");
    for (const to of ["all", "ALL"]) {
      expect(await call(alice, "ask", { to, body: "q", timeout_seconds: 1 })).toMatchObject({ isError: true, text: "ask goes to one agent, so to cannot be 'all'." });
    }
    for (const to of ["colin", "Colin"]) {
      expect(await call(alice, "ask", { to, body: "q", timeout_seconds: 1 })).toMatchObject({
        isError: true,
        text: "'colin' is a person, who cannot answer ask; use send_message.",
      });
    }
    expect(await call(alice, "ask", { to: "nobody", body: "q", timeout_seconds: 1 })).toMatchObject({
      isError: true,
      text: "No agent named 'nobody'.",
    });
    expect(messageCount()).toBe(0);
  });

  it("refuses an empty body and a timeout that is not an integer from 1 to 240, and sends nothing", async () => {
    const alice = await agent("alice");
    expect((await call(alice, "ask", { to: "bob", body: "  ", timeout_seconds: 1 })).isError).toBe(true);
    for (const timeout_seconds of [0, 241, 1.5]) {
      const res = await call(alice, "ask", { to: "bob", body: "q", timeout_seconds });
      expect(res.isError).toBe(true);
      expect(res.text).toContain("timeout_seconds");
    }
    expect(messageCount()).toBe(0);
  });

  it("fails at once past the cap, sends nothing, and shares the cap with wait_for_mail", async () => {
    const { slots, hold } = counted(1);
    const alice = await agent("alice", { hold });
    const carol = await agent("carol", { hold });
    const held = call(alice, "wait_for_mail", { timeout_seconds: 1 });
    await sleep(200);
    const started = Date.now();
    expect(await call(carol, "ask", { to: "bob", body: "q", timeout_seconds: 10 })).toMatchObject({ isError: true, text: ASK_FULL });
    expect(Date.now() - started).toBeLessThan(500);
    expect(messageCount()).toBe(0);
    expect((await held).json).toEqual({ unread: null });
    expect(slots.taken).toBe(0);
    // And an ask holds the slot against wait_for_mail.
    const asked = call(carol, "ask", { to: "bob", body: "q", timeout_seconds: 1 });
    await sleep(200);
    expect(await call(alice, "wait_for_mail", { timeout_seconds: 10 })).toMatchObject({ isError: true, text: WAIT_FOR_MAIL_FULL });
    expect((await asked).json.reply).toBe(null);
  });

  it("gives its slot back when the question cannot be sent", async () => {
    const { slots, hold } = counted(1);
    const alice = await agent("alice", { hold });
    expect((await call(alice, "ask", { to: "nobody", body: "q", timeout_seconds: 1 })).isError).toBe(true);
    expect(slots.taken).toBe(0);
  });

  it("ends the hold and frees its slot within about a second when the client cancels", async () => {
    const { slots, hold } = counted(5);
    const alice = await agent("alice", { hold });
    const cancel = new AbortController();
    const pending = call(alice, "ask", { to: "bob", body: "q", timeout_seconds: 60 }, cancel.signal).catch((err) => err);
    await sleep(200);
    expect(slots.taken).toBe(1);
    cancel.abort();
    await pending;
    const started = Date.now();
    while (slots.taken > 0 && Date.now() - started < 2000) await sleep(50);
    expect(slots.taken).toBe(0);
    expect(Date.now() - started).toBeLessThan(1200);
  });

  it("fails as not registered when its agent is removed, and the new agent with its name keeps the reply unread", async () => {
    const alice = await agent("alice");
    const pending = call(alice, "ask", { to: "bob", body: "q", timeout_seconds: 10 });
    const question = await questionTo("bob");
    removeAgent(db, OWNER_ACCOUNT, "alice", undefined, identityOf(db, OWNER_ACCOUNT, "alice"));
    const next = await agent("alice");
    // A message to the new alice that carries the question's id is the new row's mail, not an answer to this ask.
    db.prepare("INSERT INTO messages (recipient_id, sender, body, broadcast, created_at, in_reply_to) VALUES (?, 'bob', 'a', 0, ?, ?)").run(
      identityOf(db, OWNER_ACCOUNT, "alice")!.id,
      Date.now(),
      question,
    );
    expect(await pending).toMatchObject({ isError: true, text: NOT_REGISTERED });
    const inbox = (await call(next, "read_inbox")).json;
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ inReplyTo: question });
  });

  it("never takes another account's message that carries the question's id", async () => {
    addAccount(db, "other");
    const other = (db.prepare("SELECT id FROM accounts WHERE name = 'other'").get() as { id: number }).id;
    registerAgent(db, other, "alice", "other alice");
    const alice = await agent("alice");
    const pending = call(alice, "ask", { to: "bob", body: "q", timeout_seconds: 2 });
    const question = await questionTo("bob");
    db.prepare("INSERT INTO messages (recipient_id, sender, body, broadcast, created_at, in_reply_to) VALUES (?, 'bob', 'a', 0, ?, ?)").run(
      identityOf(db, other, "alice")!.id,
      Date.now(),
      question,
    );
    expect((await pending).json).toEqual({ id: question, reply: null });
  });

  it("finds a question's reply through messages_by_question, without scanning, sorting or reading replies to others", () => {
    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${TAKE_REPLY_SQL}`).all(1, 1) as { detail: string }[]).map((r) => r.detail);
    expect(plan).toEqual(["SEARCH messages USING INDEX messages_by_question (in_reply_to=? AND recipient_id=?)"]);
  });
});

describe("ask over HTTP", () => {
  let http: HttpServer;

  beforeEach(async () => {
    registerAgent(db, OWNER_ACCOUNT, "alice", "receiver");
    // One slot, shared by GET /wait, wait_for_mail and ask.
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

  it("returns the reply, and shares its one slot with GET /wait", async () => {
    const { client } = await remote();
    expect((await call(client, "register", { name: "carol", bio: "asks" })).isError).toBe(false);
    const pending = call(client, "ask", { to: "bob", body: "q", timeout_seconds: 10 });
    const question = await questionTo("bob");
    expect((await wait("alice")).status).toBe(503);
    sendMessage(db, OWNER_ACCOUNT, "bob", "carol", "a", identityOf(db, OWNER_ACCOUNT, "bob"), question);
    expect((await pending).json.reply).toMatchObject({ inReplyTo: question, from: "bob", body: "a" });
    expect((await wait("alice")).status).toBe(204);
  });

  it("fails at once, sending nothing, while a GET /wait holds the slot", async () => {
    const { client } = await remote();
    expect((await call(client, "register", { name: "carol", bio: "asks" })).isError).toBe(false);
    const held = wait("alice");
    await sleep(100);
    expect(await call(client, "ask", { to: "bob", body: "q", timeout_seconds: 10 })).toMatchObject({ isError: true, text: ASK_FULL });
    expect(messageCount()).toBe(0);
    expect((await held).status).toBe(204);
  });

  it("frees its slot within about a second when the connection carrying the call closes", async () => {
    const { client, transport } = await remote();
    expect((await call(client, "register", { name: "carol", bio: "asks" })).isError).toBe(false);
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
        params: { name: "ask", arguments: { to: "bob", body: "q", timeout_seconds: 60 } },
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
