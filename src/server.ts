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
  markWaiting,
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
  messageStatus,
  readConversation,
  readInbox,
  search,
  sendMessage,
  sendQuestion,
  takeReply,
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

/** Most held calls at once: sessions, waiting GET /wait requests and held `wait_for_mail` and `ask` calls each have this cap. */
export const DEFAULT_MAX_SESSIONS = 256;
/** How long `wait_for_mail` holds a call with no mail by default, and at most, in seconds. */
export const DEFAULT_WAIT_FOR_MAIL_SECONDS = 50;
export const MAX_WAIT_FOR_MAIL_SECONDS = DEFAULT_WAIT_HOLD_MS / 1000;
export const WAIT_FOR_MAIL_FULL = "Too many calls are waiting for mail on this server. Try again shortly.";
export const ASK_FULL = "Too many calls are waiting on this server. Try again shortly; nothing was sent.";

// The held `wait_for_mail` and `ask` calls of every server in this process that was not given a `hold`, as over stdio.
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
   * Takes a slot for a held `wait_for_mail` or `ask` call: returns the function that gives it back, or undefined when every slot
   * is taken. Without it, the calls of this process are counted together against DEFAULT_MAX_SESSIONS.
   */
  hold?: () => (() => void) | undefined;
  /** Over HTTP, the agent the session's token is bound to, which its instructions name. */
  agent?: string;
  /** A signal that aborts once the response that would carry request `id` has closed, where the transport knows it. */
  closed?: (id: RequestId) => AbortSignal | undefined;
}

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** Runs one check; a lock held past the busy timeout counts as finding nothing this time, as in `message-cp wait`. */
function check<T>(run: () => T, nothing: T): T {
  try {
    return run();
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (typeof code !== "string" || !code.startsWith("SQLITE_BUSY")) throw err;
    return nothing;
  }
}

const NOTHING_UNREAD: Unread = { count: 0, senders: [], posts: 0, channels: [], mentions: 0, mentionChannels: [] };

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

/**
 * Runs `answer` about once a second until it returns something, which `poll` returns, or until `deadline` passes or
 * `signal` aborts, when it returns undefined. Whatever `answer` throws ends the poll.
 */
async function poll<T>(deadline: number, signal: AbortSignal, answer: () => T | undefined): Promise<T | undefined> {
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) return undefined;
    // Sleep a second, or until the call is cancelled or its client goes away; nobody is listening then.
    await sleep(Math.min(1000, left), signal);
    if (signal.aborted) return undefined;
    const found = answer();
    if (found !== undefined) return found;
  }
}

/** One server per session. */
export function createServer(db: Db, session = new Session(OWNER_ACCOUNT), options: ServerOptions = {}): McpServer {
  const remote = options.remote ?? false;
  const hold = options.hold ?? holdInProcess;
  session.attach(db);
  const account = session.account;
  const server = new McpServer(
    { name: "message-cp", version: "0.1.0" },
    { instructions: instructions(process.env, remote, options.publicUrl, options.agent) },
  );

  // Aborts when the call is cancelled or, where the transport knows it, the response that would carry its answer closes.
  const ended = (extra: Extra) => {
    const closed = options.closed?.(extra.requestId);
    return closed ? AbortSignal.any([extra.signal, closed]) : extra.signal;
  };

  // Over HTTP, a request whose token is bound to an agent carries that agent's name; such a token is that agent already.
  const refuseBound = (extra: Extra) => {
    const agent = extra.authInfo?.extra?.agent;
    if (typeof agent === "string") throw new ToolError(`This token is already agent '${agent}'; it cannot register or remove another name.`);
  };

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
        "Register this session as an agent with a name and short bio. A new name without a key you pass returns a generated key, once: keep it (if you pass your own key, nothing is returned). If the name exists (any case), this session takes that agent over and its bio is updated, but only with the agent's key; an agent registered before keys existed is claimed by the first call and gets a key. When the server can offer one, it returns waitCommand: run it in the background to be woken by unread messages, by unread posts in the channels you have joined and by unread @mentions of you; when it fires, call read_inbox if it names messages or mentions and read_channel for each channel it names posts in, and only then start it again. When it returns no waitCommand, or your client cannot run a background command, call wait_for_mail instead, and call it again whenever it returns unread null. A session whose token is bound to one agent is that agent already, and register fails there.",
      inputSchema: {
        name: z.string().describe("1-32 characters: letters, digits, '-' and '_'. 'all' is reserved."),
        bio: z.string().describe("A short description of who you are and what you work on."),
        key: z.string().optional().describe("The agent's key, required to take over an existing agent that has one."),
      },
    },
    tool(({ name, bio, key }: { name: string; bio: string; key?: string }, extra) => {
      refuseBound(extra);
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
        "Remove an agent from the directory and free its name. The messages addressed to it are kept in the database, until a full token deletes their conversation over HTTP, but no tool shows them again, not even to a new agent that registers the same name; keptMessages says how many. With no arguments it removes you, and this session is unregistered until it calls `register` again (with a token bound to one agent, that token stops working). With name and key it removes that agent, only if the key matches (an agent that has no key can be removed by name alone); name and key work even from a session that has not registered, but not with a token bound to one agent. Any other session still acting as the removed agent is unregistered too. A process started with MESSAGE_CP_AGENT registers that agent again when it starts.",
      inputSchema: {
        name: z.string().optional().describe("The agent to remove. Omit to remove yourself."),
        key: z.string().optional().describe("That agent's key, required if it has one."),
      },
    },
    tool(({ name, key }: { name?: string; key?: string }, extra) => {
      if (name !== undefined) refuseBound(extra);
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
      description: `Send a message to one registered agent or person by name, or to every other registered agent and person with to: 'all'. A broadcast only reaches agents registered, and people added, when it is sent. With in_reply_to, each copy stored records the id of the message it answers, which read_inbox, read_conversation and search return as inReplyTo. Returns delivered (how many copies were stored), recipients (their names) and messages: the id and recipient (to) of each copy stored, one per recipient of a broadcast, which message_status takes. Requires register first.`,
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
    "message_status",
    {
      description: `Say whether messages you sent have been read: takes the ids send_message returned (1 to ${MAX_INBOX_LIMIT}) and returns, for each id once, in the order given, id, to (the recipient, by the name it had if it has since been removed), read and readAt (when its recipient's read_inbox first returned it, or null; a message to a person stays unread, since a person has no read_inbox). Only messages sent under your name since you registered it, to an agent or person of your account, can be asked about; if any id is another (one you did not send, one a removed agent with your name sent, or one that does not exist), the whole call fails with one error that does not say which. Marks nothing read. Requires register first.`,
      inputSchema: {
        ids: z.array(z.number().int().positive()).min(1).max(MAX_INBOX_LIMIT).describe("Message ids, as send_message returns them in messages."),
      },
    },
    tool(({ ids }: { ids: number[] }) => messageStatus(db, account, session.requireAgent(), ids)),
  );

  server.registerTool(
    "read_inbox",
    {
      description: `Read your messages and your mentions (channel posts that name you as @<your-name>), oldest first, one page at a time (default ${DEFAULT_INBOX_LIMIT}, max ${MAX_INBOX_LIMIT}). A message has id (its own), inReplyTo (the id of the message it answers, or null), from, sentAt, body and broadcast; to answer a message, call send_message with in_reply_to set to its id, so that an ask waiting for the answer sees it. A mention has channel, id (the post's), from, sentAt and body. By default only unread ones; everything returned is marked read, so a full page means there may be more: call again. With unread_only false, use offset to page through history. To be woken when mail arrives instead of polling, run the wait command that register returns in the background; when it fires, call read_inbox if it names messages or mentions and read_channel for each channel it names posts in, and only then start it again. Requires register first.`,
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
      description: `Wait until you have mail, for a client that cannot run the wait command in the background. Returns { unread } as soon as you have an unread message, an unread post by another agent in a channel you joined or an unread @mention of you, with unread the one line the wait command prints (how many, from whom and in which channels, never the bodies); returns at once if you already have any. Otherwise it checks about once a second, and returns { unread: null } after timeout_seconds without any; a check that finds the database busy counts as nothing unread that second. Reads and marks nothing, so call read_inbox if the line names messages or mentions and read_channel for each channel it names posts in, and only then wait again. When it returns { unread: null }, call it again. Calls held at once are capped, over HTTP together with the server's GET /wait requests and over stdio for the whole process; past the cap it fails at once, so try again shortly. If your agent is removed while you wait, it fails as not registered. Requires register first.`,
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
      // Once the call holds a slot, a check that finds nothing marks the caller waiting, so a message or mention stored
      // until the mark ends holds its webhook; one that finds mail does not, so mail left unread is not held by it.
      let holding = false;
      const answer = () => {
        const unread = check(() => unreadSummary(db, account, own), NOTHING_UNREAD);
        if (!unread) throw new ToolError(NOT_REGISTERED);
        if (hasUnread(unread)) return { unread: formatUnread(unread) };
        if (holding) markWaiting(db, account, own);
        return undefined;
      };
      // Mail that is already there is answered at once, whatever the cap.
      const first = answer();
      if (first) return first;
      const release = hold();
      if (!release) throw new ToolError(WAIT_FOR_MAIL_FULL);
      holding = true;
      try {
        markWaiting(db, account, own);
        return (await poll(deadline, ended(extra), answer)) ?? { unread: null };
      } finally {
        release();
      }
    }),
  );

  server.registerTool(
    "ask",
    {
      description: `Ask one agent a question and wait for its answer in one call: sends body to the agent to, as send_message does, and holds the call until that agent answers it with send_message and in_reply_to set to the question's id. Returns id (the question's message id) and reply: the earliest such reply, shaped as read_inbox returns a message and marked read, or null if none came within timeout_seconds or the call was cancelled. With reply null, a later answer arrives as an ordinary message: find it with read_inbox or read_conversation by its inReplyTo, the question's id; message_status with the id says only whether the question was read. It checks about once a second; a check that finds the database busy counts as no reply that time. To answer a question someone asks you, call send_message with in_reply_to set to the question's id, so that their ask sees it. 'all' and a person are refused, and nothing is sent. Calls held at once are capped together with wait_for_mail, over HTTP also with the server's GET /wait requests and over stdio for the whole process; past the cap it fails at once and sends nothing, so try again shortly. If your agent is removed while you wait, it fails as not registered. Requires register first.`,
      inputSchema: {
        to: z.string().describe("The agent to ask, by name. Not 'all' or a person."),
        body: z.string().describe(`The question, at most ${MAX_BODY_LENGTH} characters.`),
        timeout_seconds: z
          .number()
          .int()
          .min(1)
          .max(MAX_WAIT_FOR_MAIL_SECONDS)
          .optional()
          .describe(`How long to wait for the reply, in seconds: default ${DEFAULT_WAIT_FOR_MAIL_SECONDS}, at most ${MAX_WAIT_FOR_MAIL_SECONDS}.`),
      },
    },
    tool(async ({ to, body, timeout_seconds }: { to: string; body: string; timeout_seconds?: number }, extra) => {
      const own = session.requireAgent();
      // The slot comes first: no reply can exist before the question is sent, so nothing is answered without one.
      const release = hold();
      if (!release) throw new ToolError(ASK_FULL);
      try {
        const [{ id, to: asked }] = sendQuestion(db, account, own, to, body).messages;
        // Counted from once the question is stored, so time spent waiting for the write lock to send it is not taken
        // from the time the other agent has to answer.
        const deadline = Date.now() + (timeout_seconds ?? DEFAULT_WAIT_FOR_MAIL_SECONDS) * 1000;
        // Each check finds the caller by its registration, so a removed agent, or another that took its name, ends the call.
        const answer = () => {
          const reply = check(() => takeReply(db, account, own, id, asked), null);
          if (reply === undefined) throw new ToolError(NOT_REGISTERED);
          // poll goes on while this returns undefined: no reply yet.
          return reply ?? undefined;
        };
        return { id, reply: (await poll(deadline, ended(extra), answer)) ?? null };
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
