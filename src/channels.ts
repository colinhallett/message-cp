import { NAME_PATTERN, ToolError } from "./agents.js";
import type { AccountId, Db } from "./db.js";
import { DEFAULT_INBOX_LIMIT, MAX_INBOX_LIMIT, validateBody } from "./messages.js";

// Every function here takes the caller's account and reads or writes only that account's channels: a channel of the
// same name in another account is invisible and unrelated. The caller is an agent's row id, never its name, so a read
// position belongs to one registration: a later agent that registers the same name starts afresh.

export interface Post {
  id: number;
  from: string;
  sentAt: string;
  body: string;
}

export interface PostResult {
  channel: string;
  id: number;
  sentAt: string;
}

export interface ChannelPage {
  channel: string;
  posts: Post[];
}

export interface ChannelSummary {
  name: string;
  posts: number;
  lastPostAt: string;
  unread: number;
}

/** The agent a channel tool acts for: its current name and the id of its row in `agents`. */
export interface Poster {
  id: number;
  name: string;
}

export const DEFAULT_CHANNEL_LIMIT = DEFAULT_INBOX_LIMIT;
export const MAX_CHANNEL_LIMIT = MAX_INBOX_LIMIT;

interface PostRow {
  id: number;
  sender: string;
  body: string;
  created_at: number;
}

const toPost = (r: PostRow): Post => ({ id: r.id, from: r.sender, sentAt: new Date(r.created_at).toISOString(), body: r.body });

// The agent-name pattern; unlike agent names, `all` is an ordinary channel name.
function validateChannelName(name: string): void {
  if (!NAME_PATTERN.test(name)) {
    throw new ToolError("Invalid channel name: use 1-32 characters from letters, digits, '-' and '_'.");
  }
}

function findChannel(db: Db, account: AccountId, name: string): { id: number; name: string } {
  validateChannelName(name);
  const row = db.prepare("SELECT id, name FROM channels WHERE account_id = ? AND name = ?").get(account, name) as
    | { id: number; name: string }
    | undefined;
  if (!row) throw new ToolError(`No channel named '${name}'.`);
  return row;
}

/** Moves `agent`'s read position in `channel` forward to `postId`; never back. */
function advance(db: Db, agent: number, channel: number, postId: number): void {
  db.prepare(
    `INSERT INTO channel_reads (agent_id, channel_id, last_read_id) VALUES (?, ?, ?)
     ON CONFLICT(agent_id, channel_id) DO UPDATE SET last_read_id = MAX(last_read_id, excluded.last_read_id)`,
  ).run(agent, channel, postId);
}

/**
 * Appends a post to the account's channel `channel`, creating the channel if this is its first post. If the poster had
 * read everything before it, its read position moves past its own post, so the channel stays read for it.
 */
export function post(db: Db, account: AccountId, poster: Poster, channel: string, body: string): PostResult {
  validateChannelName(channel);
  validateBody(body, "Post");
  return db
    .transaction((): PostResult => {
      const now = Date.now();
      db.prepare("INSERT INTO channels (account_id, name, created_at) VALUES (?, ?, ?) ON CONFLICT(account_id, name) DO NOTHING").run(
        account,
        channel,
        now,
      );
      const ch = findChannel(db, account, channel);
      const last = (db.prepare("SELECT MAX(id) AS id FROM channel_posts WHERE channel_id = ?").get(ch.id) as { id: number | null }).id;
      const read = (
        db.prepare("SELECT last_read_id FROM channel_reads WHERE agent_id = ? AND channel_id = ?").get(poster.id, ch.id) as
          | { last_read_id: number }
          | undefined
      )?.last_read_id;
      const id = Number(
        db
          .prepare("INSERT INTO channel_posts (channel_id, sender_id, sender, body, created_at) VALUES (?, ?, ?, ?, ?)")
          .run(ch.id, poster.id, poster.name, body, now).lastInsertRowid,
      );
      if (last === null || (read !== undefined && read >= last)) advance(db, poster.id, ch.id, id);
      return { channel: ch.name, id, sentAt: new Date(now).toISOString() };
    })
    .immediate();
}

/**
 * One page of `channel`, oldest first. By default the posts after the reader's read position, which then moves past
 * the last one returned; an agent that has never read the channel starts at its first post. With `unreadOnly` false,
 * the whole history paged by `offset`, leaving the read position where it was.
 */
export function readChannel(
  db: Db,
  account: AccountId,
  reader: Poster,
  channel: string,
  unreadOnly = true,
  limit = DEFAULT_CHANNEL_LIMIT,
  offset = 0,
): ChannelPage {
  if (unreadOnly && offset !== 0) throw new ToolError("offset pages through history: pass unread_only false with it.");
  return db
    .transaction((): ChannelPage => {
      const ch = findChannel(db, account, channel);
      const pageSize = Math.min(limit, MAX_CHANNEL_LIMIT);
      let rows: PostRow[];
      if (unreadOnly) {
        rows = db
          .prepare(
            `SELECT p.id, p.sender, p.body, p.created_at FROM channel_posts p
             LEFT JOIN channel_reads r ON r.channel_id = p.channel_id AND r.agent_id = ?
             WHERE p.channel_id = ? AND p.id > COALESCE(r.last_read_id, 0) ORDER BY p.id LIMIT ?`,
          )
          .all(reader.id, ch.id, pageSize) as PostRow[];
        if (rows.length > 0) advance(db, reader.id, ch.id, rows[rows.length - 1].id);
      } else {
        rows = db
          .prepare("SELECT id, sender, body, created_at FROM channel_posts WHERE channel_id = ? ORDER BY id LIMIT ? OFFSET ?")
          .all(ch.id, pageSize, offset) as PostRow[];
      }
      return { channel: ch.name, posts: rows.map(toPost) };
    })
    .immediate();
}

/**
 * One page of the account's channels by name, each with its post count, last post time and how many posts `reader`
 * has not read. The reader's own posts never count as unread.
 */
export function listChannels(
  db: Db,
  account: AccountId,
  reader: Poster,
  limit = DEFAULT_CHANNEL_LIMIT,
  offset = 0,
): ChannelSummary[] {
  const rows = db
    .prepare(
      `SELECT c.name, COUNT(*) AS posts, MAX(p.created_at) AS last_post_at,
              SUM(p.id > COALESCE(r.last_read_id, 0) AND p.sender_id <> ?) AS unread
       FROM channels c JOIN channel_posts p ON p.channel_id = c.id
       LEFT JOIN channel_reads r ON r.channel_id = c.id AND r.agent_id = ?
       WHERE c.account_id = ? GROUP BY c.id ORDER BY c.name LIMIT ? OFFSET ?`,
    )
    .all(reader.id, reader.id, account, Math.min(limit, MAX_CHANNEL_LIMIT), offset) as {
    name: string;
    posts: number;
    last_post_at: number;
    unread: number;
  }[];
  return rows.map((r) => ({ name: r.name, posts: r.posts, lastPostAt: new Date(r.last_post_at).toISOString(), unread: r.unread }));
}
