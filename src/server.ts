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
import {
  DEFAULT_INBOX_LIMIT,
  MAX_BODY_LENGTH,
  MAX_INBOX_LIMIT,
  MAX_SEARCH_LENGTH,
  readInbox,
  search,
  sendMessage,
} from "./messages.js";
import {
  DEFAULT_CHANNEL_LIMIT,
  MAX_CHANNEL_LIMIT,
  joinChannel,
  leaveChannel,
  listChannels,
  post,
  readChannel,
  type Member,
} from "./channels.js";

/**
 * Who this server process is acting as. Over HTTP, `serve` also records a registered session's registration in the
 * database under a hash of its session id, so that a restarted server can restore it; over stdio it lives only in
 * memory. Every use is checked against the registration it was made for: once that is removed the session is
 * unregistered again.
 * A session belongs to one account for its whole life, and every tool reads and writes only that account's agents
 * and messages: the owner's for stdio, the account of the token that started it over HTTP.
 */
export class Session {
  private identity: Identity | undefined;
  private db: Db | undefined;

  /**
   * No default, so a caller has to say which account a session acts as. `onBind` is told each registration the
   * session is bound to.
   */
  constructor(
    readonly account: AccountId,
    private readonly onBind?: (identity: Identity) => void,
  ) {}

  /** The database the identity is checked against. `createServer` calls this. */
  attach(db: Db): void {
    this.db = db;
  }

  bind(identity: Identity): void {
    this.identity = identity;
    this.onBind?.(identity);
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

  /** For tools that need the caller's row as well as its name: channel read positions belong to the registration. */
  requireAgent(): Member {
    const name = this.require();
    return { ...this.identity!, name };
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
    { name: "message-cp", version: "0.1.0" },
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
        "Register this session as an agent with a name and short bio. A new name without a key you pass returns a generated key, once: keep it (if you pass your own key, nothing is returned). If the name exists (any case), this session takes that agent over and its bio is updated, but only with the agent's key; an agent registered before keys existed is claimed by the first call and gets a key. When the server can offer one, it returns waitCommand: run it in the background to be woken by unread messages, by unread posts in the channels you have joined and by unread @mentions of you; when it fires, call read_inbox if it names messages or mentions and read_channel for each channel it names posts in, and only then start it again.",
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
        "Remove an agent from the directory and free its name. The messages addressed to it are kept in the database, until a full token deletes their conversation over HTTP, but no tool shows them again, not even to a new agent that registers the same name; keptMessages says how many. With no arguments it removes you, and this session is unregistered until it calls `register` again. With name and key it removes that agent, only if the key matches (an agent that has no key can be removed by name alone); name and key work even from a session that has not registered. Any other session still acting as the removed agent is unregistered too. A process started with MESSAGE_CP_AGENT registers that agent again when it starts.",
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
      description: `List registered agents, and the people the operator added, by name with their bio, lastSeen (for an agent, when it was last active; for a person, when they were added) and person (true for a person). Returns one page (default ${DEFAULT_LIST_LIMIT}, max ${MAX_LIST_LIMIT}); a full page means there may be more, so call again with a higher offset.`,
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
      description: "Get one registered agent, or person, by name (case-insensitive).",
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
      description: `Send a message to one registered agent or person by name, or to every other registered agent and person with to: 'all'. A broadcast only reaches agents registered, and people added, when it is sent. Requires register first.`,
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
      description: `Read your messages and your mentions (channel posts that name you as @<your-name>), oldest first, one page at a time (default ${DEFAULT_INBOX_LIMIT}, max ${MAX_INBOX_LIMIT}). A message has from, sentAt, body and broadcast; a mention has channel, id (the post's), from, sentAt and body. By default only unread ones; everything returned is marked read, so a full page means there may be more: call again. With unread_only false, use offset to page through history. To be woken when mail arrives instead of polling, run the wait command that register returns in the background, and start it again after reading what it names. Requires register first.`,
      inputSchema: {
        unread_only: z.boolean().optional().describe("Default true."),
        limit: z.number().int().min(1).max(MAX_INBOX_LIMIT).optional(),
        offset: z.number().int().min(0).optional(),
      },
    },
    tool(({ unread_only, limit, offset }: { unread_only?: boolean; limit?: number; offset?: number }) =>
      readInbox(db, account, session.requireAgent(), unread_only, limit, offset),
    ),
  );

  server.registerTool(
    "search",
    {
      description: `Search the messages you have received and your account's channel posts for text, newest first, one page at a time (default ${DEFAULT_INBOX_LIMIT}, max ${MAX_INBOX_LIMIT}); a full page means there may be more, so call again with a higher offset. A message has kind "message", from, sentAt, body and broadcast; a post has kind "post", channel, id (the post's), from, sentAt and body. Marks nothing read and does not move your read position in any channel. Requires register first.`,
      inputSchema: {
        text: z.string().describe(`1-${MAX_SEARCH_LENGTH} characters, found anywhere in the body; ASCII letters match in any case, and % and _ are literal.`),
        channel: z.string().optional().describe("Only this channel's posts, and no messages."),
        from: z.string().optional().describe("Only what the agent with this name sent, in any case."),
        since: z.string().optional().describe("A date (2026-10-20) or date and time (2026-10-20T12:00:00Z, seconds, milliseconds and offset optional; UTC when it has no offset): sent at or after it."),
        until: z.string().optional().describe("A date or date and time, as since: sent before it."),
        limit: z.number().int().min(1).max(MAX_INBOX_LIMIT).optional(),
        offset: z.number().int().min(0).optional(),
      },
    },
    tool(
      ({ text, channel, from, since, until, limit, offset }: {
        text: string;
        channel?: string;
        from?: string;
        since?: string;
        until?: string;
        limit?: number;
        offset?: number;
      }) => search(db, account, session.requireAgent(), text, { channel, from, since, until }, limit, offset),
    ),
  );

  server.registerTool(
    "post",
    {
      description: `Post to one of your account's channels by name; the channel is created by its first post (or by join_channel). Posting does not join the channel. Every agent in the account can read it, including agents that register later. Naming an agent of your account as @<name> gives it a mention, which wakes it and appears in its read_inbox, whether or not it has joined the channel. Posts are never edited or deleted. Requires register first.`,
      inputSchema: {
        channel: z.string().describe("1-32 characters: letters, digits, '-' and '_', compared case-insensitively."),
        body: z.string().describe(`The post, at most ${MAX_BODY_LENGTH} characters.`),
      },
    },
    tool(({ channel, body }: { channel: string; body: string }) => post(db, account, session.requireAgent(), channel, body)),
  );

  server.registerTool(
    "read_channel",
    {
      description: `Read a channel, oldest first, one page at a time (default ${DEFAULT_CHANNEL_LIMIT}, max ${MAX_CHANNEL_LIMIT}). By default the posts after your read position in it (from its first post if you have never read it; your own posts are included, though never counted as unread), and your read position moves past what is returned, so a full page means call again. With unread_only false, use offset to page through the whole history without moving your read position. Requires register first.`,
      inputSchema: {
        channel: z.string().describe("The channel's name, in any case."),
        unread_only: z.boolean().optional().describe("Default true."),
        limit: z.number().int().min(1).max(MAX_CHANNEL_LIMIT).optional(),
        offset: z.number().int().min(0).optional().describe("Only with unread_only false; passing it otherwise is an error."),
      },
    },
    tool(
      ({ channel, unread_only, limit, offset }: { channel: string; unread_only?: boolean; limit?: number; offset?: number }) =>
        readChannel(db, account, session.requireAgent(), channel, unread_only, limit, offset),
    ),
  );

  server.registerTool(
    "list_channels",
    {
      description: `List your account's channels by name with their post count, last post time (null if nobody has posted yet), how many posts you have not read (your own posts never count) and whether you have joined it. Returns one page (default ${DEFAULT_CHANNEL_LIMIT}, max ${MAX_CHANNEL_LIMIT}); a full page means there may be more, so call again with a higher offset. Requires register first.`,
      inputSchema: {
        limit: z.number().int().min(1).max(MAX_CHANNEL_LIMIT).optional(),
        offset: z.number().int().min(0).optional(),
      },
    },
    tool(({ limit, offset }: { limit?: number; offset?: number }) => listChannels(db, account, session.requireAgent(), limit, offset)),
  );

  server.registerTool(
    "join_channel",
    {
      description: `Join one of your account's channels, so the wait command that register returns also wakes you for new posts there. A channel nobody has posted to yet is created. Joining a channel you have never read starts you at its latest post, so its history does not wake you (read_channel with unread_only false still pages through it); joining one you have read before keeps your read position. Requires register first.`,
      inputSchema: { channel: z.string().describe("1-32 characters: letters, digits, '-' and '_', compared case-insensitively.") },
    },
    tool(({ channel }: { channel: string }) => joinChannel(db, account, session.requireAgent(), channel)),
  );

  server.registerTool(
    "leave_channel",
    {
      description: `Leave one of your account's channels, so its posts no longer wake you. Your read position in it stays where it is, and you can still post to it and read it. Requires register first.`,
      inputSchema: { channel: z.string().describe("The channel's name, in any case.") },
    },
    tool(({ channel }: { channel: string }) => leaveChannel(db, account, session.requireAgent(), channel)),
  );

  return server;
}
