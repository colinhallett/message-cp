// Stand-in for an agent CLI: reads the prompt on stdin, replies through memory-cp's send_message.
// argv: <mcp config path> <mode>. mode "reply" answers the first sender; "fail" exits 3; "hang" never exits.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { appendFileSync, readFileSync } from "node:fs";

const [configPath, mode, logPath] = process.argv.slice(2);
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
appendFileSync(logPath, JSON.stringify({ start: Date.now() }) + "\n");

if (mode === "hang") setInterval(() => {}, 1000);
else if (mode === "fail") {
  console.error("stand-in failed");
  process.exit(3);
} else {
  const server = JSON.parse(readFileSync(configPath, "utf8")).mcpServers["memory-cp"];
  const client = new Client({ name: "stand-in", version: "0" });
  await client.connect(
    new StdioClientTransport({ command: server.command, args: server.args, env: { ...process.env, ...server.env } }),
  );
  const sender = /--- From (\S+)/.exec(prompt)[1];
  const bodies = [...prompt.matchAll(/^--- From .*---\n(.*)$/gm)].map((m) => m[1]);
  await client.callTool({ name: "send_message", arguments: { to: sender, body: `done: ${bodies.join(" | ")}` } });
  await client.close();
  console.log(JSON.stringify({ session_id: "sess-" + Date.now() }));
  appendFileSync(logPath, JSON.stringify({ end: Date.now(), resumed: process.env.STAND_IN_RESUME ?? null }) + "\n");
}
