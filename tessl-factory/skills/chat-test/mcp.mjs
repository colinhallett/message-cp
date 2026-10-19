// Calls one message-cp tool over HTTPS as the chat agent: node mcp.mjs <tool> '<json args>'.
// The agent's name and key are kept in /tmp/chat-agent.json so each call acts as the same agent.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const STATE = "/tmp/chat-agent.json";
const [tool, rawArgs = "{}"] = process.argv.slice(2);
const args = JSON.parse(rawArgs);
const url = new URL(process.env.MESSAGE_CP_URL);
const token = process.env.MESSAGE_CP_HTTP_TOKEN?.trim();
if (!tool || !token) throw new Error("usage: node mcp.mjs <tool> '<json>' with MESSAGE_CP_URL and MESSAGE_CP_HTTP_TOKEN set");

const client = new Client({ name: "chat-test", version: "1" });
await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
const call = async (name, a) => {
  const r = await client.callTool({ name, arguments: a });
  const text = r.content?.[0]?.text ?? "";
  if (r.isError) throw new Error(`${name}: ${text}`);
  return text;
};
try {
  if (tool === "register") {
    const out = JSON.parse(await call("register", args));
    writeFileSync(STATE, JSON.stringify({ name: args.name, key: out.key }), { mode: 0o600 });
    console.log(`registered as ${args.name}`);
  } else {
    if (!existsSync(STATE)) throw new Error("register first");
    const { name, key } = JSON.parse(readFileSync(STATE, "utf8"));
    await call("register", { name, bio: "Tessl factory test agent that chats over message-cp", key });
    console.log(await call(tool, args));
  }
} finally {
  await client.close();
}
