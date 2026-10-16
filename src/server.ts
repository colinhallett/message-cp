import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  NOT_REGISTERED,
  ToolError,
  getAgent,
  listAgents,
  nameOfIdentity,
  registerWithIdentity,
  removeAgent,
  touchAgent,
  type Identity,
} from "./agents.js";
import { OWNER_ACCOUNT, type AccountId, type Db } from "./db.js";
import { httpWaitCommand, instructions, waitCommand } from "./wait.js";
import { DEFAULT_INBOX_LIMIT, MAX_BODY_LENGTH, MAX_INBOX_LIMIT, readInbox, sendMessage } from "./messages.js";

/**
 * Who this server process is acting as. Lives only in memory, never in the database, but every use is checked
 * against the registration it was made for: once that is removed the session is unregistered again.
 * A session belongs to one account for its whole life, and every tool reads and writes only that account's agents
 * and messages: the owner's for stdio, the account of the token that started it over HTTP.
 */
export class Session {
  private identity: Identity | undefined;
  private db: Db | undefined;

  /** No default, so a caller has to say which account a session acts as. */
  constructor(readonly account: AccountId) {}

  /** The database the identity is checked against. `createServer` calls this. */
  attach(db: Db): void {
    this.db = db;
  }

  bind(identity: Identity): void {
    this.identity = identity;
  }

  /** The registration this session belongs to, as last checked by `current`/`require`. */
  get registration(): Identity | undefined {
    return this.identity;
  }

  /** The agent's name, or undefined if unregistered or the registration was removed. */
  current(): string | undefined {
    if (!this.identity || !this.db) return undefined;
    const name = nameOfIdentity(this.db, this.account, this.identity);
    if (name === undefined) this.identity = undefined;
    return name;
  }

  /** For tools that need to know the caller. */
  require(): string {
    const name = this.current();
    if (!name) throw new ToolError(NOT_REGISTERED);
    return name;
  }
}

/** One server per session. */
export function createServer(db: Db, session = new Session(OWNER_ACCOUNT), options: { remote?: boolean; publicUrl?: string } = {}): McpServer {
  const remote = options.remote ?? false;
  session.attach(db);
  const account = session.account;
  const server = new McpServer(
    { name: "memory-cp", version: "0.1.0" },
    { instructions: instructions(process.env, remote, options.publicUrl) },
  );

  // Wraps a tool: bumps last-seen for a registered session and turns ToolError into an error result.
  const tool = <A>(run: (args: A) => unknown) => async (args: A) => {
    // Touch first so a failing call still counts. `register` sets last-seen itself.
    const name = session.current();
    if (name) touchAgent(db, account, name);
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
      const { result, identity } = registerWithIdentity(db, account, name, bio, key);
      session.bind(identity);
      if (!remote) return { ...result, waitCommand: waitCommand(result.name) };
      return options.publicUrl ? { ...result, waitCommand: httpWaitCommand(options.publicUrl, result.name) } : result;
    }),
  );

  server.registerTool(
    "unregister",
    {
      description:
        "Remove an agent from the directory and free its name. The messages addressed to it are kept in the database but no tool shows them again, not even to a new agent that registers the same name; keptMessages says how many. With no arguments it removes you, and this session is unregistered until it calls `register` again. With name and key it removes that agent, only if the key matches (an agent that has no key can be removed by name alone); name and key work even from a session that has not registered. Any other session still acting as the removed agent is unregistered too. A process started with MEMORY_CP_AGENT registers that agent again when it starts.",
      inputSchema: {
        name: z.string().optional().describe("The agent to remove. Omit to remove yourself."),
        key: z.string().optional().describe("That agent's key, required if it has one."),
      },
    },
    tool(({ name, key }: { name?: string; key?: string }) => {
      if (name === undefined) {
        if (key !== undefined) throw new ToolError("Pass the name of the agent the key belongs to.");
        const self = session.require();
        return removeAgent(db, account, self, undefined, session.registration);
      }
      // A name with its key carries its own proof; anything else needs to know who is asking.
      if (key === undefined) session.require();
      return removeAgent(db, account, name, key);
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
    tool(({ limit, offset }: { limit?: number; offset?: number }) => listAgents(db, account, limit, offset)),
  );

  server.registerTool(
    "get_agent",
    {
      description: "Get one registered agent by name (case-insensitive).",
      inputSchema: { name: z.string() },
    },
    tool(({ name }: { name: string }) => {
      const agent = getAgent(db, account, name);
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
    tool(({ to, body }: { to: string; body: string }) => sendMessage(db, account, session.require(), to, body)),
  );

  server.registerTool(
    "read_inbox",
    {
      description: `Read your messages, oldest first, one page at a time (default ${DEFAULT_INBOX_LIMIT}, max ${MAX_INBOX_LIMIT}). By default only unread ones; everything returned is marked read, so a full page means there may be more: call again. With unread_only false, use offset to page through history. To be woken when mail arrives instead of polling, run the wait command that register returns in the background, and start it again after each read. Requires register first.`,
      inputSchema: {
        unread_only: z.boolean().optional().describe("Default true."),
        limit: z.number().int().min(1).max(MAX_INBOX_LIMIT).optional(),
        offset: z.number().int().min(0).optional(),
      },
    },
    tool(({ unread_only, limit, offset }: { unread_only?: boolean; limit?: number; offset?: number }) =>
      readInbox(db, account, session.require(), unread_only, limit, offset),
    ),
  );

  return server;
}
