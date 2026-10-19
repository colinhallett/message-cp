import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { identityOf, registerAgent } from "../src/agents.js";
import { joinChannel, post, readChannel, type Member } from "../src/channels.js";
import { OWNER_ACCOUNT, openDb, type Db } from "../src/db.js";
import { readInbox, sendMessage, unreadSummary } from "../src/messages.js";
import { createServer } from "../src/server.js";
import { formatUnread, waitCommand } from "../src/wait.js";

const root = resolve(import.meta.dirname, "..");
const tsx = join(root, "node_modules/.bin/tsx");
let dbFile: string;
let db: Db;

beforeEach(() => {
  dbFile = join(mkdtempSync(join(tmpdir(), "message-cp-wait-")), "db.sqlite");
  db = openDb(dbFile);
});

afterEach(() => {
  delete process.env.MESSAGE_CP_DB;
  db.close();
});

/**
 * Starts `message-cp wait <name>` as its own process on the test database. Starting src/cli.ts
 * through tsx takes ~0.4 s on its own but can exceed 5 s while the full suite runs, so the two
 * tests that wait for mail set a 20 s timeout; they timed out under that load at vitest's default.
 */
function startWait(name: string) {
  const child = spawn(tsx, [join(root, "src/cli.ts"), "wait", name], {
    env: { ...process.env, MESSAGE_CP_DB: dbFile },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const exited = new Promise<number | null>((res) => child.on("close", res));
  return { child, exited, out: () => stdout, err: () => stderr };
}

describe("message-cp wait", () => {
  it("exits at once when mail is already waiting, and leaves it unread", async () => {
    registerAgent(db, OWNER_ACCOUNT, "a", "x");
    registerAgent(db, OWNER_ACCOUNT, "b", "x");
    sendMessage(db, OWNER_ACCOUNT, "b", "a", "secret body");
    const w = startWait("a");
    expect(await w.exited).toBe(0);
    expect(w.out().trim()).toBe("1 unread message from b");
    expect(w.out()).not.toContain("secret body");
    expect(unreadSummary(db, OWNER_ACCOUNT, "a")).toEqual({ count: 1, senders: ["b"], posts: 0, channels: [] });
  }, 20_000);

  it("keeps waiting until a message arrives from another process", async () => {
    registerAgent(db, OWNER_ACCOUNT, "a", "x");
    registerAgent(db, OWNER_ACCOUNT, "b", "x");
    registerAgent(db, OWNER_ACCOUNT, "c", "x");
    const w = startWait("a");
    const early = await Promise.race([w.exited, new Promise((r) => setTimeout(() => r("waiting"), 2500))]);
    expect(early).toBe("waiting");
    sendMessage(db, OWNER_ACCOUNT, "b", "a", "one");
    sendMessage(db, OWNER_ACCOUNT, "c", "a", "two");
    sendMessage(db, OWNER_ACCOUNT, "b", "a", "three");
    expect(await w.exited).toBe(0);
    expect(w.out().trim()).toMatch(/^3 unread messages from b, c$/);
    expect(readInbox(db, OWNER_ACCOUNT, "a").map((m) => m.body)).toEqual(["one", "two", "three"]);
  }, 20_000);

  it("does not fire for read mail or mail to someone else", async () => {
    registerAgent(db, OWNER_ACCOUNT, "a", "x");
    registerAgent(db, OWNER_ACCOUNT, "b", "x");
    sendMessage(db, OWNER_ACCOUNT, "b", "a", "old");
    readInbox(db, OWNER_ACCOUNT, "a");
    sendMessage(db, OWNER_ACCOUNT, "a", "b", "not for a");
    expect(unreadSummary(db, OWNER_ACCOUNT, "a")).toEqual({ count: 0, senders: [], posts: 0, channels: [] });
  });

  it("wakes for a post in a joined channel, names the channel and not the body, and not again once it is read", async () => {
    const member = (name: string): Member => ({ ...identityOf(db, OWNER_ACCOUNT, name)!, name });
    registerAgent(db, OWNER_ACCOUNT, "a", "x");
    registerAgent(db, OWNER_ACCOUNT, "b", "x");
    joinChannel(db, OWNER_ACCOUNT, member("a"), "build");
    post(db, OWNER_ACCOUNT, member("b"), "other", "not joined");
    const w = startWait("a");
    const early = await Promise.race([w.exited, new Promise((r) => setTimeout(() => r("waiting"), 2500))]);
    expect(early).toBe("waiting");
    post(db, OWNER_ACCOUNT, member("b"), "build", "secret post");
    sendMessage(db, OWNER_ACCOUNT, "b", "a", "hi");
    expect(await w.exited).toBe(0);
    expect(w.out()).toBe("1 unread message from b; 1 unread post in #build\n");
    readInbox(db, OWNER_ACCOUNT, "a");
    readChannel(db, OWNER_ACCOUNT, member("a"), "build");
    const again = startWait("a");
    const held = await Promise.race([again.exited, new Promise((r) => setTimeout(() => r("waiting"), 2500))]);
    again.child.kill();
    expect(held).toBe("waiting");
  }, 20_000);

  it("exits non-zero naming an agent that is not registered", async () => {
    const w = startWait("ghost");
    expect(await w.exited).toBe(1);
    expect(w.err()).toContain("ghost");
  });
});

describe("formatUnread", () => {
  it("is the messages part alone without posts, as before channels, and the posts part alone without messages", () => {
    expect(formatUnread({ count: 2, senders: ["alice", "bob"], posts: 0, channels: [] })).toBe("2 unread messages from alice, bob");
    expect(formatUnread({ count: 0, senders: [], posts: 3, channels: ["build", "ops"] })).toBe("3 unread posts in #build, #ops");
    expect(formatUnread({ count: 1, senders: ["alice"], posts: 1, channels: ["build"] })).toBe(
      "1 unread message from alice; 1 unread post in #build",
    );
  });
});

describe("message-cp hive", () => {
  it("is an unknown command", async () => {
    const child = spawn(tsx, [join(root, "src/cli.ts"), "hive", "--config", "hive.json"], {
      env: { ...process.env, MESSAGE_CP_DB: dbFile },
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    expect(await new Promise((res) => child.on("close", res))).toBe(2);
    expect(stderr).toContain("unknown command 'hive'");
  });
});

describe("register result", () => {
  it("returns the wait command for the agent, next to the existing fields", async () => {
    process.env.MESSAGE_CP_DB = dbFile;
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
    expect(result.waitCommand).toContain(`MESSAGE_CP_DB=${dbFile}`);
    expect(client.getInstructions()).toBeTruthy();
    await client.close();
  });
});

describe("waitCommand", () => {
  it("pins the server's MESSAGE_CP_DB in the command", () => {
    expect(waitCommand("zed", { MESSAGE_CP_DB: dbFile })).toMatch(new RegExp(`^MESSAGE_CP_DB=${dbFile} node `));
  });
});
