#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { openDb } from "./db.js";
import { createServer } from "./server.js";

const server = createServer(openDb());
await server.connect(new StdioServerTransport());
