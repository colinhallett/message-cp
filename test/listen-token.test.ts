import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LISTEN_AGENT, accountForToken, addAccount, addToken, listAccounts, revokeToken } from "../src/accounts.js";
import { addPerson, identityOf, purgeAgent, registerAgent, removeAgent } from "../src/agents.js";
import { saveSession } from "../src/sessions.js";
import { OWNER_ACCOUNT, openDb, type AccountId, type Db } from "../src/db.js";
import { startHttp, type HttpServer } from "../src/http.js";
import { sendMessage } from "../src/messages.js";
import { httpWaitCommand } from "../src/wait.js";

// A session connected by approval gets a listen token for its agent: from `register` for a client that registers its own
// agents, from `listen_token` for a single-agent approval. It only waits for that agent's mail on GET /wait.
const OWNER_TOKEN = "owner-token";
const REDIRECT = "http://localhost:9999/callback";
let db: Db;
let http: HttpServer;
let friend: AccountId;
let ownerFull: string;
let publicUrl: string;
const clients: Client[] = [];

beforeEach(async () => {
  db = openDb(join(mkdtempSync(join(tmpdir(), "message-cp-listen-")), "db.sqlite"));
  addAccount(db, "friend");
  friend = listAccounts(db).find((a) => a.name === "friend")!.id;
  ownerFull = addToken(db, "owner").token;
  http = await startHttp(db, { token: OWNER_TOKEN, port: 0, waitHoldMs: 0 });
  const port = http.port;
  await http.close();
  publicUrl = `http://127.0.0.1:${port}`;
  http = await startHttp(db, { token: OWNER_TOKEN, port, waitHoldMs: 0, publicUrl });
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => {})));
  await http.close();
  db.close();
});

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const get = (path: string, token: string, method = "GET") => fetch(`${publicUrl}${path}`, { method, headers: auth(token) });

/** Runs the OAuth flow with the owner's full token and the approval `body`; returns the token and its row id. */
async function approved(body: Record<string, unknown> = { registers: true }): Promise<{ token: string; id: number }> {
  const reg = await fetch(`${publicUrl}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "Claude Code", redirect_uris: [REDIRECT] }),
  });
  const clientId = ((await reg.json()) as { client_id: string }).client_id;
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const page = await fetch(
    `${publicUrl}/oauth/authorize?${new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "s1",
      resource: `${publicUrl}/mcp`,
    })}`,
  );
  const request = /data-request="([0-9a-f]+)"/.exec(await page.text())![1];
  const res = await fetch(`${publicUrl}/oauth/approve`, {
    method: "POST",
    headers: { ...auth(ownerFull), "Content-Type": "application/json" },
    body: JSON.stringify({ request, state: "s1", ...body }),
  });
  const code = new URL(((await res.json()) as { location: string }).location).searchParams.get("code")!;
  const exchanged = await fetch(`${publicUrl}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource: `${publicUrl}/mcp` }).toString(),
  });
  const token = ((await exchanged.json()) as { access_token: string }).access_token;
  return { token, id: db.prepare("SELECT max(id) FROM tokens").pluck().get() as number };
}

async function open(token: string): Promise<Client> {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${publicUrl}/mcp`), { requestInit: { headers: auth(token) } }));
  clients.push(client);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  return { isError: !!res.isError, text: res.content[0]!.text };
}

interface Listen {
  listenToken: string;
  saveListenToken: string;
  waitCommand: string;
}

/** Registers `name` on a new session of a registering approval's `token`; returns what register answered. */
const registered = async (token: string, name: string) => JSON.parse((await call(await open(token), "register", { name, bio: "x" })).text) as Listen;

describe("a listen token from register", () => {
  it("comes with register on a registering approval, with a wait command that reads only its own file", async () => {
    const { token } = await approved();
    const answer = await registered(token, "alpha");
    expect(answer.listenToken).toMatch(/^[0-9a-f]{64}$/);
    const host = new URL(publicUrl).host.replace(":", "_");
    expect(answer.saveListenToken).toContain(`~/.message-cp/wait/alpha@${host}`);
    expect(answer.saveListenToken).not.toContain(answer.listenToken);
    for (const text of [answer.waitCommand, answer.saveListenToken]) {
      expect(text).not.toContain(answer.listenToken);
      expect(text).not.toContain(token);
      expect(text).not.toContain("http-token");
      expect(text).not.toContain("MESSAGE_CP_HTTP_TOKEN");
    }
    // Only its hash is stored.
    const row = db.prepare("SELECT hash FROM listen_tokens").get() as { hash: string };
    expect(row.hash).toBe(createHash("sha256").update(answer.listenToken).digest("hex"));
  });

  it("waits for its own agent's mail, and is refused everywhere else", async () => {
    const { token } = await approved();
    const { listenToken } = await registered(token, "alpha");
    await registered(token, "gamma");
    registerAgent(db, friend, "zed", "another account's");
    expect((await get("/wait?agent=alpha", listenToken)).status).toBe(204);
    expect((await get("/wait", listenToken)).status).toBe(204);
    sendMessage(db, OWNER_ACCOUNT, "gamma", "alpha", "hi");
    const res = await get("/wait?agent=alpha", listenToken);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("1 unread message from gamma\n");
    // Another agent, of the same approval or another account, is answered as an unknown one.
    expect((await get("/wait?agent=gamma", listenToken)).status).toBe(404);
    expect((await get("/wait?agent=zed", listenToken)).status).toBe(404);
    expect((await get("/wait?agent=nobody", listenToken)).status).toBe(404);
    for (const path of ["/mcp", "/api/agents", "/api/token", "/api/messages", "/api/approvals", "/oauth/approve"]) {
      expect((await get(path, listenToken, path === "/mcp" || path === "/oauth/approve" ? "POST" : "GET")).status, path).toBe(403);
    }
    expect(accountForToken(db, listenToken, OWNER_TOKEN)).toMatchObject({ account: OWNER_ACCOUNT, listen: true, agent: { name: "alpha" } });
    expect(accountForToken(db, listenToken, OWNER_TOKEN)?.approval).toBeUndefined();
  });

  it("is never one of another account's: a listen token of the friend account does not learn whether a name exists in owner", async () => {
    addPerson(db, "friend", "fay", true);
    const { token } = await approved();
    await registered(token, "alpha");
    // A registering approval in the friend account, made directly as the code exchange would.
    const theirs = addToken(db, "friend", false, true, undefined, undefined, true);
    db.prepare("UPDATE tokens SET oauth = 1 WHERE id = ?").run(theirs.id);
    const { listenToken } = await registered(theirs.token, "beta");
    expect((await get("/wait?agent=beta", listenToken)).status).toBe(204);
    expect((await get("/wait?agent=alpha", listenToken)).status).toBe(404);
    expect((await get("/wait?agent=nobody", listenToken)).status).toBe(404);
  });

  it("is not given to an unbound agent token's session, which keeps the shared-file command", async () => {
    const unbound = addToken(db, "owner", false, true).token;
    const answer = JSON.parse((await call(await open(unbound), "register", { name: "plain", bio: "x" })).text);
    expect(answer).not.toHaveProperty("listenToken");
    expect(answer.waitCommand).toBe(httpWaitCommand(publicUrl, "plain"));
    const client = await open(unbound);
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain("listen_token");
    expect(client.getInstructions()).toContain("~/.message-cp/http-token");
    expect(client.getInstructions()).not.toContain("listen_token");
  });
});

describe("a listen token from listen_token", () => {
  it("is offered to a single-agent approval, whose instructions say to get it and give the listen command", async () => {
    const { token } = await approved({ agent: "beta" });
    const client = await open(token);
    expect(client.getInstructions()).toContain("as agent 'beta', which this session already is, call listen_token");
    expect(client.getInstructions()).toContain("/.message-cp/wait/$2@$3");
    expect(client.getInstructions()).not.toContain("http-token");
    const answer = JSON.parse((await call(client, "listen_token")).text) as Listen;
    expect(answer.saveListenToken).toContain("~/.message-cp/wait/beta@");
    expect((await get("/wait", answer.listenToken)).status).toBe(204);
    expect((await get("/wait?agent=beta", answer.listenToken)).status).toBe(204);
  });

  it("replaces the agent's earlier listen token, which stops working", async () => {
    const { token } = await approved({ agent: "beta" });
    const client = await open(token);
    const first = JSON.parse((await call(client, "listen_token")).text) as Listen;
    const second = JSON.parse((await call(client, "listen_token")).text) as Listen;
    expect((await get("/wait", first.listenToken)).status).toBe(401);
    expect((await get("/wait", second.listenToken)).status).toBe(204);
  });

  it("needs register first on a registering approval", async () => {
    const { token } = await approved();
    const client = await open(token);
    expect(client.getInstructions()).toContain("register, save the listen token it returns");
    expect(await call(client, "listen_token")).toMatchObject({ isError: true });
    await call(client, "register", { name: "alpha", bio: "x" });
    expect((await call(client, "listen_token")).isError).toBe(false);
  });
});

describe("a listen token stops working", () => {
  it("when its approval is revoked with token revoke, or in the dashboard", async () => {
    const one = await approved();
    const { listenToken: a } = await registered(one.token, "alpha");
    revokeToken(db, one.id);
    expect((await get("/wait?agent=alpha", a)).status).toBe(401);

    addPerson(db, "owner", "ana", true);
    const ana = addToken(db, "owner", false, false, undefined, "ana").token;
    const two = await approved({ agent: "beta" });
    const b = (JSON.parse((await call(await open(two.token), "listen_token")).text) as Listen).listenToken;
    expect((await get(`/api/approvals?id=${two.id}`, ana, "DELETE")).status).toBe(200);
    expect((await get("/wait", b)).status).toBe(401);
  });

  it("when its agent unregisters, is removed with its key, or is removed on the server", async () => {
    const { token } = await approved();
    const alphaSession = await open(token);
    const a = (JSON.parse((await call(alphaSession, "register", { name: "alpha", bio: "x" })).text) as Listen).listenToken;
    await call(alphaSession, "unregister");
    expect((await get("/wait", a)).status).toBe(401);

    const b = (await registered(token, "gamma")).listenToken;
    removeAgent(db, OWNER_ACCOUNT, "gamma", undefined, undefined, (db.prepare("SELECT max(id) FROM tokens").pluck().get() as number));
    expect((await get("/wait", b)).status).toBe(401);

    const c = (await registered(token, "delta")).listenToken;
    purgeAgent(db, "owner", "delta");
    expect((await get("/wait", c)).status).toBe(401);
    // A later agent given the name is not the token's.
    await registered(token, "delta");
    expect((await get("/wait?agent=delta", c)).status).toBe(401);
  });
});

describe("across a restart and during a held wait", () => {
  /** Restarts the server on the same port, holding a /wait for `waitHoldMs`. */
  const restart = async (waitHoldMs: number) => {
    await http.close();
    http = await startHttp(db, { token: OWNER_TOKEN, port: Number(new URL(publicUrl).port), waitHoldMs, publicUrl });
  };
  const mcp = (token: string, body: unknown, sid?: string) =>
    fetch(`${publicUrl}/mcp`, {
      method: "POST",
      headers: { ...auth(token), "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(sid && { "mcp-session-id": sid }) },
      body: JSON.stringify(body),
    });

  it("still offers listen_token on a session restored after a restart", async () => {
    const { token } = await approved();
    await registered(token, "alpha");
    // A session id this server does not hold, recorded as a server before it would have: it is restored.
    saveSession(db, "restored", OWNER_ACCOUNT, identityOf(db, OWNER_ACCOUNT, "alpha")!);
    const called = await (await mcp(token, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "listen_token", arguments: {} } }, "restored")).text();
    expect(called).toContain("listenToken");
    expect(called).not.toContain('isError":true');
  });

  it("answers 404 to a wait held when its agent is removed", async () => {
    await restart(5000);
    const { token } = await approved();
    const { listenToken } = await registered(token, "alpha");
    const held = get("/wait", listenToken);
    await new Promise((r) => setTimeout(r, 500));
    purgeAgent(db, "owner", "alpha");
    expect((await held).status).toBe(404);
  });
});

describe("the listen command", () => {
  const run = (command: string, env: Record<string, string>) => {
    const child = spawn("sh", ["-c", command], { env: { PATH: process.env.PATH!, ...env } });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const exited = new Promise<number | null>((r) => child.on("close", r));
    return { exited, out: () => out, err: () => err };
  };
  /** Runs the save instructions' shell part under `home`, as an agent would, with the token in place of the placeholder. */
  const save = (answer: Listen, home: string) => {
    const shell = /privately: (.*), with the token in place/.exec(answer.saveListenToken)![1].replace(", then ", " && ");
    return run(shell.replace("<listen token>", answer.listenToken), { HOME: home }).exited;
  };

  it("wakes only its own agent when two agents on one machine wait, and never reads the shared file", async () => {
    const home = mkdtempSync(join(tmpdir(), "message-cp-home-"));
    // A shared token file and variable belonging to someone else are both ignored.
    mkdirSync(join(home, ".message-cp"), { recursive: true });
    writeFileSync(join(home, ".message-cp", "http-token"), "someone-elses\n");
    const env = { HOME: home, MESSAGE_CP_HTTP_TOKEN: "someone-elses" };
    const alpha = await registered((await approved()).token, "alpha");
    const betaClient = await open((await approved({ agent: "beta" })).token);
    const beta = JSON.parse((await call(betaClient, "listen_token")).text) as Listen;
    expect(await save(alpha, home)).toBe(0);
    expect(await save(beta, home)).toBe(0);
    for (const dir of [".message-cp", ".message-cp/wait"]) expect(statSync(join(home, dir)).mode & 0o777).toBe(0o700);
    const host = new URL(publicUrl).host.replace(":", "_");
    expect(statSync(join(home, ".message-cp/wait", `alpha@${host}`)).mode & 0o777).toBe(0o600);
    expect(betaClient.getInstructions()).toContain(beta.waitCommand);

    const a = run(alpha.waitCommand, env);
    const b = run(beta.waitCommand, env);
    await new Promise((r) => setTimeout(r, 1500));
    sendMessage(db, OWNER_ACCOUNT, "beta", "alpha", "hi");
    expect(await a.exited).toBe(0);
    expect(a.out()).toBe("1 unread message from beta\n");
    let bDone = false;
    void b.exited.then(() => (bDone = true));
    await new Promise((r) => setTimeout(r, 1500));
    expect(bDone).toBe(false);
    sendMessage(db, OWNER_ACCOUNT, "alpha", "beta", "hi");
    expect(await b.exited).toBe(0);
    expect(b.out()).toBe("1 unread message from alpha\n");
  }, 30_000);

  it("says so and exits 1 when its file is missing, and 1 with 401 once the approval is revoked", async () => {
    const home = mkdtempSync(join(tmpdir(), "message-cp-home-"));
    mkdirSync(join(home, ".message-cp"), { recursive: true });
    writeFileSync(join(home, ".message-cp", "http-token"), `${ownerFull}\n`);
    const approval = await approved();
    const alpha = await registered(approval.token, "alpha");
    const missing = run(alpha.waitCommand, { HOME: home, MESSAGE_CP_HTTP_TOKEN: ownerFull });
    expect(await missing.exited).toBe(1);
    expect(missing.err()).toContain("no listen token in");
    expect(missing.err()).toContain("listen_token");
    expect(await save(alpha, home)).toBe(0);
    revokeToken(db, approval.id);
    const refused = run(alpha.waitCommand, { HOME: home });
    expect(await refused.exited).toBe(1);
    expect(refused.err()).toContain("401");
  }, 20_000);
});

describe("query plans", () => {
  it("finds a listen token, its approval and its agent by index", () => {
    const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT tokens.account_id ${LISTEN_AGENT} WHERE listen_tokens.hash = ?`).all("h") as { detail: string }[];
    expect(plan.map((r) => r.detail)).toEqual([
      "SEARCH listen_tokens USING INDEX sqlite_autoindex_listen_tokens_2 (hash=?)",
      "SEARCH tokens USING INTEGER PRIMARY KEY (rowid=?)",
      "SEARCH agents USING INTEGER PRIMARY KEY (rowid=?)",
    ]);
  });
});
