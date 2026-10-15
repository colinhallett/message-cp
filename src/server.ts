import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  NOT_REGISTERED,
  ToolError,
  getAgent,
  identityOf,
  listAgents,
  nameOfIdentity,
  registerWithIdentity,
  removeAgent,
  touchAgent,
  type Identity,
} from "./agents.js";
import type { Db } from "./db.js";
import {
  DEFAULT_RECALL_LIMIT,
  MAX_QUERY_LENGTH,
  MAX_RECALL_LIMIT,
  MAX_TAGS,
  MAX_TEXT_LENGTH,
  forget,
  forgetMemories,
  getMemory,
  recall,
  remember,
} from "./memories.js";
import {
  DEFAULT_TASK_LIMIT,
  MAX_TASK_LIMIT,
  MAX_TASK_TEXT_LENGTH,
  MAX_TITLE_LENGTH,
  claimTask,
  completeTask,
  getTask,
  listTasks,
  postTask,
  releaseTask,
  type TaskStatus,
} from "./tasks.js";
import { instructions, waitCommand } from "./wait.js";
import { DEFAULT_INBOX_LIMIT, MAX_BODY_LENGTH, MAX_INBOX_LIMIT, readInbox, sendMessage } from "./messages.js";

/**
 * Who this server process is acting as. Lives only in memory, never in the database, but every use is checked
 * against the registration it was made for: once that is removed the session is unregistered again.
 */
export class Session {
  private identity: Identity | undefined;
  private db: Db | undefined;

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
    const name = nameOfIdentity(this.db, this.identity);
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
export function createServer(db: Db, session = new Session()): McpServer {
  session.attach(db);
  const server = new McpServer({ name: "memory-cp", version: "0.1.0" }, { instructions: instructions() });

  // Wraps a tool: bumps last-seen for a registered session and turns ToolError into an error result.
  const tool = <A>(run: (args: A) => unknown) => async (args: A) => {
    // Touch first so a failing call still counts. `register` sets last-seen itself.
    const name = session.current();
    if (name) touchAgent(db, name);
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
      const { result, identity } = registerWithIdentity(db, name, bio, key);
      session.bind(identity);
      return { ...result, waitCommand: waitCommand(result.name) };
    }),
  );

  server.registerTool(
    "unregister",
    {
      description:
        "Remove an agent's registration and the messages addressed to it; tasks it claimed go back to open, its memories and posted tasks stay. With no arguments it removes you, and this session is unregistered until it calls `register` again. With name and key it removes that agent, only if the key matches (an agent that has no key can be removed by name alone); name and key work even from a session that has not registered. Any other session still acting as the removed agent is unregistered too. A process started with MEMORY_CP_AGENT registers that agent again when it starts.",
      inputSchema: {
        name: z.string().optional().describe("The agent to remove. Omit to remove yourself."),
        key: z.string().optional().describe("That agent's key, required if it has one."),
      },
    },
    tool(({ name, key }: { name?: string; key?: string }) => {
      if (name === undefined) {
        if (key !== undefined) throw new ToolError("Pass the name of the agent the key belongs to.");
        const self = session.require();
        return removeAgent(db, self, undefined, session.registration);
      }
      // A name with its key carries its own proof; anything else needs to know who is asking.
      if (key === undefined) session.require();
      return removeAgent(db, name, key);
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
      description: `Read your messages, oldest first, one page at a time (default ${DEFAULT_INBOX_LIMIT}, max ${MAX_INBOX_LIMIT}). By default only unread ones; everything returned is marked read, so a full page means there may be more: call again. With unread_only false, use offset to page through history. To be woken when mail arrives instead of polling, run the wait command that register returns in the background, and start it again after each read. Requires register first.`,
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
    "get_memory",
    {
      description: "Fetch one memory by id, in the same shape recall returns, for example an id from a recall result or a message. Errors if the id does not exist. Requires register first.",
      inputSchema: { id: z.number().int() },
    },
    tool(({ id }: { id: number }) => {
      session.require();
      return getMemory(db, id);
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

  server.registerTool(
    "forget_memories",
    {
      description: `Delete every memory that recall would find with the same tags, author and query, with no paging limit. Needs at least one of them (a blank query or empty tags do not count). By default it only previews: dry_run defaults to true and returns how many match and up to 100 of their ids, deleting nothing. Pass dry_run false to delete them all and get the count. Any registered agent can delete any memory. Requires register first.`,
      inputSchema: {
        tags: z.array(z.string()).max(MAX_TAGS).optional(),
        author: z.string().optional().describe("An agent name (case-insensitive)."),
        query: z.string().max(MAX_QUERY_LENGTH).optional(),
        dry_run: z.boolean().optional().describe("Default true."),
      },
    },
    tool(({ tags, author, query, dry_run }: { tags?: string[]; author?: string; query?: string; dry_run?: boolean }) => {
      session.require();
      return forgetMemories(db, tags, author, query, dry_run);
    }),
  );

  server.registerTool(
    "post_task",
    {
      description: `Post a task on the shared board for any agent to claim. It starts open and you are recorded as the poster. Requires register first.`,
      inputSchema: {
        title: z.string().describe(`At most ${MAX_TITLE_LENGTH} characters.`),
        details: z.string().describe(`What needs doing, at most ${MAX_TASK_TEXT_LENGTH} characters.`),
        tags: z.array(z.string()).max(MAX_TAGS).optional().describe("Short labels to find it by."),
      },
    },
    tool(({ title, details, tags }: { title: string; details: string; tags?: string[] }) =>
      postTask(db, session.require(), title, details, tags),
    ),
  );

  server.registerTool(
    "list_tasks",
    {
      description: `List tasks, oldest first, one page at a time (default ${DEFAULT_TASK_LIMIT}, max ${MAX_TASK_LIMIT}; a full page means there may be more, so call again with a higher offset). status keeps tasks in that state; tags keeps tasks that carry all the given tags; assignee keeps one agent's claimed or done tasks. Filters combine. Requires register first.`,
      inputSchema: {
        status: z.enum(["open", "claimed", "done"]).optional(),
        tags: z.array(z.string()).max(MAX_TAGS).optional(),
        assignee: z.string().optional().describe("An agent name (case-insensitive)."),
        limit: z.number().int().min(1).max(MAX_TASK_LIMIT).optional(),
        offset: z.number().int().min(0).optional(),
      },
    },
    tool(({ status, tags, assignee, limit, offset }: { status?: TaskStatus; tags?: string[]; assignee?: string; limit?: number; offset?: number }) => {
      session.require();
      return listTasks(db, status, tags, assignee, limit, offset);
    }),
  );

  server.registerTool(
    "get_task",
    {
      description: "Fetch one task by id, including its result once done. Requires register first.",
      inputSchema: { id: z.number().int() },
    },
    tool(({ id }: { id: number }) => {
      session.require();
      return getTask(db, id);
    }),
  );

  server.registerTool(
    "claim_task",
    {
      description: "Claim an open task so nobody else works on it. When several agents claim at once exactly one succeeds; the others get an error naming the holder. Requires register first.",
      inputSchema: { id: z.number().int() },
    },
    tool(({ id }: { id: number }) => claimTask(db, session.require(), id)),
  );

  server.registerTool(
    "release_task",
    {
      description: "Give a task you claimed back to the board, open again. Only the claimer can. Requires register first.",
      inputSchema: { id: z.number().int() },
    },
    tool(({ id }: { id: number }) => releaseTask(db, session.require(), id)),
  );

  server.registerTool(
    "complete_task",
    {
      description: `Mark a task you claimed as done with a result (at most ${MAX_TASK_TEXT_LENGTH} characters). The poster gets the result as a message from you, unless you are the poster. Only the claimer can. Requires register first.`,
      inputSchema: { id: z.number().int(), result: z.string() },
    },
    tool(({ id, result }: { id: number; result: string }) => completeTask(db, session.require(), id, result)),
  );

  return server;
}
