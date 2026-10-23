import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { RequestId, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  MAX_STATUS_LENGTH,
  NOT_REGISTERED,
  STATUS_TTL_MS,
  ToolError,
  getAgent,
  listAgents,
  nameOfIdentity,
  registerWithIdentity,
  removeAgent,
  setStatus,
  touchAgent,
  type Identity,
} from "./agents.js";
import { OWNER_ACCOUNT, type AccountId, type Db } from "./db.js";
import { DEFAULT_WAIT_HOLD_MS, formatUnread, httpWaitCommand, instructions, waitCommand } from "./wait.js";
import {
  DEFAULT_INBOX_LIMIT,
  MAX_BODY_LENGTH,
  MAX_INBOX_LIMIT,
  MAX_SEARCH_LENGTH,
  hasUnread,
  readConversation,
  readInbox,
  search,
  sendMessage,
  unreadSummary,
  type Unread,
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

  /** Binds the session to a registration that is already recorded, as a restore does, without telling `onBind`. */
  restore(identity: Identity): void {
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

/** Most held calls at once: sessions, waiting GET /wait requests and held `wait_for_mail` calls each have this cap. */
export const DEFAULT_MAX_SESSIONS = 256;
/** How long `wait_for_mail` holds a call with no mail by default, and at most, in seconds. */
export const DEFAULT_WAIT_FOR_MAIL_SECONDS = 50;
export const MAX_WAIT_FOR_MAIL_SECONDS = DEFAULT_WAIT_HOLD_MS / 1000;
export const WAIT_FOR_MAIL_FULL = "Too many calls are waiting for mail on this server. Try again shortly.";

// The held `wait_for_mail` calls of every server in this process that was not given a `hold`, as over stdio.
let held = 0;
const holdInProcess = (): (() => void) | undefined => {
  if (held >= DEFAULT_MAX_SESSIONS) return undefined;
  held++;
  return () => void held--;
};

export interface ServerOptions {
  remote?: boolean;
  publicUrl?: string;
  /**
   * Takes a slot for a held `wait_for_mail` call: returns the function that gives it back, or undefined when every slot
   * is taken. Without it, the calls of this process are counted together against DEFAULT_MAX_SESSIONS.
   */
  hold?: () => (() => void) | undefined;
  /** A signal that aborts once the response that would carry request `id` has closed, where the transport knows it. */
  closed?: (id: RequestId) => AbortSignal | undefined;
}

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** One check for mail; a lock held past the busy timeout counts as nothing unread this time, as in `message-cp wait`. */
function check(db: Db, account: AccountId, own: Identity): Unread | undefined {
  try {
    return unreadSummary(db, account, own);
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (typeof code !== "string" || !code.startsWith("SQLITE_BUSY")) throw err;
    return { count: 0, senders: [], posts: 0, channels: [], mentions: 0, mentionChannels: [] };
  }
}

/** Waits `ms`, or less if `signal` aborts first; the timer and listener are removed either way. */
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done);
  });

/** One server per session. */
export function createServer(db: Db, session = new Session(OWNER_ACCOUNT), options: ServerOptions = {}): McpServer {
  const remote = options.remote ?? false;
  const hold = options.hold ?? holdInProcess;
  session.attach(db);
  const account = session.account;
  const server = new McpServer(
    { name: "message-cp", version: "0.1.0" },
    { instructions: instructions(process.env, remote, options.publicUrl) },
  );

  // Wraps a tool: bumps last-seen for a registered session and turns ToolError into an error result.
  const tool = <A>(run: (args: A, extra: Extra) => unknown) => async (args: A, extra: Extra) => {
    // Touch first so a failing call still counts. `register` sets last-seen itself.
    const name = session.current();
    if (name) touchAgent(db, account, name);
    try {
      const result = await run(args, extra);
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
    "set_status",
    {
      description: `Set your own status line: a short note on what you are doing, such as "reading Linear", which the dashboard shows next to your name in its agents panel and in the header bar of an open direct conversation with you. It replaces any line you set before. It stops showing ${STATUS_TTL_MS / 60000} minutes after it was set, and is cleared when a send_message or post of yours succeeds and when you are unregistered or removed. Empty text, or only spaces, clears it now. Returns status (the line as stored, or null) and expiresAt (null with no line). Sends nothing and marks nothing read. Requires register first.`,
      inputSchema: {
        text: z.string().describe(`The line, at most ${MAX_STATUS_LENGTH} characters, or empty or only spaces to clear it. A newline, other control character or bidirectional formatting character is refused.`),
      },
    },
    tool(({ text }: { text: string }) => setStatus(db, account, session.requireAgent(), text)),
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
      description: `Send a message to one registered agent or person by name, or to every other registered agent and person with to: 'all'. A broadcast only reaches agents registered, and people added, when it is sent. With in_reply_to, each copy stored records the id of the message it answers, which read_inbox, read_conversation and search return as inReplyTo. Requires register first.`,
      inputSchema: {
        to: z.string().describe("An agent name, or 'all'."),
        body: z.string().describe(`The message, at most ${MAX_BODY_LENGTH} characters.`),
        in_reply_to: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("The id of a direct message sent to you, as read_inbox, read_conversation or search returns it, that this one answers. Any other id fails, and nothing is sent."),
      },
    },
    tool(({ to, body, in_reply_to }: { to: string; body: string; in_reply_to?: number }) => {
      const own = session.requireAgent();
      return sendMessage(db, account, own.name, to, body, own, in_reply_to);
    }),
  );

  server.registerTool(
    "read_inbox",
    {
      description: `Read your messages and your mentions (channel posts that name you as @<your-name>), oldest first, one page at a time (default ${DEFAULT_INBOX_LIMIT}, max ${MAX_INBOX_LIMIT}). A message has id (its own), inReplyTo (the id of the message it answers, or null), from, sentAt, body and broadcast; a mention has channel, id (the post's), from, sentAt and body. By default only unread ones; everything returned is marked read, so a full page means there may be more: call again. With unread_only false, use offset to page through history. To be woken when mail arrives instead of polling, run the wait command that register returns in the background, and start it again after reading what it names. Requires register first.`,
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
    "wait_for_mail",
    {
      description: `Wait until you have mail, for a client that cannot run the wait command in the background. Returns { unread } as soon as you have an unread message, an unread post by another agent in a channel you joined or an unread @mention of you, with unread the one line the wait command prints (how many, from whom and in which channels, never the bodies); returns at once if you already have any. Otherwise it checks about once a second, and returns { unread: null } after timeout_seconds without any; a check that finds the database busy counts as nothing unread that second. Reads and marks nothing, so call read_inbox if the line names messages or mentions and read_channel for each channel it names posts in, and only then wait again. Calls held at once are capped per server; past the cap it fails at once, so try again shortly. If your agent is removed while you wait, it fails as not registered. Requires register first.`,
      inputSchema: {
        timeout_seconds: z
          .number()
          .int()
          .min(1)
          .max(MAX_WAIT_FOR_MAIL_SECONDS)
          .optional()
          .describe(`How long to wait with no mail, in seconds: default ${DEFAULT_WAIT_FOR_MAIL_SECONDS}, at most ${MAX_WAIT_FOR_MAIL_SECONDS}.`),
      },
    },
    tool(async ({ timeout_seconds }: { timeout_seconds?: number }, extra) => {
      const own = session.requireAgent();
      const deadline = Date.now() + (timeout_seconds ?? DEFAULT_WAIT_FOR_MAIL_SECONDS) * 1000;
      // Each check finds the caller by its registration, so a removed agent, or another that took its name, ends the call.
      const answer = () => {
        const unread = check(db, account, own);
        if (!unread) throw new ToolError(NOT_REGISTERED);
        return hasUnread(unread) ? { unread: formatUnread(unread) } : undefined;
      };
      // Mail that is already there is answered at once, whatever the cap.
      const first = answer();
      if (first) return first;
      const release = hold();
      if (!release) throw new ToolError(WAIT_FOR_MAIL_FULL);
      try {
        const closed = options.closed?.(extra.requestId);
        const signal = closed ? AbortSignal.any([extra.signal, closed]) : extra.signal;
        for (;;) {
          const left = deadline - Date.now();
          if (left <= 0) return { unread: null };
          // Sleep a second, or until the call is cancelled or its client goes away; nobody is listening then.
          await sleep(Math.min(1000, left), signal);
          if (signal.aborted) return { unread: null };
          const unread = answer();
          if (unread) return unread;
        }
      } finally {
        release();
      }
    }),
  );

  server.registerTool(
    "read_conversation",
    {
      description: `Read your direct messages with one agent or person: those they sent you and those you sent them, newest first, one page at a time (default ${DEFAULT_INBOX_LIMIT}, max ${MAX_INBOX_LIMIT}); a full page means there may be more, so call again with a higher offset. Each has id (its own), inReplyTo (the id of the message it answers, or null), from, to, sentAt, body and broadcast; a broadcast either of you sent appears as the copy the other received, and a conversation with yourself has no broadcasts. Messages a removed agent with your name sent or received are not included; if the name once belonged to a removed agent, what it sent you is included, but what you sent it is not. Marks nothing read. Requires register first.`,
      inputSchema: {
        name: z.string().describe("The other agent or person, in any case."),
        limit: z.number().int().min(1).max(MAX_INBOX_LIMIT).optional(),
        offset: z.number().int().min(0).optional(),
      },
    },
    tool(({ name, limit, offset }: { name: string; limit?: number; offset?: number }) =>
      readConversation(db, account, session.requireAgent(), name, limit, offset),
    ),
  );

  server.registerTool(
    "search",
    {
      description: `Search the messages you have received and your account's channel posts for text, newest first, one page at a time (default ${DEFAULT_INBOX_LIMIT}, max ${MAX_INBOX_LIMIT}); a full page means there may be more, so call again with a higher offset. A message has kind "message", id (its own), inReplyTo (the id of the message it answers, or null), from, sentAt, body and broadcast; a post has kind "post", channel, id (the post's), from, sentAt and body. Marks nothing read and does not move your read position in any channel. Requires register first.`,
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
