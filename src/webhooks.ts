import { createHmac, randomBytes } from "node:crypto";
import { NAME_PATTERN } from "./agents.js";
import type { AccountId, Db } from "./db.js";
import { MAX_INBOX_LIMIT } from "./messages.js";

// Outgoing webhooks. The operator manages them with `message-cp webhook` on the server; no agent or token can.
// Messages and posts a webhook is for are queued in `webhook_deliveries` when they are stored, and `serve` sends them
// with `sendPending`: each body signed with the webhook's secret, a timeout and a few attempts. The stdio server and
// `message-cp wait` send nothing. A webhook's secret is shown once, when it is added, and stored as is so that
// deliveries can sign with it. A webhook may also carry one header the owner sets, such as `Authorization`, sent on each
// of its deliveries; its value is stored as is too, and never printed, logged or returned. And it may carry a limit on
// how many delivery requests it gets per window of 60 minutes; deliveries past it wait in the queue for a later window.

export class WebhookError extends Error {}

/** What a webhook is for: posts in a channel, posts that mention an agent, or direct messages to an agent. */
export type WebhookEvent = "channel" | "mention" | "agent";

export interface Webhook {
  id: number;
  account: string;
  url: string;
  event: WebhookEvent;
  /** The channel or agent name, as given. */
  name: string;
  includeText: boolean;
  /** The name of the header its deliveries carry, or null for none; its value is never given out. */
  headerName: string | null;
  /** The most delivery requests it gets per window (`WEBHOOK_WINDOW_MS`), or null for no limit. */
  maxPerHour: number | null;
}

export interface NewWebhook extends Webhook {
  secret: string;
}

/**
 * The URL a webhook may send to, as `new URL(...).href`: https, or http only to a literal loopback address, with no
 * username, password, query or fragment. Errors never repeat the URL, since it may carry a credential.
 */
export function webhookUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebhookError("Invalid --url: give an absolute https URL.");
  }
  const loopback = /^127(\.\d{1,3}){3}$/.test(url.hostname) || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new WebhookError("--url must be https (plain http only for 127.x.x.x or [::1]): deliveries would cross the network in the clear.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new WebhookError("--url must not carry a username, password, query or fragment.");
  }
  // Drops a bare `?` or `#`, which leave `search` and `hash` empty but stay in `href`.
  url.search = "";
  url.hash = "";
  return url.href;
}

/**
 * Parses `--on`: `#<channel>`, `mention:<agent>` or `agent:<agent>`, each name following the agent-name rules. An agent
 * cannot be named `all`, so `mention:all` and `agent:all` are refused; `#all` is an ordinary channel.
 */
export function webhookOn(on: string): { event: WebhookEvent; name: string } {
  const [, prefix, name] = /^(#|mention:|agent:)(.*)$/s.exec(on) ?? [];
  if (prefix === undefined || !NAME_PATTERN.test(name!)) {
    throw new WebhookError("Invalid --on: use #<channel>, mention:<agent> or agent:<agent>, names of 1-32 letters, digits, '-' and '_'.");
  }
  if (prefix !== "#" && name!.toLowerCase() === "all") {
    throw new WebhookError("Invalid --on: 'all' is reserved and names no agent.");
  }
  return { event: prefix === "#" ? "channel" : (prefix.slice(0, -1) as WebhookEvent), name: name! };
}

/**
 * Header names message-cp sets on a delivery itself, that `fetch` controls or refuses to send, or that describe the body
 * (which message-cp builds for each delivery), in lower case. Every `Content-*` name is refused as well.
 */
const RESERVED_HEADERS = [
  "x-message-cp-signature",
  "host",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "upgrade",
  "expect",
  "digest",
  "repr-digest",
];

/**
 * Parses the one header line `--header-stdin` reads, `<Name>: <value>`: the name an HTTP token that message-cp does not
 * set itself, the value trimmed of spaces and tabs, not empty, with no control character and nothing past U+00FF.
 * Errors never repeat the value.
 */
export function webhookHeader(line: string): { name: string; value: string } {
  const colon = line.indexOf(":");
  if (colon === -1) throw new WebhookError("Invalid header: give one line '<Name>: <value>'.");
  const name = line.slice(0, colon);
  const value = line.slice(colon + 1).replace(/^[ \t]+|[ \t]+$/g, "");
  if (!/^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/.test(name)) {
    throw new WebhookError("Invalid header name: use letters, digits and !#$%&'*+-.^_`|~ only, before the ':'.");
  }
  if (RESERVED_HEADERS.includes(name.toLowerCase()) || /^content-/i.test(name)) {
    throw new WebhookError(`Invalid header: message-cp controls ${name} itself; choose another header.`);
  }
  if (value === "") throw new WebhookError("Invalid header: its value is empty.");
  // Tab included: inside a value it is a control character like CR and LF. So are U+0080-U+009F.
  if (/[\x00-\x1f\x7f-\x9f]/.test(value)) throw new WebhookError("Invalid header: its value contains a control character.");
  // `fetch` refuses a header value with a character past U+00FF, so every delivery would fail.
  if (/[^\x00-\xff]/.test(value)) throw new WebhookError("Invalid header: its value has a character past U+00FF, which HTTP cannot send.");
  return { name, value };
}

/** The highest `--max-per-hour`. */
export const WEBHOOK_MAX_PER_HOUR = 10000;

const isMaxPerHour = (n: number) => Number.isSafeInteger(n) && n >= 1 && n <= WEBHOOK_MAX_PER_HOUR;

/** Parses `--max-per-hour`: a whole number from 1 to 10000, in decimal digits only. */
export function webhookMaxPerHour(raw: string): number {
  if (!/^[0-9]+$/.test(raw) || !isMaxPerHour(Number(raw))) {
    throw new WebhookError(`Invalid --max-per-hour: give a whole number from 1 to ${WEBHOOK_MAX_PER_HOUR}.`);
  }
  return Number(raw);
}

/** How `--on` names a webhook's event, for printing. */
export const formatOn = (w: Pick<Webhook, "event" | "name">) => (w.event === "channel" ? `#${w.name}` : `${w.event}:${w.name}`);

/**
 * Adds a webhook to the account named `account`, with a new secret, with the header line `header` if given, and limited
 * to `maxPerHour` delivery requests per window if given.
 */
export const addWebhook = (
  db: Db,
  account: string,
  url: string,
  on: string,
  includeText: boolean,
  header?: string,
  maxPerHour?: number,
): NewWebhook =>
  db.transaction((): NewWebhook => {
    const href = webhookUrl(url);
    const { event, name } = webhookOn(on);
    const extra = header === undefined ? undefined : webhookHeader(header);
    if (maxPerHour !== undefined && !isMaxPerHour(maxPerHour)) {
      throw new WebhookError(`Invalid --max-per-hour: give a whole number from 1 to ${WEBHOOK_MAX_PER_HOUR}.`);
    }
    const row = db.prepare("SELECT id, name FROM accounts WHERE name = ?").get(account) as { id: AccountId; name: string } | undefined;
    if (!row) throw new WebhookError(`No account named '${account}'.`);
    const secret = randomBytes(32).toString("hex");
    const { id } = db
      .prepare(
        `INSERT INTO webhooks (account_id, url, event, name, include_text, secret, header_name, header_value, max_per_hour, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(row.id, href, event, name, includeText ? 1 : 0, secret, extra?.name ?? null, extra?.value ?? null, maxPerHour ?? null, Date.now()) as {
      id: number;
    };
    return { id, account: row.name, url: href, event, name, includeText, headerName: extra?.name ?? null, maxPerHour: maxPerHour ?? null, secret };
  }).immediate();

/** The webhooks of the account named `account`, or of every account without it; never their secrets or header values. */
export function listWebhooks(db: Db, account?: string): Webhook[] {
  if (account !== undefined && !db.prepare("SELECT 1 FROM accounts WHERE name = ?").get(account)) {
    throw new WebhookError(`No account named '${account}'.`);
  }
  const rows = db
    .prepare(
      `SELECT webhooks.id, accounts.name AS account, url, event, webhooks.name, include_text, header_name, max_per_hour
       FROM webhooks JOIN accounts ON accounts.id = webhooks.account_id
       WHERE ? IS NULL OR accounts.name = ? ORDER BY webhooks.id`,
    )
    .all(account ?? null, account ?? null) as (Omit<Webhook, "includeText" | "headerName" | "maxPerHour"> & {
    include_text: number;
    header_name: string | null;
    max_per_hour: number | null;
  })[];
  return rows.map(({ include_text, header_name, max_per_hour, ...w }) => ({
    ...w,
    includeText: include_text === 1,
    headerName: header_name,
    maxPerHour: max_per_hour,
  }));
}

/** Deletes the webhook `id`. Returns the account it belonged to. */
export function removeWebhook(db: Db, id: number): string {
  const row = db
    .prepare("DELETE FROM webhooks WHERE id = ? RETURNING (SELECT name FROM accounts WHERE accounts.id = webhooks.account_id) AS account")
    .get(id) as { account: string } | undefined;
  if (!row) throw new WebhookError(`No webhook with id ${id}.`);
  return row.account;
}

/** A delivery as `GET /api/webhook-deliveries` shows it: never its webhook's URL or secret, or the text it carries. */
export interface AccountDelivery {
  id: number;
  webhook: number;
  /** The webhook's `--on`, as `formatOn` prints it. */
  on: string;
  queuedAt: string;
  attempts: number;
  /** Null until a 2xx answer. */
  deliveredAt: string | null;
  /** `failed` once it has no attempts left under `maxAttempts`, so `sendPending` with it will not try again. */
  status: "delivered" | "pending" | "failed";
}

/**
 * One page of the deliveries queued for the webhooks of `account`, newest first. Scoped through the webhook's account,
 * so another account's deliveries are never counted or returned. Reads only: no row is claimed or changed.
 */
export function listAccountDeliveries(db: Db, account: AccountId, maxAttempts: number, limit: number, offset: number): AccountDelivery[] {
  const rows = db
    .prepare(
      `SELECT d.id, d.webhook_id, w.event, w.name, d.created_at, d.attempts, d.delivered_at
       FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id
       WHERE w.account_id = ? ORDER BY d.id DESC LIMIT ? OFFSET ?`,
    )
    .all(account, Math.min(limit, MAX_INBOX_LIMIT), offset) as {
    id: number;
    webhook_id: number;
    event: WebhookEvent;
    name: string;
    created_at: number;
    attempts: number;
    delivered_at: number | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    webhook: r.webhook_id,
    on: formatOn(r),
    queuedAt: new Date(r.created_at).toISOString(),
    attempts: r.attempts,
    deliveredAt: r.delivered_at === null ? null : new Date(r.delivered_at).toISOString(),
    // As `sendPending` picks what is still pending: undelivered with attempts left.
    status: r.delivered_at !== null ? "delivered" : r.attempts < maxAttempts ? "pending" : "failed",
  }));
}

/** The JSON body a delivery carries. Never an account id, a secret or a token. */
export interface DeliveryBody {
  event: WebhookEvent;
  /** For a post. */
  channel?: string;
  /** For a message. */
  recipient?: string;
  sender: string;
  sentAt: string;
  /** Only when the webhook was added without `--no-text`. */
  text?: string;
}

/** The body of the queued delivery `id`, built from its message or post as it is now, or undefined if there is none. */
export function deliveryBody(db: Db, id: number): DeliveryBody | undefined {
  const row = db
    .prepare(
      `SELECT w.event, w.include_text, c.name AS channel,
              CASE WHEN a.removed_at IS NULL THEN a.name ELSE a.removed_name END AS recipient,
              COALESCE(m.sender, p.sender) AS sender, COALESCE(m.created_at, p.created_at) AS created_at, COALESCE(m.body, p.body) AS body
       FROM webhook_deliveries d
       JOIN webhooks w ON w.id = d.webhook_id
       LEFT JOIN messages m ON m.id = d.message_id
       LEFT JOIN agents a ON a.id = m.recipient_id
       LEFT JOIN channel_posts p ON p.id = d.post_id
       LEFT JOIN channels c ON c.id = p.channel_id
       WHERE d.id = ?`,
    )
    .get(id) as
    | { event: WebhookEvent; include_text: number; channel: string | null; recipient: string | null; sender: string; created_at: number; body: string }
    | undefined;
  if (!row) return undefined;
  return {
    event: row.event,
    ...(row.channel !== null ? { channel: row.channel } : { recipient: row.recipient! }),
    sender: row.sender,
    sentAt: new Date(row.created_at).toISOString(),
    ...(row.include_text === 1 ? { text: row.body } : {}),
  };
}

/** A delivery request not finished in this long is aborted and counts as a failed attempt. */
export const WEBHOOK_TIMEOUT_MS = 5000;
/** Attempts a delivery gets in all; after the last failed one it is left undelivered and not tried again. */
export const WEBHOOK_MAX_ATTEMPTS = 3;
/** Most deliveries one pass sends. */
export const WEBHOOK_BATCH = 20;
/** How long a webhook's window lasts: `--max-per-hour` caps the delivery requests in one. */
export const WEBHOOK_WINDOW_MS = 60 * 60 * 1000;
/** Requests a pass has in flight at once. */
const WEBHOOK_CONCURRENCY = 4;

export interface SendOptions {
  timeoutMs?: number;
  maxAttempts?: number;
  batch?: number;
  /** Once aborted, no further delivery is claimed; requests already sent run to their end or their timeout. */
  signal?: AbortSignal;
}

/** `options` with defaults filled in; throws for a value that is not a positive integer, so a pass is always bounded. */
export function sendOptions(options: Omit<SendOptions, "signal">): Required<Omit<SendOptions, "signal">> {
  const resolved = {
    timeoutMs: options.timeoutMs ?? WEBHOOK_TIMEOUT_MS,
    maxAttempts: options.maxAttempts ?? WEBHOOK_MAX_ATTEMPTS,
    batch: options.batch ?? WEBHOOK_BATCH,
  };
  for (const [key, value] of Object.entries(resolved)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${key} must be a positive integer`);
  }
  return resolved;
}

/**
 * One pass over the queue: claims up to `batch` pending deliveries, oldest first, and POSTs each one's body to its own
 * webhook's URL, signed with its secret in `X-Message-CP-Signature`, with the webhook's own header if it has one. A 2xx answer delivers it; anything else, a
 * network error or the timeout is a failed attempt, retried on a later pass. Redirects are not followed.
 * An attempt is counted when the row is claimed, before the request, so two senders on one file never send the same
 * attempt. The claim also records until when that request may still be in flight (twice the claiming sender's own
 * `timeoutMs`, leaving room to record the answer), and no sender, whatever its own timeout, takes the row before then.
 * A webhook with a limit gets at most that many requests, retries included, per fixed window of `WEBHOOK_WINDOW_MS`: a
 * window starts with the first request claimed after the last one ended. The pass leaves out the rows a webhook has no
 * allowance left for, so its batch fills with other webhooks' rows; those rows stay pending, with no attempt used, and go
 * out in a later window, oldest first. The allowance is checked again, and used, in the transaction that claims the row,
 * so two senders on one file never go past it together.
 * Nothing about a delivery is logged: its body, secret, URL and header value are all private. Nor is a webhook at its limit.
 */
export async function sendPending(db: Db, options: SendOptions = {}): Promise<{ delivered: number; failed: number }> {
  const { timeoutMs, maxAttempts, batch } = sendOptions(options);
  const now = Date.now();
  // `n` numbers each webhook's pending rows, oldest first; a row is left out past what is left of its webhook's allowance.
  const rows = db
    .prepare(
      `SELECT id, attempts, webhook_id, url, secret, header_name, header_value FROM (
         SELECT d.id, d.attempts, d.webhook_id, w.url, w.secret, w.header_name, w.header_value,
                CASE WHEN w.max_per_hour IS NULL THEN NULL
                     WHEN w.window_started_at IS NULL OR w.window_started_at + ? <= ? THEN w.max_per_hour
                     ELSE w.max_per_hour - w.window_count END AS allowance,
                ROW_NUMBER() OVER (PARTITION BY d.webhook_id ORDER BY d.id) AS n
         FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id
         WHERE d.delivered_at IS NULL AND d.attempts < ? AND (d.claimed_until IS NULL OR d.claimed_until <= ?)
       )
       WHERE allowance IS NULL OR n <= allowance
       ORDER BY id LIMIT ?`,
    )
    .all(WEBHOOK_WINDOW_MS, now, maxAttempts, now, batch) as {
    id: number;
    attempts: number;
    webhook_id: number;
    url: string;
    secret: string;
    header_name: string | null;
    header_value: string | null;
  }[];
  const claim = db.prepare(
    "UPDATE webhook_deliveries SET attempts = attempts + 1, claimed_until = ? WHERE id = ? AND attempts = ? AND delivered_at IS NULL",
  );
  const window = db.prepare("SELECT max_per_hour, window_started_at, window_count FROM webhooks WHERE id = ?");
  const use = db.prepare("UPDATE webhooks SET window_started_at = ?, window_count = ? WHERE id = ?");
  // Claims the row if its webhook has allowance left, using one request of it; true if claimed.
  const claimWithin = db.transaction((row: (typeof rows)[number]): boolean => {
    const w = window.get(row.webhook_id) as { max_per_hour: number | null; window_started_at: number | null; window_count: number } | undefined;
    if (!w) return false;
    const at = Date.now();
    const fresh = w.window_started_at === null || w.window_started_at + WEBHOOK_WINDOW_MS <= at;
    if (w.max_per_hour !== null && !fresh && w.window_count >= w.max_per_hour) return false;
    if (claim.run(at + 2 * timeoutMs, row.id, row.attempts).changes !== 1) return false;
    if (w.max_per_hour !== null) use.run(fresh ? at : w.window_started_at, fresh ? 1 : w.window_count + 1, row.webhook_id);
    return true;
  });
  const done = db.prepare("UPDATE webhook_deliveries SET delivered_at = ? WHERE id = ?");
  let delivered = 0;
  let failed = 0;

  const send = async (row: (typeof rows)[number]) => {
    if (!claimWithin.immediate(row)) return;
    let href: string;
    try {
      href = webhookUrl(row.url);
    } catch {
      // Stored before the check was what it is now: the attempt is used without a request.
      failed++;
      return;
    }
    const body = deliveryBody(db, row.id);
    if (!body) return;
    const text = JSON.stringify(body);
    let ok = false;
    try {
      const res = await fetch(href, {
        method: "POST",
        headers: {
          ...(row.header_name !== null ? { [row.header_name]: row.header_value! } : {}),
          "Content-Type": "application/json",
          "X-Message-CP-Signature": `sha256=${createHmac("sha256", row.secret).update(text).digest("hex")}`,
        },
        body: text,
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
      ok = res.status >= 200 && res.status < 300;
      await res.body?.cancel();
    } catch {
      // A network error or the timeout; the answer, if any, is only read for its status.
    }
    if (ok) {
      done.run(Date.now(), row.id);
      delivered++;
    } else {
      failed++;
    }
  };

  let next = 0;
  let error: unknown;
  const worker = async () => {
    while (next < rows.length && error === undefined && !options.signal?.aborted) {
      try {
        await send(rows[next++]!);
      } catch (err) {
        error ??= err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(WEBHOOK_CONCURRENCY, rows.length) }, worker));
  if (error !== undefined) throw error;
  return { delivered, failed };
}
