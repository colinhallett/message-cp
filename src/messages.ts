import { NAME_PATTERN, ToolError, getAgent, personOf, type Identity } from "./agents.js";
import type { Member } from "./channels.js";
import type { AccountId, Db } from "./db.js";

export interface Message {
  from: string;
  sentAt: string;
  body: string;
  broadcast: boolean;
}

/** A channel post that named the reader as `@<name>`, as read_inbox returns it: `id` is the post's id. */
export interface Mention {
  channel: string;
  id: number;
  from: string;
  sentAt: string;
  body: string;
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

/** A row of read_inbox's page: a message, or with `mention` 1 a mentioning post, whose `channel` is then set. */
interface InboxRow extends Omit<Row, "read_at"> {
  mention: number;
  channel: string | null;
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
      // Each recipient's row is owed to every `agent:<recipient>` webhook of the account.
      const queue = db.prepare(
        `INSERT INTO webhook_deliveries (webhook_id, message_id, created_at)
         SELECT id, ?, ? FROM webhooks WHERE account_id = ? AND event = 'agent' AND name = ? COLLATE NOCASE ORDER BY id`,
      );
      const now = Date.now();
      for (const r of recipients) {
        const id = insert.run(r.id, from, body, broadcast ? 1 : 0, now).lastInsertRowid;
        queue.run(id, now, account, r.name);
      }
      return { delivered: recipients.length, recipients: recipients.map((r) => r.name) };
    })
    .immediate();
}

/**
 * `sendMessage` from the account's live person `as`, under the person's stored name. Undefined, with nothing stored,
 * if `as` is not a live person of the account, so an agent's name, a removed one and an unknown one are alike.
 */
export function sendAsPerson(db: Db, account: AccountId, as: string, to: string, body: string): SendResult | undefined {
  validateBody(body);
  // One transaction, so the person cannot be removed between the check and the send.
  return db
    .transaction((): SendResult | undefined => {
      const person = personOf(db, account, as);
      return person && sendMessage(db, account, person.name, to, body);
    })
    .immediate();
}

/**
 * One page of the caller's messages and mentions together, oldest first. Everything returned is marked read. Unread
 * ones beyond the page stay unread for the next call; with `unreadOnly` false, use `offset`. Reading a mention does
 * not move the caller's read position in its channel. `reader` is the caller's name, or its registration.
 */
export function readInbox(
  db: Db,
  account: AccountId,
  reader: string | Identity,
  unreadOnly = true,
  limit = DEFAULT_INBOX_LIMIT,
  offset = 0,
): (Message | Mention)[] {
  return db
    .transaction((): (Message | Mention)[] => {
      // A session passes its registration, so a name taken over since the session checked it reads nothing.
      const agent = (
        typeof reader === "string"
          ? db.prepare("SELECT id FROM agents WHERE account_id = ? AND name = ? AND removed_at IS NULL").get(account, reader)
          : db
              .prepare("SELECT id FROM agents WHERE account_id = ? AND id = ? AND registered_at = ? AND instance IS ? AND removed_at IS NULL")
              .get(account, reader.id, reader.registeredAt, reader.instance)
      ) as { id: number } | undefined;
      if (!agent) return [];
      // Oldest first; a message before a mention of the same millisecond, and each kind in id order.
      const rows = db
        .prepare(
          `SELECT 0 AS mention, id, sender, body, broadcast, created_at, NULL AS channel
           FROM messages WHERE recipient_id = ? ${unreadOnly ? "AND read_at IS NULL" : ""}
           UNION ALL
           SELECT 1, p.id, p.sender, p.body, 0, p.created_at, c.name
           FROM mentions x JOIN channel_posts p ON p.id = x.post_id
           JOIN channels c ON c.id = p.channel_id AND c.account_id = ?
           WHERE x.agent_id = ? ${unreadOnly ? "AND x.read_at IS NULL" : ""}
           ORDER BY created_at, mention, id LIMIT ? OFFSET ?`,
        )
        .all(agent.id, account, agent.id, Math.min(limit, MAX_INBOX_LIMIT), offset) as InboxRow[];
      const markMessage = db.prepare("UPDATE messages SET read_at = ? WHERE id = ? AND read_at IS NULL");
      const markMention = db.prepare(
        "UPDATE mentions SET read_at = ? WHERE agent_id = ? AND post_id = ? AND read_at IS NULL",
      );
      const now = Date.now();
      for (const r of rows) {
        if (r.mention === 1) markMention.run(now, agent.id, r.id);
        else markMessage.run(now, r.id);
      }
      return rows.map((r): Message | Mention =>
        r.mention === 1
          ? { channel: r.channel!, id: r.id, from: r.sender, sentAt: new Date(r.created_at).toISOString(), body: r.body }
          : { from: r.sender, sentAt: new Date(r.created_at).toISOString(), body: r.body, broadcast: r.broadcast === 1 },
      );
    })
    .immediate();
}

/** A direct message between the caller and one other agent or person, as `read_conversation` returns it. */
export interface ConversationMessage extends Message {
  to: string;
}

/**
 * One page of the direct messages between `reader` and the live agent or person `other` (any case), both directions,
 * newest first. Received means addressed to the reader's own row, so a removed agent's mail never shows. `sender` is
 * only a name, so sent means sent under the reader's name since its row was registered: a removed agent that once had
 * the name sent the rest. Reads only: nothing is marked read. Throws send_message's error for an unknown or removed
 * `other`; returns nothing if the reader's registration is no longer live.
 */
export function readConversation(
  db: Db,
  account: AccountId,
  reader: Member,
  other: string,
  limit = DEFAULT_INBOX_LIMIT,
  offset = 0,
): ConversationMessage[] {
  // One read transaction, so both directions and the rows they name are read at the same moment.
  return db.transaction((): ConversationMessage[] => {
    const them = getAgent(db, account, other);
    if (!them) throw new ToolError(`No agent named '${other}'.`);
    const me = db
      .prepare("SELECT id, name, registered_at FROM agents WHERE account_id = ? AND id = ? AND registered_at = ? AND instance IS ? AND removed_at IS NULL")
      .get(account, reader.id, reader.registeredAt, reader.instance) as { id: number; name: string; registered_at: number } | undefined;
    if (!me) return [];
    const self = me.name.toLowerCase() === them.name.toLowerCase();
    // Each direction reads the pair's messages_by_pair rows already in page order, so the page stops after
    // limit + offset rows. With oneself the two directions are the same rows, so only the received one runs, and
    // each message appears once.
    const rows = db
      .prepare(
        `SELECT id, sender, ? AS recipient, body, broadcast, created_at FROM messages
         WHERE recipient_id = ? AND sender = ? COLLATE NOCASE
         ${self ? "" : `UNION ALL
         SELECT id, sender, ?, body, broadcast, created_at FROM messages
         WHERE recipient_id = (SELECT id FROM agents WHERE account_id = ? AND name = ? AND removed_at IS NULL)
           AND sender = ? COLLATE NOCASE AND created_at >= ?`}
         ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      )
      .all(
        me.name,
        me.id,
        them.name,
        ...(self ? [] : [them.name, account, them.name, me.name, me.registered_at]),
        Math.min(limit, MAX_INBOX_LIMIT),
        offset,
      ) as (Omit<Row, "read_at"> & { recipient: string })[];
    return rows.map((r) => ({
      from: r.sender,
      to: r.recipient,
      sentAt: new Date(r.created_at).toISOString(),
      body: r.body,
      broadcast: r.broadcast === 1,
    }));
  })();
}

export interface Unread {
  /** Unread messages, and who sent them. */
  count: number;
  senders: string[];
  /** Unread posts in the channels the agent has joined, and which channels they are in. */
  posts: number;
  channels: string[];
  /** Unread mentions, in any channel of the account, and which channels they are in. */
  mentions: number;
  mentionChannels: string[];
}

/** Whether `unread` is anything to wake for: an unread message, an unread post in a joined channel or a mention. */
export const hasUnread = (unread: Unread) => unread.count > 0 || unread.posts > 0 || unread.mentions > 0;

/**
 * How many unread messages `name` has and who sent them, how many unread posts are in the channels it has joined and
 * where, and how many unread mentions it has and where, without reading or marking anything. Undefined if there is no
 * such agent.
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
    const mentions = db
      .prepare(
        `SELECT c.name, COUNT(*) AS n FROM agents a
         JOIN mentions x ON x.agent_id = a.id AND x.read_at IS NULL
         JOIN channel_posts p ON p.id = x.post_id
         JOIN channels c ON c.id = p.channel_id AND c.account_id = a.account_id
         WHERE a.account_id = ? AND a.name = ? AND a.removed_at IS NULL GROUP BY c.id ORDER BY MIN(p.id)`,
      )
      .all(account, agent.name) as { name: string; n: number }[];
    return {
      count: messages.reduce((sum, r) => sum + r.n, 0),
      senders: messages.map((r) => r.sender),
      posts: posts.reduce((sum, r) => sum + r.n, 0),
      channels: posts.map((r) => r.name),
      mentions: mentions.reduce((sum, r) => sum + r.n, 0),
      mentionChannels: mentions.map((r) => r.name),
    };
  })();
}

interface AgentUnreadRow {
  name: string;
  bio: string;
  last_seen: number;
  person: number;
  messages: number;
  posts: number;
  mentions: number;
}

export interface AgentUnread {
  name: string;
  bio: string;
  lastSeen: string;
  /** True for a person added with `message-cp person add`, as `list_agents` gives it. */
  person: boolean;
  unreadMessages: number;
  unreadPosts: number;
  unreadMentions: number;
}

/**
 * One page of the account's live agents in name order, as `list_agents` pages them, each with its unread message, post
 * and mention totals counted as `unreadSummary` counts them. One query for the page, totals only: no senders or
 * channels.
 */
export function listAgentsUnread(db: Db, account: AccountId, limit: number, offset: number): AgentUnread[] {
  const rows = db
    .prepare(
      `SELECT a.name, a.bio, a.last_seen, a.person,
         (SELECT COUNT(*) FROM messages m WHERE m.recipient_id = a.id AND m.read_at IS NULL) AS messages,
         (SELECT COUNT(*) FROM channel_reads r
            JOIN channels c ON c.id = r.channel_id AND c.account_id = a.account_id
            JOIN channel_posts p ON p.channel_id = c.id AND p.id > r.last_read_id AND p.sender_id <> a.id
          WHERE r.agent_id = a.id AND r.joined = 1) AS posts,
         (SELECT COUNT(*) FROM mentions x
            JOIN channel_posts p ON p.id = x.post_id
            JOIN channels c ON c.id = p.channel_id AND c.account_id = a.account_id
          WHERE x.agent_id = a.id AND x.read_at IS NULL) AS mentions
       FROM agents a WHERE a.account_id = ? AND a.removed_at IS NULL ORDER BY a.name LIMIT ? OFFSET ?`,
    )
    .all(account, limit, offset) as AgentUnreadRow[];
  return rows.map((r) => ({
    name: r.name,
    bio: r.bio,
    lastSeen: new Date(r.last_seen).toISOString(),
    person: r.person === 1,
    unreadMessages: r.messages,
    unreadPosts: r.posts,
    unreadMentions: r.mentions,
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

/** One of the account's messages, as `listAccountMessages` gives it. */
export interface ListedMessage extends AccountMessage {
  /**
   * Whether the message is to an agent, not to a person, its recipient has not read it, and at least one of its webhook
   * deliveries has been delivered: a webhook has started a run for it.
   */
  starting: boolean;
}

/** A row `listAccountMessages` reads: `person` is the recipient's, `delivered` 1 when a webhook delivered the message. */
type ListedRow = Row & { recipient: string; person: number; delivered: number };

/**
 * One page of the account's messages, oldest first, for the account rather than for one agent. A broadcast is one row
 * per recipient, so it appears once per recipient. A message to a removed agent shows the name it had. With `unreadOnly`,
 * only the messages to an agent, not to a person, whose recipient has not read them: a person has no `read_inbox`, so
 * every message to one would stay among them for good. `starting` is read from the message's own webhook deliveries,
 * found through `webhook_deliveries_by_message`. Reads only, so nothing is marked read and no delivery is touched.
 */
export function listAccountMessages(
  db: Db,
  account: AccountId,
  limit: number,
  offset: number,
  unreadOnly = false,
): ListedMessage[] {
  const rows = db
    .prepare(
      `SELECT m.id, m.sender, CASE WHEN a.removed_at IS NULL THEN a.name ELSE a.removed_name END AS recipient,
              m.body, m.broadcast, m.created_at, m.read_at, a.person,
              EXISTS (SELECT 1 FROM webhook_deliveries d
                      WHERE d.message_id = m.id AND d.delivered_at IS NOT NULL) AS delivered
       FROM messages m JOIN agents a ON a.id = m.recipient_id
       WHERE a.account_id = ?${unreadOnly ? " AND a.person = 0 AND m.read_at IS NULL" : ""} ORDER BY m.id LIMIT ? OFFSET ?`,
    )
    .all(account, Math.min(limit, MAX_INBOX_LIMIT), offset) as ListedRow[];
  return rows.map((r) => ({
    id: r.id,
    from: r.sender,
    to: r.recipient,
    sentAt: new Date(r.created_at).toISOString(),
    body: r.body,
    broadcast: r.broadcast === 1,
    read: r.read_at !== null,
    starting: r.read_at === null && r.person === 0 && r.delivered === 1,
  }));
}

/**
 * Deletes the account's messages between `first` and `second`, either way and in any case: exactly the rows
 * `listAccountMessages` lists with that `from` and `to`, broadcasts and messages to a removed agent's old name included.
 * Their webhook deliveries go with them. Returns how many were deleted.
 */
export function deleteConversation(db: Db, account: AccountId, first: string, second: string): number {
  // One statement per direction, so each reads only the messages_by_sender rows for that pair, not the account's history.
  const fromTo = db.prepare(
    `DELETE FROM messages
     WHERE recipient_id IN (SELECT id FROM agents WHERE account_id = ?
                              AND (CASE WHEN removed_at IS NULL THEN name ELSE removed_name END) = ? COLLATE NOCASE)
       AND sender = ? COLLATE NOCASE`,
  );
  return db.transaction((): number => {
    const there = fromTo.run(account, second, first).changes;
    // A conversation with oneself is one direction; running it twice would only find nothing the second time.
    return there + fromTo.run(account, first, second).changes;
  }).immediate();
}

/** A message the caller received, as `search` returns it. */
export interface MessageMatch extends Message {
  kind: "message";
}

/** A post in one of the caller's account's channels, as `search` returns it: `id` is the post's id. */
export interface PostMatch {
  kind: "post";
  channel: string;
  id: number;
  from: string;
  sentAt: string;
  body: string;
}

export interface SearchFilters {
  /** Only this channel's posts, and no messages. */
  channel?: string;
  /** Only this sender's, by name in any case. */
  from?: string;
  /** ISO 8601: sent at or after this time. */
  since?: string;
  /** ISO 8601: sent before this time. */
  until?: string;
}

export const MAX_SEARCH_LENGTH = 200;

/**
 * A row of a search page: a message, or with `is_post` 1 a channel post, whose `channel` is then set. `recipient` and
 * `read_at` are set only for `searchAccount`'s messages.
 */
interface SearchRow extends Row {
  is_post: number;
  channel: string | null;
  recipient: string | null;
}

// A date, or a date and time (to the millisecond) with an optional offset; a time with no offset is UTC, like a date
// alone.
const ISO_TIME = /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/;

function parseTime(value: string, field: string): number {
  const m = ISO_TIME.exec(value);
  const ms = m ? Date.parse(value.includes("T") && !m[4] ? `${value}Z` : value) : NaN;
  // Date.parse rolls 2026-02-30 over to March, so the date has to come back unchanged. setUTCFullYear keeps years 0-99,
  // which Date.UTC would read as 1900-1999.
  const day = m && new Date(new Date(0).setUTCFullYear(+m[1], +m[2] - 1, +m[3]));
  if (!m || Number.isNaN(ms) || day!.getUTCMonth() !== +m[2] - 1 || day!.getUTCDate() !== +m[3]) {
    throw new ToolError(`Invalid ${field}: use an ISO 8601 time such as 2026-10-20 or 2026-10-20T12:00:00Z.`);
  }
  return ms;
}

/** The validated search text and filters, as `search` and `searchAccount` share them. */
interface SearchQuery {
  channel: string | undefined;
  /** Each half's filters on its table `t`, in the order of `params`: body, sender, since, until. */
  where: (t: string) => string;
  params: (string | number | null)[];
}

/** Throws a ToolError unless `text` and `filters` are valid search arguments; otherwise the SQL filter they make. */
function searchQuery(text: string, filters: SearchFilters): SearchQuery {
  if (text.length === 0 || text.length > 2 * MAX_SEARCH_LENGTH || countCodePoints(text) > MAX_SEARCH_LENGTH) {
    throw new ToolError(`Search text must be 1 to ${MAX_SEARCH_LENGTH} characters.`);
  }
  const { channel, from } = filters;
  if (channel !== undefined && !NAME_PATTERN.test(channel)) {
    throw new ToolError("Invalid channel name: use 1-32 characters from letters, digits, '-' and '_'.");
  }
  const since = filters.since === undefined ? null : parseTime(filters.since, "since");
  const until = filters.until === undefined ? null : parseTime(filters.until, "until");
  const pattern = `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const where = (t: string) => `${t}.body LIKE ? ESCAPE '\\' AND (? IS NULL OR ${t}.sender = ? COLLATE NOCASE)
    AND (? IS NULL OR ${t}.created_at >= ?) AND (? IS NULL OR ${t}.created_at < ?)`;
  return { channel, where, params: [pattern, from ?? null, from ?? null, since, since, until, until] };
}

/** The posts half of a search, newest first, scoped to the account's channels; its first placeholder is the account. */
const searchPosts = ({ channel, where }: SearchQuery) =>
  `SELECT 1 AS is_post, p.id, p.sender, p.body, 0 AS broadcast, p.created_at, c.name AS channel, NULL AS recipient, NULL AS read_at
   FROM channel_posts p JOIN channels c ON c.id = p.channel_id AND c.account_id = ?
   WHERE ${channel === undefined ? "" : "c.name = ? AND "}${where("p")}`;

// Newest first; at the same millisecond a post before a message, and each kind newest id first.
const SEARCH_ORDER = "ORDER BY created_at DESC, is_post DESC, id DESC LIMIT ? OFFSET ?";

/** A post row of a search page, as both searches return it. */
const toPost = (r: SearchRow): PostMatch => ({
  kind: "post",
  channel: r.channel!,
  id: r.id,
  from: r.sender,
  sentAt: new Date(r.created_at).toISOString(),
  body: r.body,
});

/**
 * One page of what the caller could already read whose body contains `text` (ASCII letters in any case), newest
 * first: the messages it received and the posts in its account's channels. `reader` is the caller's registration, so
 * a later agent with a removed agent's name finds none of its messages. Reads only: nothing is marked read and no
 * channel read position moves.
 */
export function search(
  db: Db,
  account: AccountId,
  reader: Identity,
  text: string,
  filters: SearchFilters = {},
  limit = DEFAULT_INBOX_LIMIT,
  offset = 0,
): (MessageMatch | PostMatch)[] {
  const query = searchQuery(text, filters);
  const { channel, where, params } = query;
  return db.transaction((): (MessageMatch | PostMatch)[] => {
    const agent = db
      .prepare("SELECT id FROM agents WHERE account_id = ? AND id = ? AND registered_at = ? AND instance IS ? AND removed_at IS NULL")
      .get(account, reader.id, reader.registeredAt, reader.instance) as { id: number } | undefined;
    if (!agent) return [];
    const rows = db
      .prepare(
        `SELECT * FROM (
           ${channel === undefined ? `SELECT 0 AS is_post, m.id, m.sender, m.body, m.broadcast, m.created_at, NULL AS channel, NULL AS recipient, NULL AS read_at FROM messages m WHERE m.recipient_id = ? AND ${where("m")} UNION ALL` : ""}
           ${searchPosts(query)})
         ${SEARCH_ORDER}`,
      )
      .all(
        ...(channel === undefined ? [agent.id, ...params] : []),
        account,
        ...(channel === undefined ? [] : [channel]),
        ...params,
        Math.min(limit, MAX_INBOX_LIMIT),
        offset,
      ) as SearchRow[];
    return rows.map((r): MessageMatch | PostMatch =>
      r.is_post === 1
        ? toPost(r)
        : { kind: "message", from: r.sender, sentAt: new Date(r.created_at).toISOString(), body: r.body, broadcast: r.broadcast === 1 },
    );
  })();
}

/** One of the account's messages, as `searchAccount` returns it: as `listAccountMessages` gives it, less `starting`. */
export interface AccountMessageMatch extends AccountMessage {
  kind: "message";
}

/**
 * `search` for the account rather than for one agent: one page of the account's messages, to any of its agents, and
 * its channels' posts whose body contains `text`, newest first, with the same arguments and errors. A message is
 * scoped through its recipient's account, as in `listAccountMessages`, and a broadcast appears once per recipient.
 * Reads only: nothing is marked read and no channel read position moves.
 */
export function searchAccount(
  db: Db,
  account: AccountId,
  text: string,
  filters: SearchFilters = {},
  limit = DEFAULT_INBOX_LIMIT,
  offset = 0,
): (AccountMessageMatch | PostMatch)[] {
  const query = searchQuery(text, filters);
  const { channel, where, params } = query;
  const rows = db
    .prepare(
      `SELECT * FROM (
         ${channel === undefined ? `SELECT 0 AS is_post, m.id, m.sender, m.body, m.broadcast, m.created_at, NULL AS channel,
             CASE WHEN a.removed_at IS NULL THEN a.name ELSE a.removed_name END AS recipient, m.read_at
           FROM messages m JOIN agents a ON a.id = m.recipient_id AND a.account_id = ? WHERE ${where("m")} UNION ALL` : ""}
         ${searchPosts(query)})
       ${SEARCH_ORDER}`,
    )
    .all(
      ...(channel === undefined ? [account, ...params] : []),
      account,
      ...(channel === undefined ? [] : [channel]),
      ...params,
      Math.min(limit, MAX_INBOX_LIMIT),
      offset,
    ) as SearchRow[];
  return rows.map((r): AccountMessageMatch | PostMatch =>
    r.is_post === 1
      ? toPost(r)
      : {
          kind: "message",
          id: r.id,
          from: r.sender,
          to: r.recipient!,
          sentAt: new Date(r.created_at).toISOString(),
          body: r.body,
          broadcast: r.broadcast === 1,
          read: r.read_at !== null,
        },
  );
}
