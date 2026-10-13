#!/usr/bin/env node
// Stand-in for the `codex` binary: parses the flags the hive passes, starts the MCP server the way Codex
// would (command and args from -c overrides, env named by env_vars taken from its own environment),
// replies to the first sender, and reports a thread id. argv is appended to $FAKE_CODEX_LOG.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { appendFileSync } from "node:fs";

const argv = process.argv.slice(2);
const cfg = {};
for (let i = 0; i < argv.length; i++) {
  if (argv[i] !== "-c") continue;
  const eq = argv[i + 1].indexOf("=");
  cfg[argv[i + 1].slice(0, eq)] = JSON.parse(argv[i + 1].slice(eq + 1));
}
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ argv, cwd: process.cwd() }) + "\n");

const env = { ...process.env };
const forwarded = Object.fromEntries(cfg["mcp_servers.memory-cp.env_vars"].map((k) => [k, process.env[k]]));
const client = new Client({ name: "fake-codex", version: "0" });
await client.connect(
  new StdioClientTransport({ command: cfg["mcp_servers.memory-cp.command"], args: cfg["mcp_servers.memory-cp.args"], env: { ...env, ...forwarded } }),
);
const sender = /--- From (\S+)/.exec(prompt)[1];
const bodies = [...prompt.matchAll(/^--- From .*---\n(.*)$/gm)].map((m) => m[1]);
await client.callTool({ name: "send_message", arguments: { to: sender, body: `done: ${bodies.join(" | ")}` } });
await client.close();
console.log(JSON.stringify({ type: "thread.started", thread_id: "thread-" + Date.now() }));
console.log(JSON.stringify({ type: "turn.completed" }));
