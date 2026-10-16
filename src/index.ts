#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ToolError, registerFromEnv } from "./agents.js";
import { OWNER_ACCOUNT, openDb } from "./db.js";
import { Session, createServer } from "./server.js";

const db = openDb();
// stdio is the owner's account.
const session = new Session(OWNER_ACCOUNT);
try {
  const registered = registerFromEnv(db, OWNER_ACCOUNT);
  if (registered) session.bind(registered.identity);
} catch (err) {
  if (!(err instanceof ToolError)) throw err;
  console.error(`memory-cp: ${err.message}`);
  process.exit(1);
}
const server = createServer(db, session);
await server.connect(new StdioServerTransport());
