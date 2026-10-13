#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ToolError, agentFromEnv } from "./agents.js";
import { openDb } from "./db.js";
import { Session, createServer } from "./server.js";

const db = openDb();
const session = new Session();
try {
  session.name = agentFromEnv(db);
} catch (err) {
  if (!(err instanceof ToolError)) throw err;
  console.error(`memory-cp: ${err.message}`);
  process.exit(1);
}
const server = createServer(db, session);
await server.connect(new StdioServerTransport());
