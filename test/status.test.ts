import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_STATUS_LENGTH, STATUS_TTL_MS, addPerson, purgeAgent, registerAgent, removeAgent } from "../src/agents.js";
import { OWNER_ACCOUNT, openDb, type Db } from "../src/db.js";
import { listAgentsUnread, unreadSummary } from "../src/messages.js";
import { Session, createServer } from "../src/server.js";

let dbFile: string;
let db: Db;
const clients: Client[] = [];

beforeEach(() => {
  dbFile = join(mkdtempSync(join(tmpdir(), "message-cp-status-")), "db.sqlite");
  db = openDb(dbFile);
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(clients.splice(0).map((c) => c.close()));
  db.close();
});

// Each call is a separate server with its own connection to the one file, like a separate process.
async function connect(): Promise<Client> {
  const server = createServer(openDb(dbFile), new Session(OWNER_ACCOUNT));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  clients.push(client);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  const text = res.content[0].text;
  return { isError: !!res.isError, text, json: res.isError ? undefined : JSON.parse(text) };
}

async function agent(name: string) {
  const client = await connect();
  const res = await call(client, "register", { name, bio: "x" });
  return { client, key: res.json.key as string };
}

/** Each live agent's status line, as GET /api/agents gives it. */
const statuses = (now?: number) => Object.fromEntries(listAgentsUnread(db, OWNER_ACCOUNT, 50, 0, now).map((a) => [a.name, a.status]));
const REGISTER_FIRST = /Call `register` first/;

describe("set_status", () => {
  it("sets the caller's line and returns it with when it expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-22T12:00:00Z") });
    const a = await agent("alice");
    await agent("bob");
    const res = await call(a.client, "set_status", { text: "reading Linear" });
    expect(res.json).toEqual({ status: "reading Linear", expiresAt: "2026-10-22T12:05:00.000Z" });
    expect(statuses()).toEqual({ alice: "reading Linear", bob: null });
  });

  it("replaces an earlier line, and the new one's 5 minutes start again", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-22T12:00:00Z") });
    const a = await agent("alice");
    await call(a.client, "set_status", { text: "first" });
    vi.setSystemTime(new Date("2026-10-22T12:04:00Z"));
    expect((await call(a.client, "set_status", { text: "second" })).json.expiresAt).toBe("2026-10-22T12:09:00.000Z");
    vi.setSystemTime(new Date("2026-10-22T12:06:00Z"));
    expect(statuses()).toEqual({ alice: "second" });
  });

  it("clears the line with empty or whitespace-only text", async () => {
    const a = await agent("alice");
    for (const text of ["", "   "]) {
      await call(a.client, "set_status", { text: "busy" });
      expect((await call(a.client, "set_status", { text })).json).toEqual({ status: null, expiresAt: null });
      expect(statuses()).toEqual({ alice: null });
    }
  });

  it("expires 5 minutes after it was set", async () => {
    expect(STATUS_TTL_MS).toBe(5 * 60 * 1000);
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-22T12:00:00Z") });
    const a = await agent("alice");
    await call(a.client, "set_status", { text: "working" });
    vi.setSystemTime(new Date("2026-10-22T12:04:59.999Z"));
    expect(statuses()).toEqual({ alice: "working" });
    vi.setSystemTime(new Date("2026-10-22T12:05:00Z"));
    expect(statuses()).toEqual({ alice: null });
  });

  it("clears when the agent sends a direct message or a broadcast, and leaves other agents' lines", async () => {
    const a = await agent("alice");
    const b = await agent("bob");
    for (const to of ["bob", "all"]) {
      await call(a.client, "set_status", { text: "drafting" });
      await call(b.client, "set_status", { text: "waiting" });
      expect((await call(a.client, "send_message", { to, body: "hi" })).isError).toBe(false);
      expect(statuses()).toEqual({ alice: null, bob: "waiting" });
    }
  });

  it("keeps the line when the send is refused", async () => {
    const a = await agent("alice");
    await call(a.client, "set_status", { text: "drafting" });
    expect((await call(a.client, "send_message", { to: "nobody", body: "hi" })).isError).toBe(true);
    expect(statuses()).toEqual({ alice: "drafting" });
  });

  it("clears when the agent posts", async () => {
    const a = await agent("alice");
    const b = await agent("bob");
    await call(a.client, "set_status", { text: "writing up" });
    await call(b.client, "set_status", { text: "reading" });
    expect((await call(a.client, "post", { channel: "build", body: "done" })).isError).toBe(false);
    expect(statuses()).toEqual({ alice: null, bob: "reading" });
  });

  it("keeps the line when the post is refused", async () => {
    const a = await agent("alice");
    await call(a.client, "set_status", { text: "writing up" });
    expect((await call(a.client, "post", { channel: "bad name", body: "done" })).isError).toBe(true);
    expect(statuses()).toEqual({ alice: "writing up" });
  });

  it("clears on unregister, and a name registered again starts with no line", async () => {
    const a = await agent("alice");
    await call(a.client, "set_status", { text: "busy" });
    await call(a.client, "unregister");
    expect(db.prepare("SELECT status, status_at FROM agents").all()).toEqual([{ status: null, status_at: null }]);
    await call(a.client, "register", { name: "alice", bio: "again" });
    expect(statuses()).toEqual({ alice: null });
  });

  it("clears on unregister by name and key, and on message-cp agent remove, and a re-registered name has no line", async () => {
    const a = await agent("alice");
    await call(a.client, "set_status", { text: "busy" });
    removeAgent(db, OWNER_ACCOUNT, "alice", a.key);
    const b = await agent("bob");
    await call(b.client, "set_status", { text: "busy" });
    purgeAgent(db, "owner", "bob");
    expect(db.prepare("SELECT COUNT(*) FROM agents WHERE status IS NOT NULL OR status_at IS NOT NULL").pluck().get()).toBe(0);
    const again = await agent("bob");
    expect(statuses()).toEqual({ bob: null });
    // The old session's registration was removed: it gets the "not registered" error and changes nothing.
    const stale = await call(b.client, "set_status", { text: "still here" });
    expect(stale.isError).toBe(true);
    expect(stale.text).toMatch(REGISTER_FIRST);
    expect(statuses()).toEqual({ bob: null });
    expect((await call(again.client, "set_status", { text: "new" })).json.status).toBe("new");
  });

  it(`refuses more than ${MAX_STATUS_LENGTH} characters, counted as code points, and changes nothing`, async () => {
    const a = await agent("alice");
    await call(a.client, "set_status", { text: "before" });
    expect((await call(a.client, "set_status", { text: "😀".repeat(MAX_STATUS_LENGTH) })).json.status).toBe("😀".repeat(MAX_STATUS_LENGTH));
    for (const text of ["a".repeat(MAX_STATUS_LENGTH + 1), "😀".repeat(MAX_STATUS_LENGTH + 1)]) {
      const res = await call(a.client, "set_status", { text });
      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/too long/);
    }
    expect(statuses()).toEqual({ alice: "😀".repeat(MAX_STATUS_LENGTH) });
  });

  it.each(["two\nlines", "cr\r", "tab\there", "\n", " \t ", "nul\u0000", "del\u007f", "c1\u0085", "sep "])(
    "refuses a line with a newline or other control character (%j) and changes nothing",
    async (text) => {
      const a = await agent("alice");
      await call(a.client, "set_status", { text: "before" });
      const res = await call(a.client, "set_status", { text });
      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/one line/);
      expect(statuses()).toEqual({ alice: "before" });
    },
  );

  it("requires register first", async () => {
    const client = await connect();
    const res = await call(client, "set_status", { text: "hi" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(REGISTER_FIRST);
  });

  it("takes no name: an unknown argument is not a way to set another agent's line", async () => {
    const a = await agent("alice");
    await agent("bob");
    await call(a.client, "set_status", { text: "mine", name: "bob" });
    expect(statuses()).toEqual({ alice: "mine", bob: null });
  });

  it("never sets a person's line", async () => {
    addPerson(db, "owner", "dana");
    const a = await agent("alice");
    await call(a.client, "set_status", { text: "mine" });
    expect(db.prepare("SELECT status FROM agents WHERE name = 'dana'").pluck().get()).toBeNull();
    expect(statuses()).toEqual({ alice: "mine", dana: null });
  });

  it("sends nothing and marks nothing read", async () => {
    const a = await agent("alice");
    registerAgent(db, OWNER_ACCOUNT, "bob", "x");
    const b = await agent("carol");
    await call(b.client, "send_message", { to: "alice", body: "unread" });
    const before = JSON.stringify([db.prepare("SELECT * FROM messages").all(), unreadSummary(db, OWNER_ACCOUNT, "alice")]);
    await call(a.client, "set_status", { text: "reading" });
    expect(JSON.stringify([db.prepare("SELECT * FROM messages").all(), unreadSummary(db, OWNER_ACCOUNT, "alice")])).toBe(before);
  });
});
