// End-to-end check of a message-cp HTTP server, used the way remote agents use it.
//
//   npm run e2e                                   starts dist/cli.js serve (run `npm run build` first) and checks it
//   MESSAGE_CP_HTTP_TOKEN=... npm run e2e -- --url https://host  checks a live server instead
//
// Prints one line per step it saw pass and exits 0, or names the step that failed and exits 1 (2 for bad usage).
// It never prints the token, and of message bodies only the ones it sent. The agents it registers are named
// e2e-<random>-a and -b and are unregistered before it exits, and every direct message to or from either name is
// then deleted, even when a step fails.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** How long a "no mail yet" /wait is given: the server holds it for minutes, so still waiting counts as no mail. */
const NO_MAIL_MS = 2000;
/** How soon after a send /wait must answer 200; the server checks for mail about once a second. */
const WAKE_MS = 10_000;
const CALL_TIMEOUT_MS = 15_000;
/** How long deleting the e2e messages may take in all, however long the account's history is. */
const DELETE_TIMEOUT_MS = 60_000;

class StepError extends Error {}

/** An error's message, with the cause fetch hides behind "fetch failed" (ECONNREFUSED, a bad certificate, ...). */
const describe = (err) => {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause instanceof Error ? err.cause.code ?? err.cause.message : undefined;
  return cause ? `${err.message} (${cause})` : err.message;
};

const usage = () => {
  console.error("usage: npm run e2e [-- --url <server url, with or without /mcp>]");
  process.exit(2);
};

const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== "--url")) usage();
/**
 * The live server's base URL, without /mcp. Plain http is accepted only for a loopback address (not the name
 * localhost, which a resolver may send elsewhere), so the token never
 * crosses a network in the clear; credentials, a query or a fragment in the URL are refused rather than printed.
 */
const liveUrl = (() => {
  if (!args[1]) return undefined;
  let url;
  try {
    url = new URL(args[1]);
  } catch {
    usage();
  }
  const loopback = /^127(\.\d{1,3}){3}$/.test(url.hostname) || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    console.error("e2e: --url must be https (plain http only for 127.x.x.x or [::1]): the token would cross the network in the clear");
    process.exit(2);
  }
  if (url.username || url.password || url.search || url.hash) {
    console.error("e2e: --url must not carry credentials, a query or a fragment; pass the token in MESSAGE_CP_HTTP_TOKEN");
    process.exit(2);
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "").replace(/\/mcp$/, "")}`;
})();

/** Runs one step: prints "ok" only once `fn` has returned, and turns any error into a failure of this step. */
async function step(name, fn) {
  let detail;
  try {
    detail = await fn();
  } catch (err) {
    throw new StepError(`FAIL ${name}: ${describe(err)}`);
  }
  console.log(`ok   ${name}${detail ? ` (${detail})` : ""}`);
}

/** Starts `dist/cli.js serve` on a free port with a temporary database and a fresh token. */
async function startLocal() {
  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  if (!existsSync(cli)) throw new Error(`${cli} is missing; run npm run build first`);
  const dir = mkdtempSync(join(tmpdir(), "message-cp-e2e-"));
  const token = randomBytes(32).toString("hex");
  const child = spawn(process.execPath, [cli, "serve", "--port", "0"], {
    // The new names, which the server reads first, so none set in the caller's shell can point it at a real database.
    env: { ...process.env, MESSAGE_CP_DB: join(dir, "db.sqlite"), MESSAGE_CP_HTTP_TOKEN: token },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    // The server waits for open connections before it exits; one left by a stalled request must not hold the run.
    const kill = setTimeout(() => child.kill("SIGKILL"), 5000);
    await exited;
    clearTimeout(kill);
    rmSync(dir, { recursive: true, force: true });
  };
  let stderr = "";
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the server did not say it was listening within 10s")), 10_000);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      const m = /listening on (http:\/\/\S+)\/mcp/.exec(stderr);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`the server exited (${signal ?? `code ${code}`}): ${stderr.trim()}`));
    });
  }).catch(async (err) => {
    await stop();
    throw err;
  });
  return { url, token, stop };
}

/** Rejects if `promise` has not settled within `ms`, so no network phase can hold the run (or its cleanup) open. */
const within = (promise, ms, what) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms / 1000}s`)), ms))),
  ]).finally(() => clearTimeout(timer));
};

/** Parses a tool result's JSON, or throws the server's error text, cut to one short line it cannot style the terminal with. */
function parse(result, tool) {
  const text = result.content?.[0]?.text ?? "";
  if (result.isError) {
    const shown = text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
    throw new Error(`${tool} returned an error: ${shown.length > 200 ? `${shown.slice(0, 200)}...` : shown}`);
  }
  return JSON.parse(text);
}

async function main() {
  let server;
  if (liveUrl) {
    const token = process.env.MESSAGE_CP_HTTP_TOKEN;
    if (!token) {
      console.error("e2e: set MESSAGE_CP_HTTP_TOKEN to the server's token to check it with --url");
      process.exit(2);
    }
    server = { url: liveUrl, token, stop: async () => {} };
  }

  const suffix = randomBytes(4).toString("hex");
  // Keys are made here, not by the server, so cleanup can remove an agent even if its register reply was lost.
  const agents = ["a", "b"].map((x) => ({
    name: `e2e-${suffix}-${x}`,
    key: randomBytes(24).toString("hex"),
    client: undefined,
    registering: false,
    gone: false,
  }));
  const [sender, receiver] = agents;
  const body = `e2e check ${suffix}`;
  const question = `e2e question ${suffix}`;
  const answer = `e2e answer ${suffix}`;
  /** The id of the first message, as send_message returned it. */
  let firstId;
  /**
   * The first agent's ask, started in one step and awaited in the next. Its `.catch` keeps the wait_for_mail step's
   * failure from leaving an unhandled rejection, and records why the ask failed in `askError` for that step to report.
   */
  let asking;
  let askError;
  let failure;

  const call = async (agent, name, args = {}) =>
    parse(await agent.client.callTool({ name, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS }), name);

  /** GET /wait for `name`, given up on after `ms`: resolves to the status, or "waiting" if it had not answered. */
  const wait = async (name, ms) => {
    const res = await fetch(`${server.url}/wait?agent=${encodeURIComponent(name)}`, {
      headers: { Authorization: `Bearer ${server.token}` },
      signal: AbortSignal.timeout(ms),
    }).catch((err) => {
      if (err?.name === "TimeoutError") return "waiting";
      throw err;
    });
    if (res === "waiting") return { status: res };
    return { status: res.status, text: await res.text() };
  };

  /**
   * One request to the account's dashboard API with the run's token, given up at `deadline`: resolves to the parsed
   * JSON of a 200 answer.
   */
  const api = async (method, path, query, deadline) => {
    const late = () => new Error(`deleting did not finish within ${DELETE_TIMEOUT_MS / 1000}s`);
    const left = deadline - Date.now();
    if (left <= 0) throw late();
    const url = new URL(server.url);
    url.pathname = `${url.pathname.replace(/\/$/, "")}${path}`;
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${server.token}` },
      signal: AbortSignal.timeout(Math.min(CALL_TIMEOUT_MS, left)),
    }).catch((err) => {
      throw Date.now() >= deadline ? late() : err;
    });
    if (res.status !== 200) {
      await res.body?.cancel();
      throw new Error(`${method} ${path} got ${res.status}`);
    }
    // The parser's message quotes the answer, so it is not shown.
    return res.json().catch((err) => {
      if (!(err instanceof SyntaxError)) throw err;
      throw new Error(`${method} ${path} answered something that is not JSON`);
    });
  };

  /** Deletes every direct conversation of the account that involves either e2e name, without printing any body. */
  const deleteMessages = async () => {
    const deadline = Date.now() + DELETE_TIMEOUT_MS;
    const names = new Set(agents.map((a) => a.name.toLowerCase()));
    const pairs = new Map();
    // Every page is read before anything is deleted, so this run's deletions cannot shift a later page.
    for (let offset = 0; ; offset += 200) {
      const page = await api("GET", "/api/messages", { limit: "200", offset: String(offset) }, deadline);
      if (!Array.isArray(page)) throw new Error("GET /api/messages did not answer a list");
      for (const m of page) {
        if (!names.has(String(m.from).toLowerCase()) && !names.has(String(m.to).toLowerCase())) continue;
        pairs.set([m.from, m.to].map((n) => String(n).toLowerCase()).sort().join("\n"), [m.from, m.to]);
      }
      if (page.length < 200) break;
    }
    for (const [a, b] of pairs.values()) await api("DELETE", "/api/conversation", { a, b }, deadline);
  };

  try {
    if (!server) await step("start dist/cli.js serve", async () => (server = await startLocal()).url);
    else console.log(`     checking ${server.url}`);
    const mcpUrl = new URL(`${server.url}/mcp`);

    await step("a request with no token, or a wrong one, gets 401", async () => {
      const initialize = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "e2e", version: "0" } },
      });
      for (const [label, auth] of [
        ["no token", undefined],
        ["wrong token", `Bearer ${randomBytes(32).toString("hex")}`],
      ]) {
        const res = await fetch(mcpUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            ...(auth ? { Authorization: auth } : {}),
          },
          body: initialize,
          signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        });
        await res.body?.cancel();
        if (res.status !== 401) throw new Error(`${label} got ${res.status}`);
      }
    });

    await step("two MCP clients connect over streamable HTTP and register", async () => {
      for (const agent of agents) {
        const client = new Client({ name: "message-cp-e2e", version: "0" });
        await client.connect(
          new StreamableHTTPClientTransport(mcpUrl, { requestInit: { headers: { Authorization: `Bearer ${server.token}` } } }),
          { timeout: CALL_TIMEOUT_MS },
        );
        agent.client = client;
        agent.registering = true;
        await call(agent, "register", { name: agent.name, bio: "message-cp end-to-end check", key: agent.key });
      }
      return agents.map((a) => a.name).join(", ");
    });

    await step("GET /wait has no mail for the second agent", async () => {
      const { status } = await wait(receiver.name, NO_MAIL_MS);
      if (status !== 204 && status !== "waiting") throw new Error(`got ${status}`);
      return status === 204 ? "204" : `still waiting after ${NO_MAIL_MS / 1000}s`;
    });

    await step("GET /wait answers 200 soon after the first agent sends a message", async () => {
      const pending = wait(receiver.name, WAKE_MS + 5000);
      // If the send fails, nothing awaits `pending`; stopping the server then rejects it, which must not crash the run.
      pending.catch(() => {});
      // Give the request time to reach the server, so it is held when the message arrives.
      await new Promise((r) => setTimeout(r, 500));
      firstId = (await call(sender, "send_message", { to: receiver.name, body })).messages?.[0]?.id;
      const sent = Date.now();
      const { status, text } = await pending;
      const took = Date.now() - sent;
      if (status !== 200) throw new Error(`got ${status === "waiting" ? `no answer within ${(WAKE_MS + 4500) / 1000}s` : status}`);
      if (took > WAKE_MS) throw new Error(`200 came ${took}ms after the send, more than ${WAKE_MS}ms`);
      if (!text.includes(sender.name)) throw new Error(`the summary does not name ${sender.name}`);
      return `${took}ms after the send`;
    });

    await step("read_inbox returns the message and GET /wait no longer reports mail", async () => {
      // A live server may also deliver someone's broadcast; only the message this run sent is checked, and no
      // other body is printed.
      const messages = await call(receiver, "read_inbox");
      const mine = messages.filter((m) => m.from === sender.name && m.body === body);
      if (mine.length !== 1) {
        throw new Error(`expected "${body}" from ${sender.name} once among ${messages.length} message(s), found it ${mine.length} times`);
      }
      const { status } = await wait(receiver.name, NO_MAIL_MS);
      if (status !== 204 && status !== "waiting") throw new Error(`GET /wait after read_inbox got ${status}`);
    });

    await step("message_status says the first message was read", async () => {
      if (!Number.isInteger(firstId)) throw new Error("send_message did not return the message's id");
      const statuses = await call(sender, "message_status", { ids: [firstId] });
      const status = statuses.find((s) => s.id === firstId);
      if (!status) throw new Error(`message_status did not return id ${firstId}`);
      if (status.read !== true) throw new Error(`read is ${status.read}, not true`);
      if (typeof status.readAt !== "string" || Number.isNaN(Date.parse(status.readAt))) throw new Error("readAt is not a time");
    });

    await step("wait_for_mail tells the second agent about the first agent's ask", async () => {
      asking = call(sender, "ask", { to: receiver.name, body: question, timeout_seconds: 10 });
      // If this step or the next fails, nothing awaits `asking`; its failure must not crash the run.
      asking.catch((err) => (askError = err));
      // On a live server someone's broadcast may already be unread, and wait_for_mail answers at once for it, so it is
      // asked again until its line names the first agent, for at most 10 seconds in all.
      const deadline = Date.now() + 10_000;
      for (;;) {
        if (askError) throw new Error(`ask failed: ${describe(askError)}`);
        const left = Math.ceil((deadline - Date.now()) / 1000);
        const { unread } = left > 0 ? await call(receiver, "wait_for_mail", { timeout_seconds: left }) : { unread: null };
        if (typeof unread === "string" && unread.includes(sender.name)) return;
        if (askError) throw new Error(`ask failed: ${describe(askError)}`);
        if (!unread || Date.now() >= deadline) throw new Error(unread ? `the line does not name ${sender.name}` : "no mail within 10s");
        await new Promise((r) => setTimeout(r, 500));
      }
    });

    await step("the second agent answers with in_reply_to and ask returns that reply", async () => {
      // As in the read_inbox step, only this run's question is matched, and no other body is printed.
      const messages = await call(receiver, "read_inbox");
      const asked = messages.filter((m) => m.from === sender.name && m.body === question);
      if (asked.length !== 1) {
        throw new Error(`expected "${question}" from ${sender.name} once among ${messages.length} message(s), found it ${asked.length} times`);
      }
      const id = asked[0].id;
      await call(receiver, "send_message", { to: sender.name, body: answer, in_reply_to: id });
      const result = await asking;
      if (result.id !== id) throw new Error(`ask returned id ${result.id}, not the question's ${id}`);
      if (!result.reply) throw new Error("ask returned no reply");
      if (result.reply.inReplyTo !== id) throw new Error(`the reply's inReplyTo is ${result.reply.inReplyTo}, not ${id}`);
      if (result.reply.from !== receiver.name) throw new Error(`the reply is from ${result.reply.from}, not ${receiver.name}`);
      if (result.reply.body !== answer) throw new Error(`the reply is not "${answer}"`);
    });

    await step("both agents unregister and list_agents no longer shows them", async () => {
      for (const agent of agents) {
        await call(agent, "unregister");
        agent.gone = true;
      }
      const names = new Set(agents.map((a) => a.name.toLowerCase()));
      for (let offset = 0; ; offset += 200) {
        const page = await call(sender, "list_agents", { limit: 200, offset });
        const left = page.filter((a) => names.has(a.name.toLowerCase()));
        if (left.length) throw new Error(`list_agents still shows ${left.map((a) => a.name).join(", ")}`);
        if (page.length < 200) break;
      }
    });
  } catch (err) {
    failure = err instanceof StepError ? err.message : `FAIL ${describe(err)}`;
  }

  // Leave nothing behind: remove any agent a failed step left registered, by name and key, from a fresh session
  // if its own session is unusable, then end every session.
  for (const agent of agents.filter((a) => a.registering && !a.gone)) {
    let cleanup;
    try {
      cleanup = new Client({ name: "message-cp-e2e", version: "0" });
      await cleanup.connect(
        new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), {
          requestInit: { headers: { Authorization: `Bearer ${server.token}` } },
        }),
        { timeout: CALL_TIMEOUT_MS },
      );
      const result = await cleanup.callTool({ name: "unregister", arguments: { name: agent.name, key: agent.key } }, undefined, {
        timeout: CALL_TIMEOUT_MS,
      });
      // An agent that is already gone (a register that never landed, an unregister whose reply was lost) is cleaned up.
      if (result.isError && /^No agent named /.test(result.content?.[0]?.text ?? "")) continue;
      parse(result, "unregister");
      console.error(`     cleanup: unregistered ${agent.name}`);
    } catch (err) {
      console.error(`FAIL cleanup: could not unregister ${agent.name}: ${describe(err)}`);
      failure ??= "FAIL cleanup";
    } finally {
      await within(cleanup?.close() ?? Promise.resolve(), CALL_TIMEOUT_MS, "close").catch(() => {});
    }
  }
  // Unregistering keeps an agent's messages, so delete every direct message to or from either name, including any
  // that someone else sent them during the run.
  if (agents.some((a) => a.registering)) {
    try {
      await deleteMessages();
    } catch (err) {
      console.error(`FAIL cleanup: could not delete the e2e messages: ${describe(err)}`);
      failure ??= "FAIL cleanup";
    }
  }
  for (const agent of agents) {
    if (!agent.client) continue;
    await within(agent.client.transport?.terminateSession() ?? Promise.resolve(), CALL_TIMEOUT_MS, "DELETE /mcp").catch(() => {});
    await within(agent.client.close(), CALL_TIMEOUT_MS, "close").catch(() => {});
  }
  await server?.stop();

  if (failure) {
    console.error(failure);
    process.exit(1);
  }
  console.log("all checks passed");
  // A request abandoned at its deadline may still be open; it must not keep the process alive.
  process.exit(0);
}

await main();
