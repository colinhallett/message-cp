import { ToolError, getAgent } from "./agents.js";
import type { AccountId, Db } from "./db.js";

export interface Message {
  from: string;
  sentAt: string;
  body: string;
  broadcast: boolean;
}

export interface SendResult {
  delivered: number;
  recipients: string[];
}

interface Row {
  id: number;
  sender: string;
  body: string;
  broadcast: number;
  created_at: number;
  read_at: number | null;
}

export const MAX_BODY_LENGTH = 4000;
export const DEFAULT_INBOX_LIMIT = 50;
export const MAX_INBOX_LIMIT = 200;

function countCodePoints(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** Throws unless `body` is a valid message: not empty or only whitespace, at most MAX_BODY_LENGTH characters. */
export function validateBody(body: string, kind = "Message"): void {
  if (body.trim().length === 0) throw new ToolError(`${kind} body is empty.`);
  // Count characters (code points), not UTF-16 code units, to match what the tool advertises.
  // A code point is at most 2 code units, so anything over twice the limit is too long without iterating.
  if (body.length > 2 * MAX_BODY_LENGTH || countCodePoints(body) > MAX_BODY_LENGTH) {
    throw new ToolError(`${kind} is too long: at most ${MAX_BODY_LENGTH} characters.`);
  }
}

/**
 * Stores one delivery per recipient: the named agent, or for `all` every agent of the account registered right now
 * except the sender. Read state therefore belongs to each recipient. A message belongs to its recipient's account,
 * which is always the sender's.
 */
export function sendMessage(db: Db, account: AccountId, from: string, to: string, body: string): SendResult {
  validateBody(body);
  const broadcast = to.toLowerCase() === "all";
  // IMMEDIATE takes the write lock up front, so the recipient list cannot change under us.
  return db
    .transaction((): SendResult => {
      let recipients: { id: number; name: string }[];
      if (broadcast) {
        recipients = db
          .prepare("SELECT id, name FROM agents WHERE account_id = ? AND name <> ? AND removed_at IS NULL ORDER BY name")
          .all(account, from) as typeof recipients;
      } else {
        const agent = getAgent(db, account, to);
        if (!agent) throw new ToolError(`No agent named '${to}'.`);
        recipients = db
          .prepare("SELECT id, name FROM agents WHERE account_id = ? AND name = ? AND removed_at IS NULL")
          .all(account, agent.name) as typeof recipients;
      }
      const insert = db.prepare(
        "INSERT INTO messages (recipient_id, sender, body, broadcast, created_at) VALUES (?, ?, ?, ?, ?)",
      );
      const now = Date.now();
      for (const r of recipients) insert.run(r.id, from, body, broadcast ? 1 : 0, now);
      return { delivered: recipients.length, recipients: recipients.map((r) => r.name) };
    })
    .immediate();
}

/**
 * One page of the caller's messages, oldest first. Everything returned is marked read. Unread
 * messages beyond the page stay unread for the next call; with `unreadOnly` false, use `offset`.
 */
export function readInbox(
  db: Db,
  account: AccountId,
  name: string,
  unreadOnly = true,
  limit = DEFAULT_INBOX_LIMIT,
  offset = 0,
): Message[] {
  return db
    .transaction((): Message[] => {
      const rows = db
        .prepare(
          `SELECT m.id, m.sender, m.body, m.broadcast, m.created_at, m.read_at
           FROM messages m JOIN agents a ON a.id = m.recipient_id
           WHERE a.account_id = ? AND a.name = ? AND a.removed_at IS NULL ${unreadOnly ? "AND m.read_at IS NULL" : ""}
           ORDER BY m.id LIMIT ? OFFSET ?`,
        )
        .all(account, name, Math.min(limit, MAX_INBOX_LIMIT), offset) as Row[];
      const mark = db.prepare("UPDATE messages SET read_at = ? WHERE id = ? AND read_at IS NULL");
      const now = Date.now();
      for (const r of rows) mark.run(now, r.id);
      return rows.map((r) => ({
        from: r.sender,
        sentAt: new Date(r.created_at).toISOString(),
        body: r.body,
        broadcast: r.broadcast === 1,
      }));
    })
    .immediate();
}

export interface Unread {
  /** Unread messages, and who sent them. */
  count: number;
  senders: string[];
  /** Unread posts in the channels the agent has joined, and which channels they are in. */
  posts: number;
  channels: string[];
}

/** Whether `unread` is anything to wake for: an unread message or an unread post in a joined channel. */
export const hasUnread = (unread: Unread) => unread.count > 0 || unread.posts > 0;

/**
 * How many unread messages `name` has and who sent them, and how many unread posts are in the channels it has joined
 * and where, without reading or marking anything. Undefined if there is no such agent.
 */
export function unreadSummary(db: Db, account: AccountId, name: string): Unread | undefined {
  // One read transaction, so the messages and the posts are counted at the same moment.
  return db.transaction((): Unread | undefined => {
    const agent = getAgent(db, account, name);
    if (!agent) return undefined;
    // One query each, so a count and its names always describe the same rows.
    const messages = db
      .prepare(
        `SELECT m.sender, COUNT(*) AS n FROM messages m JOIN agents a ON a.id = m.recipient_id
         WHERE a.account_id = ? AND a.name = ? AND a.removed_at IS NULL AND m.read_at IS NULL GROUP BY m.sender ORDER BY MIN(m.id)`,
      )
      .all(account, agent.name) as { sender: string; n: number }[];
    // The agent's own posts never count as unread, as in list_channels.
    const posts = db
      .prepare(
        `SELECT c.name, COUNT(*) AS n FROM agents a
         JOIN channel_reads r ON r.agent_id = a.id AND r.joined = 1
         JOIN channels c ON c.id = r.channel_id AND c.account_id = a.account_id
         JOIN channel_posts p ON p.channel_id = c.id AND p.id > r.last_read_id AND p.sender_id <> a.id
         WHERE a.account_id = ? AND a.name = ? AND a.removed_at IS NULL GROUP BY c.id ORDER BY MIN(p.id)`,
      )
      .all(account, agent.name) as { name: string; n: number }[];
    return {
      count: messages.reduce((sum, r) => sum + r.n, 0),
      senders: messages.map((r) => r.sender),
      posts: posts.reduce((sum, r) => sum + r.n, 0),
      channels: posts.map((r) => r.name),
    };
  })();
}

export interface AgentUnread {
  name: string;
  bio: string;
  lastSeen: string;
  unreadMessages: number;
  unreadPosts: number;
}

/**
 * One page of the account's live agents in name order, as `list_agents` pages them, each with its unread message and
 * post totals counted as `unreadSummary` counts them. One query for the page, totals only: no senders or channels.
 */
export function listAgentsUnread(db: Db, account: AccountId, limit: number, offset: number): AgentUnread[] {
  const rows = db
    .prepare(
      `SELECT a.name, a.bio, a.last_seen,
         (SELECT COUNT(*) FROM messages m WHERE m.recipient_id = a.id AND m.read_at IS NULL) AS messages,
         (SELECT COUNT(*) FROM channel_reads r
            JOIN channels c ON c.id = r.channel_id AND c.account_id = a.account_id
            JOIN channel_posts p ON p.channel_id = c.id AND p.id > r.last_read_id AND p.sender_id <> a.id
          WHERE r.agent_id = a.id AND r.joined = 1) AS posts
       FROM agents a WHERE a.account_id = ? AND a.removed_at IS NULL ORDER BY a.name LIMIT ? OFFSET ?`,
    )
    .all(account, limit, offset) as { name: string; bio: string; last_seen: number; messages: number; posts: number }[];
  return rows.map((r) => ({
    name: r.name,
    bio: r.bio,
    lastSeen: new Date(r.last_seen).toISOString(),
    unreadMessages: r.messages,
    unreadPosts: r.posts,
  }));
}

export interface AccountMessage {
  id: number;
  from: string;
  to: string;
  sentAt: string;
  body: string;
  broadcast: boolean;
  /** Whether the recipient has read it. */
  read: boolean;
}

/**
 * One page of the account's messages, oldest first, for the account rather than for one agent. A broadcast is one row
 * per recipient, so it appears once per recipient. A message to a removed agent shows the name it had. Reads only, so
 * nothing is marked read.
 */
export function listAccountMessages(db: Db, account: AccountId, limit: number, offset: number): AccountMessage[] {
  const rows = db
    .prepare(
      `SELECT m.id, m.sender, CASE WHEN a.removed_at IS NULL THEN a.name ELSE a.removed_name END AS recipient,
              m.body, m.broadcast, m.created_at, m.read_at
       FROM messages m JOIN agents a ON a.id = m.recipient_id
       WHERE a.account_id = ? ORDER BY m.id LIMIT ? OFFSET ?`,
    )
    .all(account, Math.min(limit, MAX_INBOX_LIMIT), offset) as (Row & { recipient: string })[];
  return rows.map((r) => ({
    id: r.id,
    from: r.sender,
    to: r.recipient,
    sentAt: new Date(r.created_at).toISOString(),
    body: r.body,
    broadcast: r.broadcast === 1,
    read: r.read_at !== null,
  }));
}
