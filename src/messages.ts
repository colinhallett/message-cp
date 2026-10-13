import { ToolError, getAgent } from "./agents.js";
import type { Db } from "./db.js";

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
 * Stores one delivery per recipient: the named agent, or for `all` every agent registered right now
 * except the sender. Read state therefore belongs to each recipient.
 */
export function sendMessage(db: Db, from: string, to: string, body: string): SendResult {
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
          .prepare("SELECT id, name FROM agents WHERE name <> ? ORDER BY name")
          .all(from) as typeof recipients;
      } else {
        const agent = getAgent(db, to);
        if (!agent) throw new ToolError(`No agent named '${to}'.`);
        recipients = db.prepare("SELECT id, name FROM agents WHERE name = ?").all(agent.name) as typeof recipients;
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
           WHERE a.name = ? ${unreadOnly ? "AND m.read_at IS NULL" : ""}
           ORDER BY m.id LIMIT ? OFFSET ?`,
        )
        .all(name, Math.min(limit, MAX_INBOX_LIMIT), offset) as Row[];
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
