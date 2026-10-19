import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerAgent } from "../src/agents.js";
import { OWNER_ACCOUNT, openDb, type Db } from "../src/db.js";
import { startHttp, type HttpServer } from "../src/http.js";
import { sendMessage } from "../src/messages.js";
import { httpWaitCommand } from "../src/wait.js";

const TOKEN = "s3cret-token";
let db: Db;
let http: HttpServer;

beforeEach(async () => {
  db = openDb(join(mkdtempSync(join(tmpdir(), "message-cp-httpwait-")), "db.sqlite"));
  registerAgent(db, OWNER_ACCOUNT, "alice", "receiver");
  registerAgent(db, OWNER_ACCOUNT, "bob", "sender");
  http = await startHttp(db, { token: TOKEN, port: 0, waitHoldMs: 1500 });
});

afterEach(async () => {
  await http.close();
  db.close();
});

const wait = (agent: string, token: string | null = TOKEN) =>
  fetch(`http://127.0.0.1:${http.port}/wait?agent=${agent}`, {
    headers: token === null ? {} : { Authorization: `Bearer ${token}` },
  });

describe("GET /wait", () => {
  it("answers at once when mail is already waiting, without marking it read", async () => {
    sendMessage(db, OWNER_ACCOUNT, "bob", "alice", "secret body");
    const res = await wait("alice");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("1 unread message from bob\n");
    expect((await wait("alice")).status).toBe(200);
  });

  it("answers when a message arrives while it waits", async () => {
    const pending = wait("alice");
    await new Promise((r) => setTimeout(r, 300));
    sendMessage(db, OWNER_ACCOUNT, "bob", "alice", "hi");
    const res = await pending;
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("1 unread message from bob\n");
  });

  it("answers 204 after the hold when there is no mail", async () => {
    const started = Date.now();
    const res = await wait("alice");
    expect(res.status).toBe(204);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1400);
  });

  it("refuses a missing or wrong token with 401, and an unknown agent with 404", async () => {
    expect((await wait("alice", null)).status).toBe(401);
    expect((await wait("alice", "nope")).status).toBe(401);
    expect((await wait("nobody")).status).toBe(404);
  });

  it("lets go when the client disconnects mid-wait, and still serves others", async () => {
    await new Promise<void>((resolve) => {
      const req = request(`http://127.0.0.1:${http.port}/wait?agent=alice`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      req.on("error", () => {});
      req.on("socket", (s) => s.once("connect", () => setTimeout(() => (req.destroy(), resolve()), 300)));
      req.end();
    });
    await new Promise((r) => setTimeout(r, 200));
    sendMessage(db, OWNER_ACCOUNT, "bob", "alice", "hi");
    expect((await wait("alice")).status).toBe(200);
    await http.close();
  });
});

describe("the curl command", () => {
  const run = (command: string, env: Record<string, string>) => {
    const child = spawn("sh", ["-c", command], { env: { PATH: process.env.PATH!, ...env } });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const exited = new Promise<number | null>((r) => child.on("close", r));
    return { child, exited, out: () => out, err: () => err };
  };
  const command = (name: string) => httpWaitCommand(`http://127.0.0.1:${http.port}`, name);

  it("exits 0 with the summary once a message is sent, and keeps the token off the command line", async () => {
    const cmd = command("alice");
    expect(cmd).not.toContain(TOKEN);
    const p = run(cmd, { MESSAGE_CP_HTTP_TOKEN: TOKEN });
    await new Promise((r) => setTimeout(r, 2500)); // past one 204 round
    sendMessage(db, OWNER_ACCOUNT, "bob", "alice", "hi");
    expect(await p.exited).toBe(0);
    expect(p.out()).toBe("1 unread message from bob\n");
  }, 20_000);

  /** A HOME with the given files under it, each holding `contents` plus a newline. */
  const homeWith = async (files: Record<string, string>) => {
    const home = mkdtempSync(join(tmpdir(), "message-cp-home-"));
    const { mkdirSync, writeFileSync } = await import("node:fs");
    for (const [file, contents] of Object.entries(files)) {
      mkdirSync(join(home, file, ".."), { recursive: true });
      writeFileSync(join(home, file), `${contents}\n`);
    }
    return home;
  };

  it("reads the token from ~/.message-cp/http-token when the variable is unset", async () => {
    // The old file holds a wrong token, so this passes only if the new one is read first.
    const home = await homeWith({ ".message-cp/http-token": TOKEN, ".memory-cp/http-token": "old" });
    sendMessage(db, OWNER_ACCOUNT, "bob", "alice", "hi");
    const p = run(command("alice"), { HOME: home });
    expect(await p.exited).toBe(0);
  });

  it("still reads the old ~/.memory-cp/http-token when there is no new one", async () => {
    const home = await homeWith({ ".memory-cp/http-token": TOKEN });
    sendMessage(db, OWNER_ACCOUNT, "bob", "alice", "hi");
    const p = run(command("alice"), { HOME: home });
    expect(await p.exited).toBe(0);
  });

  it("still reads the old MEMORY_CP_HTTP_TOKEN, and prefers MESSAGE_CP_HTTP_TOKEN when both are set", async () => {
    const home = await homeWith({});
    sendMessage(db, OWNER_ACCOUNT, "bob", "alice", "hi");
    const old = run(command("alice"), { MEMORY_CP_HTTP_TOKEN: TOKEN, HOME: home });
    expect(await old.exited).toBe(0);
    const both = run(command("alice"), { MESSAGE_CP_HTTP_TOKEN: "nope", MEMORY_CP_HTTP_TOKEN: TOKEN, HOME: home });
    expect(await both.exited).toBe(1);
    expect(both.err()).toContain("401");
  });

  it("ends non-zero on a refused token or a missing agent, and with no token at all", async () => {
    const home = mkdtempSync(join(tmpdir(), "message-cp-home-"));
    const bad = run(command("alice"), { MESSAGE_CP_HTTP_TOKEN: "nope", HOME: home });
    expect(await bad.exited).toBe(1);
    expect(bad.err()).toContain("401");
    const missing = run(command("nobody"), { MESSAGE_CP_HTTP_TOKEN: TOKEN, HOME: home });
    expect(await missing.exited).toBe(1);
    expect(missing.err()).toContain("404");
    const none = run(command("alice"), { HOME: home });
    expect(await none.exited).toBe(1);
  });
});
