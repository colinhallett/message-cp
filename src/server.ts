import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ToolError, getAgent, listAgents, registerAgent, touchAgent } from "./agents.js";
import type { Db } from "./db.js";

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
    { description: "List every registered agent with its bio and when it was last active." },
    tool(() => listAgents(db)),
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

  return server;
}
