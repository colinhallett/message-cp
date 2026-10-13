import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT, ToolError, getAgent, listAgents, registerAgent, touchAgent } from "./agents.js";
import type { Db } from "./db.js";
import { DEFAULT_INBOX_LIMIT, MAX_BODY_LENGTH, MAX_BROADCAST_RECIPIENTS, MAX_INBOX_LIMIT, readInbox, sendMessage } from "./messages.js";

/** Who this server process is acting as. Lives only in memory, never in the database. */
export class Session {
  name: string | undefined;

  /** For tools that need to know the caller. */
  require(): string {
    if (!this.name) throw new ToolError("This session is not registered. Call `register` first.");
    return this.name;
  }
}

/** One server per session. */
export function createServer(db: Db, session = new Session()): McpServer {
  const server = new McpServer({ name: "memory-cp", version: "0.1.0" });

  // Wraps a tool: bumps last-seen for a registered session and turns ToolError into an error result.
  const tool = <A>(run: (args: A) => unknown) => async (args: A) => {
    // Touch first so a failing call still counts. `register` sets last-seen itself.
    if (session.name) touchAgent(db, session.name);
    try {
      const result = run(args);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      if (err instanceof ToolError) {
        return { isError: true, content: [{ type: "text" as const, text: err.message }] };
      }
      throw err;
    }
  };

  server.registerTool(
    "register",
    {
      description:
        "Register this session as an agent with a name and short bio. If the name exists (any case), this session takes that agent over and its bio is updated.",
      inputSchema: {
        name: z.string().describe("1-32 characters: letters, digits, '-' and '_'. 'all' is reserved."),
        bio: z.string().describe("A short description of who you are and what you work on."),
      },
    },
    tool(({ name, bio }: { name: string; bio: string }) => {
      const agent = registerAgent(db, name, bio);
      session.name = agent.name;
      return agent;
    }),
  );

  server.registerTool(
    "list_agents",
    {
      description: `List registered agents by name with their bio and when they were last active. Returns one page (default ${DEFAULT_LIST_LIMIT}, max ${MAX_LIST_LIMIT}); a full page means there may be more, so call again with a higher offset.`,
      inputSchema: {
        limit: z.number().int().min(1).max(MAX_LIST_LIMIT).optional(),
        offset: z.number().int().min(0).optional(),
      },
    },
    tool(({ limit, offset }: { limit?: number; offset?: number }) => listAgents(db, limit, offset)),
  );

  server.registerTool(
    "get_agent",
    {
      description: "Get one registered agent by name (case-insensitive).",
      inputSchema: { name: z.string() },
    },
    tool(({ name }: { name: string }) => {
      const agent = getAgent(db, name);
      if (!agent) throw new ToolError(`No agent named '${name}'.`);
      return agent;
    }),
  );

  server.registerTool(
    "send_message",
    {
      description: `Send a message to one registered agent by name, or to every other registered agent with to: 'all'. A broadcast only reaches agents registered when it is sent, and fails with nothing sent if more than ${MAX_BROADCAST_RECIPIENTS} other agents are registered. Requires register first.`,
      inputSchema: {
        to: z.string().describe("An agent name, or 'all'."),
        body: z.string().describe(`The message, at most ${MAX_BODY_LENGTH} characters.`),
      },
    },
    tool(({ to, body }: { to: string; body: string }) => sendMessage(db, session.require(), to, body)),
  );

  server.registerTool(
    "read_inbox",
    {
      description: `Read your messages, oldest first, one page at a time (default ${DEFAULT_INBOX_LIMIT}, max ${MAX_INBOX_LIMIT}). By default only unread ones; everything returned is marked read, so a full page means there may be more: call again. With unread_only false, use offset to page through history. Messages are not pushed, so call this to check. Requires register first.`,
      inputSchema: {
        unread_only: z.boolean().optional().describe("Default true."),
        limit: z.number().int().min(1).max(MAX_INBOX_LIMIT).optional(),
        offset: z.number().int().min(0).optional(),
      },
    },
    tool(({ unread_only, limit, offset }: { unread_only?: boolean; limit?: number; offset?: number }) =>
      readInbox(db, session.require(), unread_only, limit, offset),
    ),
  );

  return server;
}
