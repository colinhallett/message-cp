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

/**
 * Stores one delivery per recipient: the named agent, or for `all` every agent of the account registered right now
 * except the sender. Read state therefore belongs to each recipient. A message belongs to its recipient's account,
 * which is always the sender's.
 */
export function sendMessage(db: Db, account: AccountId, from: string, to: string, body: string): SendResult {
  if (body.trim().length === 0) throw new ToolError("Message body is empty.");
  // Count characters (code points), not UTF-16 code units, to match what the tool advertises.
  // A code point is at most 2 code units, so anything over twice the limit is too long without iterating.
  if (body.length > 2 * MAX_BODY_LENGTH || countCodePoints(body) > MAX_BODY_LENGTH) {
    throw new ToolError(`Message is too long: at most ${MAX_BODY_LENGTH} characters.`);
  }
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
  count: number;
  senders: string[];
}

/** How many unread messages `name` has and who sent them, without reading or marking anything. Undefined if there is no such agent. */
export function unreadSummary(db: Db, account: AccountId, name: string): Unread | undefined {
  const agent = getAgent(db, account, name);
  if (!agent) return undefined;
  // One query, so the count and the senders always describe the same messages.
  const rows = db
    .prepare(
      `SELECT m.sender, COUNT(*) AS n FROM messages m JOIN agents a ON a.id = m.recipient_id
       WHERE a.account_id = ? AND a.name = ? AND a.removed_at IS NULL AND m.read_at IS NULL GROUP BY m.sender ORDER BY MIN(m.id)`,
    )
    .all(account, agent.name) as { sender: string; n: number }[];
  return { count: rows.reduce((sum, r) => sum + r.n, 0), senders: rows.map((r) => r.sender) };
}
