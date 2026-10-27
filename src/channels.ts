import { NAME_PATTERN, NOT_REGISTERED, ToolError, actingPerson, nameOfIdentity, type Identity } from "./agents.js";
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

/** A post as `readAccountChannel` gives it: with whether each agent of the account it mentions has read the mention. */
export interface AccountPost extends Post {
  /** In name order. A mentioned person is left out; a removed agent shows the name it had. */
  mentions: { name: string; read: boolean }[];
}

export interface AccountChannelPage {
  channel: string;
  posts: AccountPost[];
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
  /** Null for a channel that was joined before anyone posted to it. */
  lastPostAt: string | null;
  unread: number;
  /** Whether the reader has joined the channel, so that its unread posts wake the reader. */
  joined: boolean;
}

export interface Membership {
  channel: string;
  joined: boolean;
}

/** The agent a channel tool acts for: its registration (`id` is its row in `agents`) and its current name. */
export interface Member extends Identity {
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

const toPost = (r: PostRow): Post => ({
  id: r.id,
  from: r.sender,
  sentAt: new Date(r.created_at).toISOString(),
  body: r.body,
});

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

/**
 * Throws unless `member`'s registration is still live. Called inside each tool's transaction, so an agent removed by
 * another process after the session last checked can neither post nor read.
 */
function checkLive(db: Db, account: AccountId, member: Member): void {
  if (nameOfIdentity(db, account, member) === undefined) throw new ToolError(NOT_REGISTERED);
}

/** Moves `agent`'s read position in `channel` forward to `postId`; never back. */
function advance(db: Db, agent: number, channel: number, postId: number): void {
  db.prepare(
    `INSERT INTO channel_reads (agent_id, channel_id, last_read_id) VALUES (?, ?, ?)
     ON CONFLICT(agent_id, channel_id) DO UPDATE SET last_read_id = MAX(last_read_id, excluded.last_read_id)`,
  ).run(agent, channel, postId);
}

/** Creates the account's channel `channel` if it does not exist yet, and returns it. */
function ensureChannel(db: Db, account: AccountId, channel: string, now: number): { id: number; name: string } {
  db.prepare("INSERT INTO channels (account_id, name, created_at) VALUES (?, ?, ?) ON CONFLICT(account_id, name) DO NOTHING")
    .run(account, channel, now);
  return findChannel(db, account, channel);
}

// `@` and a name, not inside a longer word (`a@bob`) and not cut from a longer name.
const MENTION = /(?<![A-Za-z0-9_-])@([A-Za-z0-9_-]{1,32})(?![A-Za-z0-9_-])/g;

/** The distinct names `body` mentions as `@<name>`, lower-cased since names compare without case, `all` left out. */
export function mentionedNames(body: string): string[] {
  const names = new Set<string>();
  for (const [, name] of body.matchAll(MENTION)) names.add(name.toLowerCase());
  names.delete("all");
  return [...names];
}

/**
 * Appends a post to the account's channel `channel`, creating the channel if this is its first post. If the member had
 * read everything before it, its read position moves past its own post, so the channel stays read for it. Each live
 * agent of the account the post names as `@<name>`, but the member, gets a mention, whether or not it has joined.
 */
export function post(db: Db, account: AccountId, member: Member, channel: string, body: string): PostResult {
  validateChannelName(channel);
  validateBody(body, "Post");
  return db
    .transaction((): PostResult => {
      checkLive(db, account, member);
      // Posting clears the poster's status line; checkLive has just found its row live.
      db.prepare("UPDATE agents SET status = NULL, status_at = NULL WHERE id = ? AND status IS NOT NULL").run(member.id);
      return append(db, account, member, channel, body);
    })
    .immediate();
}

/**
 * `post` from the account's live person `as`, under the person's stored name. Undefined, with nothing stored, if `as`
 * is not a live person of the account, so an agent's name, a removed one and an unknown one are alike. With `only`, a
 * person token's person's row id, throws `WrongPersonError`, storing nothing, unless `as` is that row.
 */
export function postAsPerson(db: Db, account: AccountId, as: string, channel: string, body: string, only?: number): PostResult | undefined {
  validateChannelName(channel);
  validateBody(body, "Post");
  return db
    .transaction((): PostResult | undefined => {
      const person = actingPerson(db, account, as, only);
      return person && append(db, account, person, channel, body);
    })
    .immediate();
}

/** The body of `post` once the sender is known to be live: `member` is its row in `agents` and its stored name. */
function append(db: Db, account: AccountId, member: { id: number; name: string }, channel: string, body: string): PostResult {
  const now = Date.now();
  const found = ensureChannel(db, account, channel, now);
  const last = db.prepare("SELECT MAX(id) AS id FROM channel_posts WHERE channel_id = ?").get(found.id) as { id: number | null };
  const read = db
    .prepare("SELECT last_read_id FROM channel_reads WHERE agent_id = ? AND channel_id = ?")
    .get(member.id, found.id) as { last_read_id: number } | undefined;
  const id = Number(
    db
      .prepare("INSERT INTO channel_posts (channel_id, sender_id, sender, body, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(found.id, member.id, member.name, body, now).lastInsertRowid,
  );
  if (last.id === null || (read !== undefined && read.last_read_id >= last.id)) advance(db, member.id, found.id, id);
  const names = body.includes("@") ? mentionedNames(body) : [];
  if (names.length > 0) {
    const mention = db.prepare(
      `INSERT INTO mentions (agent_id, post_id)
       SELECT id, ? FROM agents WHERE account_id = ? AND name = ? AND removed_at IS NULL AND id <> ?`,
    );
    for (const name of names) mention.run(id, account, name, member.id);
  }
  // Owed to every `#<channel>` webhook of the account, and to every `mention:<agent>` webhook of an agent it mentioned.
  // Mention rows only ever name agents of this account; the account check on `webhooks` says so where it matters.
  db.prepare(
    `INSERT INTO webhook_deliveries (webhook_id, post_id, created_at)
     SELECT id, ?, ? FROM webhooks WHERE account_id = ? AND event = 'channel' AND name = ? COLLATE NOCASE ORDER BY id`,
  ).run(id, now, account, found.name);
  if (names.length > 0) {
    db.prepare(
      `INSERT INTO webhook_deliveries (webhook_id, post_id, created_at)
       SELECT webhooks.id, ?, ? FROM mentions
       JOIN agents ON agents.id = mentions.agent_id
       JOIN webhooks ON webhooks.account_id = agents.account_id AND webhooks.event = 'mention' AND webhooks.name = agents.name COLLATE NOCASE
       WHERE mentions.post_id = ? AND webhooks.account_id = ? ORDER BY webhooks.id`,
    ).run(id, now, id, account);
  }
  return { channel: found.name, id, sentAt: new Date(now).toISOString() };
}

/**
 * Joins `member` to the account's channel `channel`, creating the channel if nobody has posted to it yet, so that its
 * unread posts wake the member. A channel the member has never read is joined at its latest post, so its history
 * does not wake it; one it has read before keeps its read position.
 */
export function joinChannel(db: Db, account: AccountId, member: Member, channel: string): Membership {
  validateChannelName(channel);
  return db
    .transaction((): Membership => {
      checkLive(db, account, member);
      const found = ensureChannel(db, account, channel, Date.now());
      db.prepare(
        `INSERT INTO channel_reads (agent_id, channel_id, last_read_id, joined)
         SELECT ?, ?, COALESCE(MAX(id), 0), 1 FROM channel_posts WHERE channel_id = ?
         ON CONFLICT(agent_id, channel_id) DO UPDATE SET joined = 1`,
      ).run(member.id, found.id, found.id);
      return { channel: found.name, joined: true };
    })
    .immediate();
}

/** Leaves the account's channel `channel`, so its posts no longer wake `member`. The read position stays where it was. */
export function leaveChannel(db: Db, account: AccountId, member: Member, channel: string): Membership {
  return db
    .transaction((): Membership => {
      checkLive(db, account, member);
      const found = findChannel(db, account, channel);
      db.prepare("UPDATE channel_reads SET joined = 0 WHERE agent_id = ? AND channel_id = ?").run(member.id, found.id);
      return { channel: found.name, joined: false };
    })
    .immediate();
}

/**
 * One page of `channel`, oldest first. By default the posts after the reader's read position, which then moves past
 * the last one returned; an agent that has never read the channel starts at its first post. The reader's own posts are
 * included, so a page reads in order, though they never count as unread. With `unreadOnly` false,
 * the whole history paged by `offset`, leaving the read position where it was.
 */
export function readChannel(
  db: Db,
  account: AccountId,
  reader: Member,
  channel: string,
  unreadOnly = true,
  limit = DEFAULT_CHANNEL_LIMIT,
  offset?: number,
): ChannelPage {
  if (unreadOnly && offset !== undefined) throw new ToolError("offset pages through history: pass unread_only false with it.");
  const read = db.transaction((): ChannelPage => {
    checkLive(db, account, reader);
    const found = findChannel(db, account, channel);
    const pageSize = Math.min(limit, MAX_CHANNEL_LIMIT);
    let rows: PostRow[];
    if (unreadOnly) {
      rows = db
        .prepare(
          `SELECT p.id, p.sender, p.body, p.created_at FROM channel_posts p
           LEFT JOIN channel_reads r ON r.channel_id = p.channel_id AND r.agent_id = ?
           WHERE p.channel_id = ? AND p.id > COALESCE(r.last_read_id, 0) ORDER BY p.id LIMIT ?`,
        )
        .all(reader.id, found.id, pageSize) as PostRow[];
      if (rows.length > 0) advance(db, reader.id, found.id, rows[rows.length - 1].id);
    } else {
      rows = db
        .prepare("SELECT id, sender, body, created_at FROM channel_posts WHERE channel_id = ? ORDER BY id LIMIT ? OFFSET ?")
        .all(found.id, pageSize, offset ?? 0) as PostRow[];
    }
    return { channel: found.name, posts: rows.map(toPost) };
  });
  // Only reading unread posts writes, by moving the read position; history needs no write lock.
  return unreadOnly ? read.immediate() : read();
}

/**
 * One page of the account's channels by name, each with its post count, last post time, how many posts `reader`
 * has not read and whether `reader` has joined it. The reader's own posts never count as unread.
 */
export function listChannels(
  db: Db,
  account: AccountId,
  reader: Member,
  limit = DEFAULT_CHANNEL_LIMIT,
  offset = 0,
): ChannelSummary[] {
  // The page of channels is chosen first, so only its channels' posts are counted.
  const rows = db.transaction(() => {
    checkLive(db, account, reader);
    return db
      .prepare(
        `SELECT c.name, COUNT(p.id) AS posts, MAX(p.created_at) AS last_post_at,
                COALESCE(SUM(p.id > COALESCE(r.last_read_id, 0) AND p.sender_id <> ?), 0) AS unread,
                COALESCE(r.joined, 0) AS joined
         FROM (SELECT id, name FROM channels WHERE account_id = ? ORDER BY name LIMIT ? OFFSET ?) c
         LEFT JOIN channel_posts p ON p.channel_id = c.id
         LEFT JOIN channel_reads r ON r.channel_id = c.id AND r.agent_id = ?
         GROUP BY c.id ORDER BY c.name`,
      )
      .all(reader.id, account, Math.min(limit, MAX_CHANNEL_LIMIT), offset, reader.id) as {
      name: string;
      posts: number;
      last_post_at: number | null;
      unread: number;
      joined: number;
    }[];
  })();
  return rows.map((r) => ({
    name: r.name,
    posts: r.posts,
    lastPostAt: r.last_post_at === null ? null : new Date(r.last_post_at).toISOString(),
    unread: r.unread,
    joined: r.joined === 1,
  }));
}

export interface AccountChannel {
  name: string;
  posts: number;
  /** Null for a channel that was joined before anyone posted to it. */
  lastPostAt: string | null;
  /** The names of the account's live agents that have joined the channel, in name order. */
  members: string[];
}

/**
 * One page of the account's channels by name, each with its post count, last post time and joined live agents, for
 * the account rather than for one agent. Reads only, so nothing is marked read.
 */
export function listAccountChannels(
  db: Db,
  account: AccountId,
  limit = DEFAULT_CHANNEL_LIMIT,
  offset = 0,
): AccountChannel[] {
  // One read transaction, so the page and its members describe the same moment.
  return db.transaction(() => {
    const rows = db
      .prepare(
        `SELECT c.id, c.name, COUNT(p.id) AS posts, MAX(p.created_at) AS last_post_at
         FROM (SELECT id, name FROM channels WHERE account_id = ? ORDER BY name LIMIT ? OFFSET ?) c
         LEFT JOIN channel_posts p ON p.channel_id = c.id
         GROUP BY c.id ORDER BY c.name`,
      )
      .all(account, Math.min(limit, MAX_CHANNEL_LIMIT), offset) as {
      id: number;
      name: string;
      posts: number;
      last_post_at: number | null;
    }[];
    const members = db.prepare(
      `SELECT a.name FROM channel_reads r JOIN agents a ON a.id = r.agent_id
       WHERE r.channel_id = ? AND r.joined = 1 AND a.account_id = ? AND a.removed_at IS NULL ORDER BY a.name`,
    );
    return rows.map((r) => ({
      name: r.name,
      posts: r.posts,
      lastPostAt: r.last_post_at === null ? null : new Date(r.last_post_at).toISOString(),
      members: members.pluck().all(r.id, account) as string[],
    }));
  })();
}

/**
 * One page of the account's channel `channel`, oldest first, paged by `limit` and `offset`, for the account rather than for one
 * agent, each post with whether each agent of the account it mentions has read the mention with `read_inbox`. With
 * `unreadOnly`, only the posts with at least one unread mention of an agent. Reads only, so no read position moves and
 * nothing is marked read.
 */
export function readAccountChannel(
  db: Db,
  account: AccountId,
  channel: string,
  limit = DEFAULT_CHANNEL_LIMIT,
  offset = 0,
  unreadOnly = false,
): AccountChannelPage {
  // With unreadOnly, the posts are found from the account's agents and their unread mentions (mentions_unread), so only
  // unread rows are read, never the channel's whole history; a post with several unread mentions is listed once.
  const page = unreadOnly
    ? `SELECT DISTINCT p.id, p.sender, p.body, p.created_at
       FROM agents a CROSS JOIN mentions x ON x.agent_id = a.id AND x.read_at IS NULL CROSS JOIN channel_posts p ON p.id = x.post_id
       WHERE p.channel_id = ? AND a.account_id = ? AND a.person = 0 ORDER BY p.id LIMIT ? OFFSET ?`
    : "SELECT id, sender, body, created_at FROM channel_posts WHERE channel_id = ? ORDER BY id LIMIT ? OFFSET ?";
  return db.transaction((): AccountChannelPage => {
    const found = findChannel(db, account, channel);
    const params = [found.id, ...(unreadOnly ? [account] : []), Math.min(limit, MAX_CHANNEL_LIMIT), offset];
    const rows = db.prepare(page).all(...params) as PostRow[];
    // The page's mentions in one statement, with the page as a subquery rather than a list of ids.
    const mentions = db
      .prepare(
        `SELECT x.post_id, CASE WHEN a.removed_at IS NULL THEN a.name ELSE a.removed_name END AS name, x.read_at
         FROM (${page}) pg JOIN mentions x ON x.post_id = pg.id JOIN agents a ON a.id = x.agent_id
         WHERE a.account_id = ? AND a.person = 0 ORDER BY x.post_id, name COLLATE NOCASE, a.id`,
      )
      .all(...params, account) as { post_id: number; name: string; read_at: number | null }[];
    const byPost = new Map<number, { name: string; read: boolean }[]>();
    for (const m of mentions) {
      const list = byPost.get(m.post_id) ?? [];
      list.push({ name: m.name, read: m.read_at !== null });
      byPost.set(m.post_id, list);
    }
    return { channel: found.name, posts: rows.map((r) => ({ ...toPost(r), mentions: byPost.get(r.id) ?? [] })) };
  })();
}
