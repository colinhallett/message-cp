import { randomBytes } from "node:crypto";
import { NAME_PATTERN } from "./agents.js";
import type { AccountId, Db } from "./db.js";

// Outgoing webhooks. The operator manages them with `message-cp webhook` on the server; no agent or token can.
// Nothing is delivered yet. A webhook's secret is shown once, when it is added, and stored as is so that deliveries
// can sign with it.

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

/** Parses `--on`: `#<channel>`, `mention:<agent>` or `agent:<agent>`, each name following the agent-name rules. */
export function webhookOn(on: string): { event: WebhookEvent; name: string } {
  const [, prefix, name] = /^(#|mention:|agent:)(.*)$/s.exec(on) ?? [];
  if (prefix === undefined || !NAME_PATTERN.test(name!)) {
    throw new WebhookError("Invalid --on: use #<channel>, mention:<agent> or agent:<agent>, names of 1-32 letters, digits, '-' and '_'.");
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
