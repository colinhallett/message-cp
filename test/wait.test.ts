import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerAgent } from "../src/agents.js";
import { openDb, type Db } from "../src/db.js";
import { readInbox, sendMessage, unreadSummary } from "../src/messages.js";
import { createServer } from "../src/server.js";

const root = resolve(import.meta.dirname, "..");
const tsx = join(root, "node_modules/.bin/tsx");
let dbFile: string;
let db: Db;

beforeEach(() => {
  dbFile = join(mkdtempSync(join(tmpdir(), "memory-cp-wait-")), "db.sqlite");
  db = openDb(dbFile);
});

afterEach(() => {
  delete process.env.MEMORY_CP_DB;
  db.close();
});

/** Starts `memory-cp wait <name>` as its own process on the test database. */
function startWait(name: string) {
  const child = spawn(tsx, [join(root, "src/cli.ts"), "wait", name], {
    env: { ...process.env, MEMORY_CP_DB: dbFile },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const exited = new Promise<number | null>((res) => child.on("close", res));
  return { child, exited, out: () => stdout, err: () => stderr };
}

describe("memory-cp wait", () => {
  it("exits at once when mail is already waiting, and leaves it unread", async () => {
    registerAgent(db, "a", "x");
    registerAgent(db, "b", "x");
    sendMessage(db, "b", "a", "secret body");
    const w = startWait("a");
    expect(await w.exited).toBe(0);
    expect(w.out().trim()).toBe("1 unread message from b");
    expect(w.out()).not.toContain("secret body");
    expect(unreadSummary(db, "a")).toEqual({ count: 1, senders: ["b"] });
  });

  it("keeps waiting until a message arrives from another process", async () => {
    registerAgent(db, "a", "x");
    registerAgent(db, "b", "x");
    registerAgent(db, "c", "x");
    const w = startWait("a");
    const early = await Promise.race([w.exited, new Promise((r) => setTimeout(() => r("waiting"), 2500))]);
    expect(early).toBe("waiting");
    sendMessage(db, "b", "a", "one");
    sendMessage(db, "c", "a", "two");
    sendMessage(db, "b", "a", "three");
    expect(await w.exited).toBe(0);
    expect(w.out().trim()).toMatch(/^3 unread messages from b, c$/);
    expect(readInbox(db, "a").map((m) => m.body)).toEqual(["one", "two", "three"]);
  });

  it("does not fire for read mail or mail to someone else", async () => {
    registerAgent(db, "a", "x");
    registerAgent(db, "b", "x");
    sendMessage(db, "b", "a", "old");
    readInbox(db, "a");
    sendMessage(db, "a", "b", "not for a");
    expect(unreadSummary(db, "a")).toEqual({ count: 0, senders: [] });
  });

  it("exits non-zero naming an agent that is not registered", async () => {
    const w = startWait("ghost");
    expect(await w.exited).toBe(1);
    expect(w.err()).toContain("ghost");
  });
});

describe("memory-cp hive", () => {
  it("is an unknown command", async () => {
    const child = spawn(tsx, [join(root, "src/cli.ts"), "hive", "--config", "hive.json"], {
      env: { ...process.env, MEMORY_CP_DB: dbFile },
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    expect(await new Promise((res) => child.on("close", res))).toBe(2);
    expect(stderr).toContain("unknown command 'hive'");
  });
});

describe("register result", () => {
  it("returns the wait command for the agent, next to the existing fields", async () => {
    process.env.MEMORY_CP_DB = dbFile;
    const server = createServer(db);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const res = (await client.callTool({ name: "register", arguments: { name: "zed", bio: "x" } })) as {
      content: { text: string }[];
    };
    const result = JSON.parse(res.content[0].text);
    expect(result.name).toBe("zed");
    expect(result.key).toBeTruthy();
    expect(result.waitCommand).toMatch(/cli\.js wait zed$/);
    expect(result.waitCommand).toContain(`MEMORY_CP_DB=${dbFile}`);
    expect(client.getInstructions()).toBeTruthy();
    await client.close();
  });
});
