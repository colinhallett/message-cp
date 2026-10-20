import { createHmac, randomBytes } from "node:crypto";
import { NAME_PATTERN } from "./agents.js";
import type { AccountId, Db } from "./db.js";

// Outgoing webhooks. The operator manages them with `message-cp webhook` on the server; no agent or token can.
// Messages and posts a webhook is for are queued in `webhook_deliveries` when they are stored, and `serve` sends them
// with `sendPending`: each body signed with the webhook's secret, a timeout and a few attempts. The stdio server and
// `message-cp wait` send nothing. A webhook's secret is shown once, when it is added, and stored as is so that
// deliveries can sign with it.

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

/** How `--on` names a webhook's event, for printing. */
export const formatOn = (w: Pick<Webhook, "event" | "name">) => (w.event === "channel" ? `#${w.name}` : `${w.event}:${w.name}`);

/** Adds a webhook to the account named `account`, with a new secret. */
export const addWebhook = (db: Db, account: string, url: string, on: string, includeText: boolean): NewWebhook =>
  db.transaction((): NewWebhook => {
    const href = webhookUrl(url);
    const { event, name } = webhookOn(on);
    const row = db.prepare("SELECT id, name FROM accounts WHERE name = ?").get(account) as { id: AccountId; name: string } | undefined;
    if (!row) throw new WebhookError(`No account named '${account}'.`);
    const secret = randomBytes(32).toString("hex");
    const { id } = db
      .prepare(
        "INSERT INTO webhooks (account_id, url, event, name, include_text, secret, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
      )
      .get(row.id, href, event, name, includeText ? 1 : 0, secret, Date.now()) as { id: number };
    return { id, account: row.name, url: href, event, name, includeText, secret };
  }).immediate();

/** The webhooks of the account named `account`, or of every account without it; never their secrets. */
export function listWebhooks(db: Db, account?: string): Webhook[] {
  if (account !== undefined && !db.prepare("SELECT 1 FROM accounts WHERE name = ?").get(account)) {
    throw new WebhookError(`No account named '${account}'.`);
  }
  const rows = db
    .prepare(
      `SELECT webhooks.id, accounts.name AS account, url, event, webhooks.name, include_text
       FROM webhooks JOIN accounts ON accounts.id = webhooks.account_id
       WHERE ? IS NULL OR accounts.name = ? ORDER BY webhooks.id`,
    )
    .all(account ?? null, account ?? null) as (Omit<Webhook, "includeText"> & { include_text: number })[];
  return rows.map(({ include_text, ...w }) => ({ ...w, includeText: include_text === 1 }));
}

/** Deletes the webhook `id`. Returns the account it belonged to. */
export function removeWebhook(db: Db, id: number): string {
  const row = db
    .prepare("DELETE FROM webhooks WHERE id = ? RETURNING (SELECT name FROM accounts WHERE accounts.id = webhooks.account_id) AS account")
    .get(id) as { account: string } | undefined;
  if (!row) throw new WebhookError(`No webhook with id ${id}.`);
  return row.account;
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
 * webhook's URL, signed with its secret in `X-Message-CP-Signature`. A 2xx answer delivers it; anything else, a
 * network error or the timeout is a failed attempt, retried on a later pass. Redirects are not followed.
 * An attempt is counted when the row is claimed, before the request, so two senders on one file never send the same
 * attempt. The claim also records until when that request may still be in flight (twice the claiming sender's own
 * `timeoutMs`, leaving room to record the answer), and no sender, whatever its own timeout, takes the row before then.
 * Nothing about a delivery is logged: its body, secret and URL are all private.
 */
export async function sendPending(db: Db, options: SendOptions = {}): Promise<{ delivered: number; failed: number }> {
  const { timeoutMs, maxAttempts, batch } = sendOptions(options);
  const rows = db
    .prepare(
      `SELECT d.id, d.attempts, w.url, w.secret FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id
       WHERE d.delivered_at IS NULL AND d.attempts < ? AND (d.claimed_until IS NULL OR d.claimed_until <= ?)
       ORDER BY d.delivered_at, d.id LIMIT ?`,
    )
    .all(maxAttempts, Date.now(), batch) as { id: number; attempts: number; url: string; secret: string }[];
  const claim = db.prepare(
    "UPDATE webhook_deliveries SET attempts = attempts + 1, claimed_until = ? WHERE id = ? AND attempts = ? AND delivered_at IS NULL",
  );
  const done = db.prepare("UPDATE webhook_deliveries SET delivered_at = ? WHERE id = ?");
  let delivered = 0;
  let failed = 0;

  const send = async (row: (typeof rows)[number]) => {
    if (claim.run(Date.now() + 2 * timeoutMs, row.id, row.attempts).changes !== 1) return;
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
