import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ToolError, agentFromEnv, registerAgent } from "../src/agents.js";
import Database from "better-sqlite3";
import { OWNER_ACCOUNT, openDb, type Db } from "../src/db.js";
import { Session, createServer } from "../src/server.js";

let dir: string;
let dbFile: string;
let db: Db;
const clients: Client[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "message-cp-"));
  dbFile = join(dir, "db.sqlite");
  db = openDb(dbFile);
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  db.close();
});

/** A real server and client joined in-process, each session with its own connection to the file. */
async function connect(): Promise<Client> {
  const server = createServer(openDb(dbFile));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  clients.push(client);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: { text: string }[];
  };
  const text = res.content[0].text;
  return { isError: !!res.isError, text, json: res.isError ? undefined : JSON.parse(text) };
}

const agentRows = () => db.prepare("SELECT name, bio FROM agents").all();

describe("shared database", () => {
  it("creates the directory and file named by MESSAGE_CP_DB", () => {
    const nested = join(dir, "a", "b", "db.sqlite");
    process.env.MESSAGE_CP_DB = nested;
    try {
      openDb().close();
    } finally {
      delete process.env.MESSAGE_CP_DB;
    }
    expect(existsSync(nested)).toBe(true);
  });

  it("creates the default database owner-only whatever the umask", () => {
    const nested = join(dir, "private", "db.sqlite");
    const old = process.umask(0o000);
    try {
      openDb(nested).close();
    } finally {
      process.umask(old);
    }
    expect(statSync(join(dir, "private")).mode & 0o077).toBe(0);
    expect(statSync(nested).mode & 0o077).toBe(0);
  });

  it("pages list_agents and caps the page size", async () => {
    const one = await connect();
    for (let i = 0; i < 60; i++) db.prepare("INSERT INTO agents (account_id, name, bio, registered_at, last_seen) VALUES (1, ?, '', 0, 0)").run(`a${String(i).padStart(2, "0")}`);
    expect((await call(one, "list_agents")).json).toHaveLength(50);
    const page = (await call(one, "list_agents", { limit: 20, offset: 50 })).json;
    expect(page.map((a: { name: string }) => a.name)).toEqual(Array.from({ length: 10 }, (_, i) => `a${50 + i}`));
    expect((await call(one, "list_agents", { limit: 1000 })).isError).toBe(true);
  });

  it("shows a registration from one session to another", async () => {
    const one = await connect();
    const two = await connect();
    await call(one, "register", { name: "alice", bio: "writes code" });
    const { json } = await call(two, "list_agents");
    expect(json).toHaveLength(1);
    expect(json[0]).toMatchObject({ name: "alice", bio: "writes code" });
    expect(json[0].lastSeen).toMatch(/^\d{4}-/);
  });

  it("works across real server processes over stdio", async () => {
    const start = async () => {
      const client = new Client({ name: "test", version: "0" });
      await client.connect(
        new StdioClientTransport({
          command: "npx",
          args: ["tsx", join(import.meta.dirname, "../src/index.ts")],
          env: { ...process.env, MESSAGE_CP_DB: dbFile } as Record<string, string>,
        }),
      );
      clients.push(client);
      return client;
    };
    const [one, two] = [await start(), await start()];
    expect((await call(two, "list_agents")).json).toEqual([]);
    await call(one, "register", { name: "bob", bio: "tests" });
    expect((await call(two, "list_agents")).json[0]).toMatchObject({ name: "bob", bio: "tests" });
  }, 60_000);
});

describe("tools", () => {
  it("are only the registration, messaging, read-state, channel and search tools", async () => {
    const { tools } = await (await connect()).listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["get_agent", "join_channel", "leave_channel", "list_agents", "list_channels", "message_status", "post", "read_channel", "read_conversation", "read_inbox", "register", "search", "send_message", "set_status", "unregister"],
    );
  });
});

describe("register", () => {
  it("takes over an existing name instead of creating a second agent", async () => {
    const one = await connect();
    const two = await connect();
    const { key } = (await call(one, "register", { name: "alice", bio: "first" })).json;
    await call(two, "register", { name: "alice", bio: "second", key });
    expect(agentRows()).toEqual([{ name: "alice", bio: "second" }]);
  });

  it("compares names case-insensitively and keeps the first spelling", async () => {
    const client = await connect();
    const { key } = (await call(client, "register", { name: "Alice", bio: "one" })).json;
    await call(client, "register", { name: "ALICE", bio: "two", key });
    expect(agentRows()).toEqual([{ name: "Alice", bio: "two" }]);
    expect((await call(client, "get_agent", { name: "aLiCe" })).json.name).toBe("Alice");
  });

  it.each(["", "a".repeat(33), "has space", "dot.name", "ünï", "all", "ALL", "All"])(
    "rejects the name %j",
    async (name) => {
      const client = await connect();
      const res = await call(client, "register", { name, bio: "x" });
      expect(res.isError).toBe(true);
      expect(agentRows()).toEqual([]);
    },
  );

  it("accepts letters, digits, '-' and '_' up to 32 characters", async () => {
    const client = await connect();
    const name = "a-Z_9".padEnd(32, "x");
    expect((await call(client, "register", { name, bio: "x" })).isError).toBe(false);
  });
});

describe("get_agent", () => {
  it("returns an error for an unknown name", async () => {
    const client = await connect();
    const res = await call(client, "get_agent", { name: "nobody" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("nobody");
  });
});

describe("session identity", () => {
  it("tells an unregistered session to call register first", () => {
    expect(() => new Session(OWNER_ACCOUNT).require()).toThrow(ToolError);
    expect(() => new Session(OWNER_ACCOUNT).require()).toThrow(/Call `register` first/);
  });

  it("is not stored in the database: a second process starts unregistered", async () => {
    const one = await connect();
    await call(one, "register", { name: "alice", bio: "x" });
    const session = new Session(OWNER_ACCOUNT);
    createServer(openDb(dbFile), session);
    expect(() => session.require()).toThrow(ToolError);
  });

  it("returns the registered name after register", async () => {
    const session = new Session(OWNER_ACCOUNT);
    const server = createServer(db, session);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    clients.push(client);
    await call(client, "register", { name: "Alice", bio: "x" });
    expect(session.require()).toBe("Alice");
  });
});

describe("last seen", () => {
  const lastSeen = () =>
    (db.prepare("SELECT last_seen FROM agents WHERE name = 'alice'").get() as { last_seen: number })
      .last_seen;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("is updated by every tool call from a registered session", async () => {
    const client = await connect();
    await call(client, "register", { name: "alice", bio: "x" });
    for (const [tool, args] of [
      ["list_agents", {}],
      ["get_agent", { name: "alice" }],
    ] as const) {
      const before = lastSeen();
      await sleep(5);
      await call(client, tool, args);
      expect(lastSeen()).toBeGreaterThan(before);
    }
  });

  it("is updated even when the call returns an error", async () => {
    const client = await connect();
    await call(client, "register", { name: "alice", bio: "x" });
    const before = lastSeen();
    await sleep(5);
    expect((await call(client, "get_agent", { name: "nobody" })).isError).toBe(true);
    expect(lastSeen()).toBeGreaterThan(before);
  });

  it("is not touched by an unregistered session", async () => {
    const one = await connect();
    const two = await connect();
    await call(one, "register", { name: "alice", bio: "x" });
    const before = lastSeen();
    await sleep(5);
    await call(two, "list_agents");
    expect(lastSeen()).toBe(before);
  });
});

describe("agent keys", () => {
  const row = (name = "alice") =>
    db.prepare("SELECT bio, last_seen, key_hash FROM agents WHERE name = ?").get(name) as {
      bio: string;
      last_seen: number;
      key_hash: string | null;
    };

  it("returns a key once on creating an agent and stores only its hash", async () => {
    const client = await connect();
    const { key } = (await call(client, "register", { name: "alice", bio: "x" })).json;
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(row().key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row().key_hash).not.toBe(key);
    expect(JSON.stringify(db.prepare("SELECT * FROM agents").all())).not.toContain(key);
    const again = (await call(client, "register", { name: "alice", bio: "y", key })).json;
    expect(again.key).toBeUndefined();
  });

  it("refuses a takeover without the key or with the wrong one and changes nothing", async () => {
    const owner = await connect();
    const other = await connect();
    const { key } = (await call(owner, "register", { name: "alice", bio: "mine" })).json;
    await call(owner, "send_message", { to: "alice", body: "hi" }).catch(() => undefined);
    const before = row();
    const inbox = db.prepare("SELECT count(*) AS n FROM messages").get();
    for (const args of [{}, { key: "wrong" }]) {
      const res = await call(other, "register", { name: "ALICE", bio: "stolen", ...args });
      expect(res.isError).toBe(true);
      expect(res.text).toContain("has a key");
      expect(res.text).not.toContain(key);
    }
    expect(row()).toEqual(before);
    expect(db.prepare("SELECT count(*) AS n FROM messages").get()).toEqual(inbox);
    expect((await call(other, "send_message", { to: "alice", body: "x" })).isError).toBe(true);
  });

  it("never shows a key or hash in list_agents or get_agent", async () => {
    const client = await connect();
    const { key } = (await call(client, "register", { name: "alice", bio: "x" })).json;
    for (const r of [await call(client, "list_agents"), await call(client, "get_agent", { name: "alice" })]) {
      expect(r.text).not.toContain(key);
      expect(r.text).not.toContain(row().key_hash!);
    }
  });

  describe("from the environment", () => {
    it("creates the agent with the given key and acts as it", async () => {
      expect(agentFromEnv(db, OWNER_ACCOUNT, { MESSAGE_CP_AGENT: "worker-1", MESSAGE_CP_AGENT_KEY: "k1" })).toBe("worker-1");
      expect(row("worker-1").key_hash).not.toBeNull();
      const other = await connect();
      expect((await call(other, "register", { name: "worker-1", bio: "x", key: "k1" })).isError).toBe(false);
      expect((await call(other, "register", { name: "worker-1", bio: "x" })).isError).toBe(true);
    });

    it("claims an agent that has no key and refuses one with a different key", () => {
      db.prepare("INSERT INTO agents (account_id, name, bio, registered_at, last_seen) VALUES (1, 'old', 'b', 0, 0)").run();
      const env = { MESSAGE_CP_AGENT: "old", MESSAGE_CP_AGENT_KEY: "k1" };
      agentFromEnv(db, OWNER_ACCOUNT, env);
      expect(row("old").key_hash).not.toBeNull();
      expect(() => agentFromEnv(db, OWNER_ACCOUNT, { ...env, MESSAGE_CP_AGENT_KEY: "k2" })).toThrow(/has a key/);
      expect(row("old").bio).toBe("b");
    });

    it("needs both variables, or neither", () => {
      expect(agentFromEnv(db, OWNER_ACCOUNT, {})).toBeUndefined();
      expect(() => agentFromEnv(db, OWNER_ACCOUNT, { MESSAGE_CP_AGENT: "a" })).toThrow(ToolError);
      expect(() => agentFromEnv(db, OWNER_ACCOUNT, { MESSAGE_CP_AGENT_KEY: "k" })).toThrow(ToolError);
    });

    it("rejects empty values instead of starting anonymous", () => {
      expect(() => agentFromEnv(db, OWNER_ACCOUNT, { MESSAGE_CP_AGENT: "", MESSAGE_CP_AGENT_KEY: "" })).toThrow(ToolError);
      expect(() => agentFromEnv(db, OWNER_ACCOUNT, { MESSAGE_CP_AGENT: "" })).toThrow(ToolError);
    });

    it("refuses with a ToolError when the stored hash is malformed", () => {
      db.prepare("INSERT INTO agents (account_id, name, bio, registered_at, last_seen, key_hash) VALUES (1, 'bad', 'b', 0, 0, 'xyz')").run();
      expect(() => agentFromEnv(db, OWNER_ACCOUNT, { MESSAGE_CP_AGENT: "bad", MESSAGE_CP_AGENT_KEY: "k" })).toThrow(/has a key/);
    });

    it("refuses a takeover when the stored hash is an empty string", () => {
      db.prepare("INSERT INTO agents (account_id, name, bio, registered_at, last_seen, key_hash) VALUES (1, 'empty', 'b', 0, 0, '')").run();
      expect(() => agentFromEnv(db, OWNER_ACCOUNT, { MESSAGE_CP_AGENT: "empty", MESSAGE_CP_AGENT_KEY: "k" })).toThrow(/has a key/);
      expect(() => registerAgent(db, OWNER_ACCOUNT, "empty", "x", "k")).toThrow(/has a key/);
      expect((db.prepare("SELECT key_hash FROM agents WHERE name='empty'").get() as { key_hash: string }).key_hash).toBe("");
    });
  });

  it("migrates a database file created before keys and lets the next register claim the agent", async () => {
    const old = join(dir, "old.sqlite");
    const raw = new Database(old);
    raw.exec(`CREATE TABLE agents (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      bio TEXT NOT NULL, registered_at INTEGER NOT NULL, last_seen INTEGER NOT NULL);
      INSERT INTO agents (name, bio, registered_at, last_seen) VALUES ('legacy', 'was here', 1, 1);`);
    raw.close();
    const migrated = openDb(old);
    openDb(old).close(); // reopening must not fail on the existing column
    const server = createServer(migrated);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    clients.push(client);
    const res = await call(client, "register", { name: "legacy", bio: "claimed" });
    expect(res.isError).toBe(false);
    expect(res.json.key).toBeDefined();
    expect((await call(client, "register", { name: "legacy", bio: "again" })).isError).toBe(true);
    migrated.close();
  });

  it("two real server processes: the env-started one acts at once and the takeover is refused", async () => {
    const start = async (env: Record<string, string>) => {
      const client = new Client({ name: "test", version: "0" });
      await client.connect(
        new StdioClientTransport({
          command: "npx",
          args: ["tsx", join(import.meta.dirname, "../src/index.ts")],
          env: { ...process.env, MESSAGE_CP_DB: dbFile, ...env } as Record<string, string>,
        }),
      );
      clients.push(client);
      return client;
    };
    const worker = await start({ MESSAGE_CP_AGENT: "worker-1", MESSAGE_CP_AGENT_KEY: "secret" });
    const intruder = await start({});
    await call(intruder, "register", { name: "peer", bio: "x" });
    expect((await call(worker, "send_message", { to: "peer", body: "hello" })).isError).toBe(false);
    const res = await call(intruder, "register", { name: "worker-1", bio: "stolen" });
    expect(res.isError).toBe(true);
    expect(row("worker-1").bio).toBe("");
  }, 60_000);
});
