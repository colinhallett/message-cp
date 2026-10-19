// Lets a factory run be reached over message-cp while it works. Run from the repository root:
//   node tessl-factory/scripts/message-cp.mjs start <name> <bio>   register (a suffix is added if the name is taken)
//   node tessl-factory/scripts/message-cp.mjs inbox                print and mark read any new messages
//   node tessl-factory/scripts/message-cp.mjs send <to> <body>     send a message
//   node tessl-factory/scripts/message-cp.mjs wait <seconds>       wait up to <seconds> for mail; exit 0 if some arrived, 3 if not
//   node tessl-factory/scripts/message-cp.mjs stop                 unregister
// Needs MESSAGE_CP_URL (the server's https URL, with or without /mcp) and MESSAGE_CP_HTTP_TOKEN, and the MCP SDK
// installed (`npm ci --ignore-scripts` is enough). The agent's name and key are kept in /tmp/message-cp-agent.json
// so every call acts as the same agent. The token is never printed.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const STATE = "/tmp/message-cp-agent.json";
const [command, ...rest] = process.argv.slice(2);
const token = process.env.MESSAGE_CP_HTTP_TOKEN?.trim();
const base = process.env.MESSAGE_CP_URL?.trim().replace(/\/mcp\/?$/, "").replace(/\/$/, "");
if (!token || !base) {
  console.error("message-cp: MESSAGE_CP_URL and MESSAGE_CP_HTTP_TOKEN must be set; carrying on without message-cp");
  process.exit(2);
}

const state = () => {
  if (!existsSync(STATE)) {
    console.error("message-cp: not started; run `start` first");
    process.exit(2);
  }
  return JSON.parse(readFileSync(STATE, "utf8"));
};

async function withClient(fn) {
  const client = new Client({ name: "factory-run", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }),
  );
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content?.[0]?.text ?? "";
    if (r.isError) throw new Error(`${name}: ${text}`);
    return text;
  };
  try {
    return await fn(call);
  } finally {
    await client.close();
  }
}

/** Acts as the started agent for one call. */
const asAgent = (fn) => {
  const { name, key, bio } = state();
  return withClient(async (call) => {
    await call("register", { name, bio, key });
    return fn(call, name);
  });
};

switch (command) {
  case "start": {
    const [wanted, bio = "Tessl factory run"] = rest;
    if (!wanted) throw new Error("usage: start <name> <bio>");
    const slug = wanted.toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 26);
    const key = randomBytes(32).toString("hex");
    await withClient(async (call) => {
      for (const name of [slug, `${slug}-${randomBytes(2).toString("hex")}`]) {
        try {
          await call("register", { name, bio, key });
          writeFileSync(STATE, JSON.stringify({ name, key, bio }), { mode: 0o600 });
          console.log(`message-cp: registered as ${name}`);
          return;
        } catch (err) {
          if (!/key/i.test(String(err))) throw err;
        }
      }
      throw new Error("could not register: both names are taken");
    });
    break;
  }
  case "inbox": {
    await asAgent(async (call) => {
      const messages = JSON.parse(await call("read_inbox", {}));
      if (messages.length === 0) console.log("message-cp: no new messages");
      for (const m of messages) console.log(`--- from ${m.from} at ${m.sentAt}${m.broadcast ? " (broadcast)" : ""}\n${m.body}`);
    });
    break;
  }
  case "send": {
    const [to, ...body] = rest;
    if (!to || body.length === 0) throw new Error("usage: send <to> <body>");
    await asAgent(async (call) => console.log(await call("send_message", { to, body: body.join(" ") })));
    break;
  }
  case "wait": {
    const seconds = Math.max(1, Math.min(600, Number(rest[0]) || 60));
    const { name } = state();
    const deadline = Date.now() + seconds * 1000;
    while (Date.now() < deadline) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), Math.max(1000, deadline - Date.now()));
      try {
        const r = await fetch(`${base}/wait?agent=${encodeURIComponent(name)}`, {
          headers: { authorization: `Bearer ${token}` },
          signal: ac.signal,
        });
        if (r.status === 200) {
          console.log(`message-cp: ${(await r.text()).trim()}`);
          process.exit(0);
        }
        if (r.status !== 204) throw new Error(`wait: HTTP ${r.status}`);
      } catch (err) {
        if (!ac.signal.aborted) throw err;
      } finally {
        clearTimeout(timer);
      }
    }
    console.log("message-cp: no mail");
    process.exit(3);
  }
  case "stop": {
    await asAgent(async (call) => {
      await call("unregister", {});
      rmSync(STATE, { force: true });
      console.log("message-cp: unregistered");
    });
    break;
  }
  default:
    console.error("usage: message-cp.mjs start <name> <bio> | inbox | send <to> <body> | wait <seconds> | stop");
    process.exit(2);
}
