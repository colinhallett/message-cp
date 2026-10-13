import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT, ToolError, getAgent, listAgents, registerAgent, touchAgent } from "./agents.js";
import type { Db } from "./db.js";
import {
  DEFAULT_RECALL_LIMIT,
  MAX_QUERY_LENGTH,
  MAX_RECALL_LIMIT,
  MAX_TAGS,
  MAX_TEXT_LENGTH,
  forget,
  recall,
  remember,
} from "./memories.js";
import { DEFAULT_INBOX_LIMIT, MAX_BODY_LENGTH, MAX_INBOX_LIMIT, readInbox, sendMessage } from "./messages.js";

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
        "Register this session as an agent with a name and short bio. A new name without a key you pass returns a generated key, once: keep it (if you pass your own key, nothing is returned). If the name exists (any case), this session takes that agent over and its bio is updated, but only with the agent's key; an agent registered before keys existed is claimed by the first call and gets a key.",
      inputSchema: {
        name: z.string().describe("1-32 characters: letters, digits, '-' and '_'. 'all' is reserved."),
        bio: z.string().describe("A short description of who you are and what you work on."),
        key: z.string().optional().describe("The agent's key, required to take over an existing agent that has one."),
      },
    },
    tool(({ name, bio, key }: { name: string; bio: string; key?: string }) => {
      const agent = registerAgent(db, name, bio, key);
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
      description: `Send a message to one registered agent by name, or to every other registered agent with to: 'all'. A broadcast only reaches agents registered when it is sent. Requires register first.`,
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

  server.registerTool(
    "remember",
    {
      description: `Store a memory that every agent can find later, with optional tags. It records you as the author and cannot be edited, only forgotten. Requires register first.`,
      inputSchema: {
        text: z.string().describe(`The memory, at most ${MAX_TEXT_LENGTH} characters.`),
        tags: z.array(z.string()).max(MAX_TAGS).optional().describe("Short labels to find it by."),
      },
    },
    tool(({ text, tags }: { text: string; tags?: string[] }) => remember(db, session.require(), text, tags)),
  );

  server.registerTool(
    "recall",
    {
      description: `Find memories from any agent, newest first (default ${DEFAULT_RECALL_LIMIT}, max ${MAX_RECALL_LIMIT} per call; a full page means there may be more, so call again with offset). query matches words in the text (plain words, no operators, at most ${MAX_QUERY_LENGTH} characters); tags keeps memories that carry all the given tags; author keeps one agent's memories. Filters combine; with none, returns the newest. Requires register first.`,
      inputSchema: {
        query: z.string().max(MAX_QUERY_LENGTH).optional(),
        tags: z.array(z.string()).max(MAX_TAGS).optional(),
        author: z.string().optional().describe("An agent name (case-insensitive)."),
        limit: z.number().int().min(1).max(MAX_RECALL_LIMIT).optional(),
        offset: z.number().int().min(0).optional().describe("Skip this many newer matches, to page back through older ones."),
      },
    },
    tool(({ query, tags, author, limit, offset }: { query?: string; tags?: string[]; author?: string; limit?: number; offset?: number }) => {
      session.require();
      return recall(db, query, tags, author, limit, offset);
    }),
  );

  server.registerTool(
    "forget",
    {
      description: "Delete a memory by id. Any registered agent can delete any memory. Errors if the id does not exist. Requires register first.",
      inputSchema: { id: z.number().int() },
    },
    tool(({ id }: { id: number }) => {
      session.require();
      return forget(db, id);
    }),
  );

  return server;
}
