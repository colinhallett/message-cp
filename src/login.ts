import { createHash, randomBytes } from "node:crypto";
import { accountName, issueToken, type ApprovedClient, type TokenInfo } from "./accounts.js";
import { KeyResetError, PersonError, PurgeError, addPerson, purgeAgent, removePerson, resetAgentKey, setPersonAdmin, type Purged } from "./agents.js";
import { publicUrl } from "./connect.js";
import type { AccountId, Db } from "./db.js";
import { addWebhook, formatOn, type WebhookEvent } from "./webhooks.js";

// `message-cp login-link`: a dashboard link carrying a one-time code, made on the server, that signs a browser in as the
// account's owner (a full token) or as one of its people (a person token), so nobody copies a token. The code is
// printed once, by the CLI, and stored only as a hash; POST /api/login redeems it once for a new token, which
// `token list` shows and `token revoke` stops like any other, and gives the browser a sign-in session for that token
// rather than the token itself. Nothing here logs anything.
//
// An invite is the same kind of code, for a person, made by an admin person's token over HTTP (POST /api/people and
// /api/invites) rather than on the server. It lasts INVITE_TTL_MS, is listed (never its code) until it is used, cancelled
// or expires, and can be cancelled.

export class LoginError extends Error {}

/** The admin person a token acts as was removed, or is no longer an admin, by the time their request was carried out. */
export class NotAdminError extends Error {
  constructor() {
    super("This person is no longer an admin of the account");
  }
}

/**
 * Inside the caller's transaction: refuses with `NotAdminError` unless `admin`, an admin person token's person, is
 * still a live admin of `account`, found by row. The token was checked when the request began, but its body is read
 * after, and the person may have been removed or unmarked meanwhile.
 */
function requireAdmin(db: Db, account: AccountId, admin: number): void {
  const live = db
    .prepare("SELECT 1 FROM agents WHERE id = ? AND account_id = ? AND person = 1 AND admin = 1 AND removed_at IS NULL")
    .get(admin, account);
  if (!live) throw new NotAdminError();
}

/** Why a code gave no token: used once already, an invite cancelled, or unknown, expired, or for a person no longer live. */
export class LoginRefused extends Error {
  constructor(readonly reason: "used" | "cancelled" | "invalid") {
    super(
      reason === "used" ? "This link was already used." : reason === "cancelled" ? "This link was cancelled." : "This link has expired or is not valid.",
    );
  }
}

/** `login-link` codes not yet used or expired, kept at once across the server; past this a new one is refused. */
export const MAX_LOGIN_CODES = 1000;
/**
 * Invites one account has made that have not expired, used and cancelled ones included; past this its next is refused.
 * Counted per account, apart from MAX_LOGIN_CODES, so no account's invites refuse another's or `login-link`, and counting
 * cancelled ones too keeps a loop of making and cancelling from growing the table.
 */
export const MAX_INVITES_PER_ACCOUNT = 100;
/** How long a link works once it is made. */
export const LOGIN_CODE_TTL_MS = 5 * 60 * 1000;
/** How long an invite works once it is made. */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CODE = /^[0-9a-f]{64}$/;

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * The dashboard's address for the public URL `raw`, checked by `publicUrl` as `connect --url` and `serve --public-url`
 * are: its path with a trailing `/`, a trailing `/mcp` being the same as none, as for `mcpEndpoint`. Set on the parsed
 * URL, never appended to the string.
 */
export function dashboardUrl(raw: string): URL {
  const url = publicUrl(raw);
  const dashboard = new URL(url.href);
  dashboard.pathname = `${url.pathname.replace(/\/+$/, "").replace(/\/mcp$/, "")}/`;
  return dashboard;
}

/** The link for `code` at the dashboard `base`: the code in the fragment, which a browser never sends in a request. */
export function loginLink(base: URL, code: string): URL {
  const link = new URL(base.href);
  link.hash = `code=${code}`;
  return link;
}

export interface LoginCode {
  code: string;
  account: string;
  /** The stored name of the person the link signs in as, if any. */
  person?: string;
  expiresAt: number;
}

/**
 * A new code for the account named `account`, signing in as its live person `person` (any case) if given, else with a
 * full token of the account. One transaction: deletes expired codes, refuses past MAX_LOGIN_CODES, an unknown account,
 * and a person name that is unknown, removed or an agent's, then stores the code's hash with its expiry.
 */
export const makeLoginCode = (db: Db, account: string, person?: string, now = Date.now()): LoginCode =>
  db.transaction((): LoginCode => {
    const acct = db.prepare("SELECT id, name FROM accounts WHERE name = ?").get(account) as { id: AccountId; name: string } | undefined;
    if (!acct) throw new LoginError(`No account named '${account}'.`);
    let bound: { id: number; name: string } | undefined;
    if (person !== undefined) {
      const live = db
        .prepare("SELECT id, name, person FROM agents WHERE account_id = ? AND name = ? AND removed_at IS NULL")
        .get(acct.id, person) as { id: number; name: string; person: number } | undefined;
      if (live?.person === 0) throw new LoginError(`The name '${live.name}' belongs to an agent, not a person.`);
      if (!live) throw new LoginError(`No person named '${person}' in account '${acct.name}'.`);
      bound = { id: live.id, name: live.name };
    }
    const { code, expiresAt } = storeCode(db, acct.id, bound?.id ?? null, false, now);
    return { code, account: acct.name, ...(bound && { person: bound.name }), expiresAt };
  }).immediate();

/**
 * Inside the caller's transaction: deletes expired codes, then stores the hash of a new code for `account` (and
 * `person`, if not null): with `invite`, an invite lasting INVITE_TTL_MS, refused past MAX_INVITES_PER_ACCOUNT; else a
 * `login-link` code lasting LOGIN_CODE_TTL_MS, refused past MAX_LOGIN_CODES.
 */
function storeCode(db: Db, account: AccountId, person: number | null, invite: boolean, now: number): { id: number; code: string; expiresAt: number } {
  db.prepare("DELETE FROM login_codes WHERE expires_at <= ?").run(now);
  if (invite) {
    const made = db.prepare("SELECT count(*) FROM login_codes WHERE invite = 1 AND account_id = ?").pluck().get(account) as number;
    if (made >= MAX_INVITES_PER_ACCOUNT) {
      throw new LoginError(`This account has made ${MAX_INVITES_PER_ACCOUNT} invites in the last 7 days; try again once some expire.`);
    }
  } else {
    const pending = db.prepare("SELECT count(*) FROM login_codes WHERE invite = 0 AND used_at IS NULL").pluck().get() as number;
    if (pending >= MAX_LOGIN_CODES) throw new LoginError(`There are already ${MAX_LOGIN_CODES} unused links; try again once some expire.`);
  }
  const code = randomBytes(32).toString("hex");
  const expiresAt = now + (invite ? INVITE_TTL_MS : LOGIN_CODE_TTL_MS);
  const id = db
    .prepare("INSERT INTO login_codes (code_hash, account_id, person_id, expires_at, invite, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id")
    .pluck()
    .get(sha256(code), account, person, expiresAt, invite ? 1 : 0, now) as number;
  return { id, code, expiresAt };
}

/** A new invite: its id, its code, which only its maker is ever shown, and when it expires, in ms. */
export interface Invite {
  id: number;
  code: string;
  expiresAt: number;
}

/** An admin person adding a person: the person as stored, and their first invite. */
export interface InvitedPerson {
  name: string;
  admin: boolean;
  invite: Invite;
}

/**
 * For POST /api/people: adds the person `name`, an admin with `admin`, to the account `account` as `addPerson` does,
 * and makes their first invite, in one transaction, so a refused name or a refused invite stores neither. `by` is the
 * row of the admin person asking. Throws `NotAdminError` unless they are still a live admin of the account, `PersonError`
 * as `addPerson` does and `LoginError` past MAX_INVITES_PER_ACCOUNT.
 */
export const addInvitedPerson = (db: Db, account: AccountId, by: number, name: string, admin: boolean, now = Date.now()): InvitedPerson =>
  db.transaction((): InvitedPerson => {
    requireAdmin(db, account, by);
    const acct = db.prepare("SELECT name FROM accounts WHERE id = ?").pluck().get(account) as string | undefined;
    if (acct === undefined) throw new PersonError("No such account.");
    // A nested transaction is a savepoint inside this one.
    const person = addPerson(db, acct, name, admin);
    const id = db
      .prepare("SELECT id FROM agents WHERE account_id = ? AND name = ? AND removed_at IS NULL AND person = 1")
      .pluck()
      .get(account, person.name) as number;
    const { code, expiresAt, id: invite } = storeCode(db, account, id, true, now);
    return { name: person.name, admin: person.admin, invite: { id: invite, code, expiresAt } };
  }).immediate();

/**
 * For POST /api/invites: a new invite for the live person `person` (any case) of the account `account`, or undefined,
 * storing nothing, for a name no live person of the account has, an agent's included. Earlier invites stay as they are.
 * `by` is the row of the admin person asking. Throws `NotAdminError` unless they are still a live admin of the account,
 * and `LoginError` past MAX_INVITES_PER_ACCOUNT.
 */
export const makeInvite = (db: Db, account: AccountId, by: number, person: string, now = Date.now()): InvitedPerson | undefined =>
  db.transaction(() => {
    requireAdmin(db, account, by);
    const live = db
      .prepare("SELECT id, name, admin FROM agents WHERE account_id = ? AND name = ? AND removed_at IS NULL AND person = 1")
      .get(account, person) as { id: number; name: string; admin: number } | undefined;
    if (!live) return undefined;
    const { id, code, expiresAt } = storeCode(db, account, live.id, true, now);
    return { name: live.name, admin: live.admin === 1, invite: { id, code, expiresAt } };
  }).immediate();

/** An admin person unmarking or removing their own person, which they leave to another admin or the server. */
export class OwnPersonError extends Error {
  constructor() {
    super("An admin cannot unmark or remove themselves. Ask another admin, or run message-cp person on the server");
  }
}

/**
 * Inside the caller's transaction: the account's name, after refusing with `NotAdminError` unless `by` is still a live
 * admin of `account`, and the row of its live person `name` (any case), or undefined for a name no live person of the
 * account has, an agent's included.
 */
function personOf(db: Db, account: AccountId, by: number, name: string): { account: string; id: number } | undefined {
  requireAdmin(db, account, by);
  const id = db
    .prepare("SELECT id FROM agents WHERE account_id = ? AND name = ? AND removed_at IS NULL AND person = 1")
    .pluck()
    .get(account, name) as number | undefined;
  if (id === undefined) return undefined;
  return { account: db.prepare("SELECT name FROM accounts WHERE id = ?").pluck().get(account) as string, id };
}

/**
 * For PATCH /api/people: marks the live person `name` (any case) of the account `account` an admin, or unmarks them
 * with `admin` false, as `setPersonAdmin` does, or answers undefined, changing nothing, for a name no live person of the
 * account has. `by` is the row of the admin person asking. Throws `NotAdminError` unless they are still a live admin of
 * the account, and `OwnPersonError` if they would unmark themselves.
 */
export const setAdminBy = (db: Db, account: AccountId, by: number, name: string, admin: boolean): { name: string; admin: boolean } | undefined =>
  db.transaction(() => {
    const person = personOf(db, account, by, name);
    if (person === undefined) return undefined;
    if (person.id === by && !admin) throw new OwnPersonError();
    // A nested transaction is a savepoint inside this one.
    const marked = setPersonAdmin(db, person.account, name, admin);
    return { name: marked.name, admin: marked.admin };
  }).immediate();

/**
 * For DELETE /api/people: removes the live person `name` (any case) of the account `account` as `removePerson` does,
 * or answers undefined, changing nothing, for a name no live person of the account has. `by` is the row of the admin
 * person asking. Throws `NotAdminError` unless they are still a live admin of the account, and `OwnPersonError` if they
 * would remove themselves.
 */
export const removePersonBy = (db: Db, account: AccountId, by: number, name: string): Purged | undefined =>
  db.transaction(() => {
    const person = personOf(db, account, by, name);
    if (person === undefined) return undefined;
    if (person.id === by) throw new OwnPersonError();
    return removePerson(db, person.account, name);
  }).immediate();

/** A live person of an account as GET /api/people lists them. */
export interface AccountPerson {
  name: string;
  admin: boolean;
  addedAt: string;
}

/** One page of the account's live people, by name. Found by the account's id only, so it never names another account's. */
export function listAccountPeople(db: Db, account: AccountId, limit: number, offset: number): AccountPerson[] {
  const rows = db
    .prepare(
      "SELECT name, admin, registered_at FROM agents WHERE account_id = ? AND person = 1 AND removed_at IS NULL ORDER BY name LIMIT ? OFFSET ?",
    )
    .all(account, limit, offset) as { name: string; admin: number; registered_at: number }[];
  return rows.map((r) => ({ name: r.name, admin: r.admin === 1, addedAt: new Date(r.registered_at).toISOString() }));
}

/** An agent removed by an admin person: its name and how many direct messages and mentions went with it. */
export interface RemovedAgent {
  name: string;
  messages: number;
  mentions: number;
}

/**
 * For DELETE /api/agents: removes the agent `name` (any case) of the account `account`, live or only left as removed
 * rows, as `purgeAgent` does, or answers undefined, changing nothing, for a name no agent of the account has had, a live
 * person's included. `by` is the row of the admin person asking. Throws `NotAdminError` unless they are still a live
 * admin of the account.
 */
export const removeAgentBy = (db: Db, account: AccountId, by: number, name: string): RemovedAgent | undefined =>
  db.transaction(() => {
    requireAdmin(db, account, by);
    const acct = db.prepare("SELECT name FROM accounts WHERE id = ?").pluck().get(account) as string | undefined;
    if (acct === undefined) return undefined;
    try {
      // A nested transaction is a savepoint inside this one.
      const purged = purgeAgent(db, acct, name);
      return { name: purged.name, messages: purged.messages, mentions: purged.mentions };
    } catch (err) {
      if (err instanceof PurgeError) return undefined;
      throw err;
    }
  }).immediate();

/**
 * For POST /api/agents/key: gives the live agent `name` (any case) of the account `account` a new key as
 * `resetAgentKey` does, ending its sessions, and answers its name and the key, or undefined, changing nothing, for a
 * name no live agent of the account has, a person's included. `by` is the row of the admin person asking. Throws
 * `NotAdminError` unless they are still a live admin of the account.
 */
export const resetAgentKeyBy = (db: Db, account: AccountId, by: number, name: string): { name: string; key: string } | undefined =>
  db.transaction(() => {
    requireAdmin(db, account, by);
    const acct = db.prepare("SELECT name FROM accounts WHERE id = ?").pluck().get(account) as string | undefined;
    if (acct === undefined) return undefined;
    try {
      const reset = resetAgentKey(db, acct, name);
      return { name: reset.name, key: reset.key };
    } catch (err) {
      if (err instanceof KeyResetError) return undefined;
      throw err;
    }
  }).immediate();

/**
 * A webhook as GET /api/webhooks lists it: its URL's origin only, since the path can carry a credential, and never its
 * secret, header value or fixed body.
 */
export interface AccountWebhook {
  id: number;
  /** As `formatOn` prints it. */
  on: string;
  origin: string;
  includeText: boolean;
  headerName: string | null;
  maxPerHour: number | null;
  fixedBody: boolean;
}

/**
 * For GET /api/webhooks: one page of the account's webhooks, oldest first. `by` is the row of the admin person asking.
 * Throws `NotAdminError` unless they are still a live admin of the account.
 */
export const listWebhooksBy = (db: Db, account: AccountId, by: number, limit: number, offset: number): AccountWebhook[] =>
  db.transaction(() => {
    requireAdmin(db, account, by);
    const rows = db
      .prepare(
        `SELECT id, url, event, name, include_text, header_name, max_per_hour, fixed_body IS NOT NULL AS fixed
         FROM webhooks WHERE account_id = ? ORDER BY id LIMIT ? OFFSET ?`,
      )
      .all(account, limit, offset) as {
      id: number;
      url: string;
      event: WebhookEvent;
      name: string;
      include_text: number;
      header_name: string | null;
      max_per_hour: number | null;
      fixed: number;
    }[];
    return rows.map((r) => ({
      id: r.id,
      on: formatOn(r),
      origin: new URL(r.url).origin,
      includeText: r.include_text === 1,
      headerName: r.header_name,
      maxPerHour: r.max_per_hour,
      fixedBody: r.fixed === 1,
    }));
  }).immediate();

/** What POST /api/webhooks takes: `addWebhook`'s arguments past the account. */
export interface WebhookInput {
  url: string;
  on: string;
  includeText: boolean;
  header?: string;
  maxPerHour?: number;
  body?: string;
}

/**
 * For POST /api/webhooks: adds a webhook to the account as `addWebhook` does, with its checks, and answers it as GET
 * /api/webhooks lists it plus its secret, shown this once. `by` is the row of the admin person asking. Throws
 * `NotAdminError` unless they are still a live admin of the account, and `WebhookError` for anything `addWebhook`
 * refuses, adding nothing either way.
 */
export const addWebhookBy = (db: Db, account: AccountId, by: number, w: WebhookInput): AccountWebhook & { secret: string } =>
  db.transaction(() => {
    requireAdmin(db, account, by);
    // Inside this transaction addWebhook's own runs as a savepoint.
    const added = addWebhook(db, accountName(db, account), w.url, w.on, w.includeText, w.header, w.maxPerHour, w.body);
    return {
      id: added.id,
      on: formatOn(added),
      origin: new URL(added.url).origin,
      includeText: added.includeText,
      headerName: added.headerName,
      maxPerHour: added.maxPerHour,
      fixedBody: added.fixedBody,
      secret: added.secret,
    };
  }).immediate();

/**
 * For DELETE /api/webhooks: deletes the account's webhook `id`, its queued and past deliveries going with it through
 * `ON DELETE CASCADE`, and answers its id and how many deliveries went, or undefined, changing nothing, for an id the
 * account has no webhook with, another account's included. `by` is the row of the admin person asking. Throws
 * `NotAdminError` unless they are still a live admin of the account.
 */
export const removeWebhookBy = (db: Db, account: AccountId, by: number, id: number): { id: number; deliveries: number } | undefined =>
  db.transaction(() => {
    requireAdmin(db, account, by);
    if (!db.prepare("SELECT 1 FROM webhooks WHERE id = ? AND account_id = ?").get(id, account)) return undefined;
    const deliveries = db.prepare("SELECT count(*) FROM webhook_deliveries WHERE webhook_id = ?").pluck().get(id) as number;
    db.prepare("DELETE FROM webhooks WHERE id = ? AND account_id = ?").run(id, account);
    return { id, deliveries };
  }).immediate();

/**
 * For DELETE /api/approvals: revokes the account's unrevoked token `id` that the OAuth code exchange issued, as `token
 * revoke` does, keeping the agents it acted as or registered, and answers its id, or undefined, changing nothing, for
 * any other id: another account's token, one not issued through OAuth, one already revoked, or an unknown one. `by` is
 * the row of the admin person asking. Throws `NotAdminError` unless they are still a live admin of the account.
 */
export const revokeApprovalBy = (db: Db, account: AccountId, by: number, id: number): { id: number } | undefined =>
  db.transaction(() => {
    requireAdmin(db, account, by);
    const changed = db
      .prepare("UPDATE tokens SET revoked_at = ? WHERE id = ? AND account_id = ? AND oauth = 1 AND revoked_at IS NULL")
      .run(Date.now(), id, account).changes;
    return changed === 0 ? undefined : { id };
  }).immediate();

/** An unrevoked token, as GET /api/tokens lists it: never the token or its hash. */
export interface AccountToken {
  id: number;
  kind: TokenInfo["kind"];
  /** For a person token, its person's name, or null once that person was removed, as the token then no longer works. */
  person?: string | null;
  /** For an agent token bound to an agent, that agent's name, or null once the agent was removed, as the token then no longer works. */
  agent?: string | null;
  /** For an agent token that registers its own agents. */
  registers?: true;
  /** For a token the OAuth code exchange issued, the client it was issued to, as `token list` shows it. */
  client?: ApprovedClient;
  createdAt: string;
  /** As `token list` gives it: when a request last used it, to within a minute, or null until a request is recorded. */
  lastUsedAt: string | null;
}

/**
 * For GET /api/tokens: one page of the account's unrevoked tokens, oldest first, each with its kind as `token list`
 * gives it. `MESSAGE_CP_HTTP_TOKEN` has no row, so it is never listed. `by` is the row of the admin person asking.
 * Throws `NotAdminError` unless they are still a live admin of the account.
 */
export const listTokensBy = (db: Db, account: AccountId, by: number, limit: number, offset: number): AccountToken[] =>
  db.transaction(() => {
    requireAdmin(db, account, by);
    // The bound agent and person are looked for in the token's own account, and only while live, as `accountForToken`
    // accepts them.
    const rows = db
      .prepare(
        `SELECT tokens.id, tokens.read_only, tokens.agent_only, tokens.agent_id, tokens.person_id, tokens.registers,
           tokens.created_at, tokens.oauth, tokens.client_name, tokens.client_host, tokens.last_used_at, agents.name AS agent,
           people.name AS person
         FROM tokens LEFT JOIN agents ON agents.id = tokens.agent_id AND agents.account_id = tokens.account_id
           AND agents.removed_at IS NULL AND agents.person = 0
         LEFT JOIN agents people ON people.id = tokens.person_id AND people.account_id = tokens.account_id
           AND people.removed_at IS NULL AND people.person = 1
         WHERE tokens.account_id = ? AND tokens.revoked_at IS NULL ORDER BY tokens.id LIMIT ? OFFSET ?`,
      )
      .all(account, limit, offset) as {
      id: number;
      read_only: number;
      agent_only: number;
      agent_id: number | null;
      person_id: number | null;
      registers: number;
      created_at: number;
      oauth: number | null;
      client_name: string | null;
      client_host: string | null;
      last_used_at: number | null;
      agent: string | null;
      person: string | null;
    }[];
    return rows.map((r): AccountToken => ({
      id: r.id,
      // As `listTokens`: a person token's row has read_only set too (see `issueToken`), so its person comes first.
      kind: r.person_id !== null ? "person" : r.agent_only === 1 ? "agent" : r.read_only === 1 ? "read-only" : "full",
      ...(r.person_id !== null && { person: r.person }),
      ...(r.agent_id !== null && { agent: r.agent }),
      // Only in the shape `accountForToken` accepts as registering.
      ...(r.registers === 1 && r.agent_only === 1 && r.agent_id === null && { registers: true as const }),
      ...(r.oauth === 1 && { client: { name: r.client_name, host: r.client_host } }),
      createdAt: new Date(r.created_at).toISOString(),
      lastUsedAt: r.last_used_at === null ? null : new Date(r.last_used_at).toISOString(),
    }));
  }).immediate();

/** A token POST /api/tokens made: the only time its raw token is shown. */
export interface MadeToken {
  id: number;
  kind: "read-only" | "agent";
  token: string;
}

/**
 * For POST /api/tokens: makes a new read-only or agent token for `account`, unbound, as `token add --read-only` and
 * `token add --agent-only` make them, and answers it once. `by` is the row of the admin person asking. Throws
 * `NotAdminError`, making nothing, unless they are still a live admin of the account.
 */
export const addTokenBy = (db: Db, account: AccountId, by: number, kind: MadeToken["kind"]): MadeToken =>
  db.transaction((): MadeToken => {
    requireAdmin(db, account, by);
    const { id, token } = issueToken(db, account, kind === "read-only", kind === "agent");
    return { id, kind, token };
  }).immediate();

/**
 * For DELETE /api/tokens: revokes the account's unrevoked token `id` of any kind, as `token revoke` does, the token the
 * request carries included, and answers its id with `signins`, how many of its dashboard sign-ins (`dashboard_sessions`)
 * `accountForToken` still accepted just before and refuses from now on, or undefined, changing and counting nothing, for
 * another account's token, one already revoked, or an unknown one. A person token whose person is no longer a live
 * person of its account counts 0, as its sign-ins were already refused. Its session rows are kept: `accountForToken`
 * refuses them through the revoked token. `by` is the row of the admin person asking. Throws `NotAdminError` unless
 * they are still a live admin of the account.
 */
export const revokeTokenBy = (db: Db, account: AccountId, by: number, id: number): { id: number; signins: number } | undefined =>
  db.transaction(() => {
    requireAdmin(db, account, by);
    const changed = db
      .prepare("UPDATE tokens SET revoked_at = ? WHERE id = ? AND account_id = ? AND revoked_at IS NULL")
      .run(Date.now(), id, account).changes;
    if (changed === 0) return undefined;
    return { id, signins: db.prepare(COUNT_SIGNINS).pluck().get(id) as number };
  }).immediate();

/**
 * Counts the dashboard sign-ins of the token with the bound id that `accountForToken` would accept but for its revoke:
 * none for a single-agent token whose agent is gone or a person token whose person is gone, as `accountForToken`
 * refuses those, with the agent and the person found in the token's own account under the same conditions. Searched
 * through the token's primary key and `dashboard_sessions_by_token`, never by scanning sessions.
 */
export const COUNT_SIGNINS = `SELECT COUNT(*) FROM tokens JOIN dashboard_sessions ON dashboard_sessions.token_id = tokens.id
  LEFT JOIN agents ON agents.id = tokens.agent_id AND agents.account_id = tokens.account_id
    AND agents.removed_at IS NULL AND agents.person = 0
  LEFT JOIN agents people ON people.id = tokens.person_id AND people.account_id = tokens.account_id
    AND people.removed_at IS NULL AND people.person = 1
  WHERE tokens.id = ? AND (tokens.agent_id IS NULL OR agents.id IS NOT NULL) AND (tokens.person_id IS NULL OR people.id IS NOT NULL)`;

/** A live dashboard sign-in, as GET /api/signins lists it: never its session id, its hash or its token. */
export interface AccountSignin {
  /** The `dashboard_sessions` row id, which is not a credential. */
  id: number;
  tokenId: number;
  kind: "full" | "person";
  /** For a person token, its person's name. */
  person?: string;
  createdAt: string;
  /** Only on the sign-in the request itself carries. */
  current?: true;
}

// A sign-in is live while `accountForToken` would accept it: its token is unrevoked and, for a person token, its person
// is still a live person of the token's own account, found by row. Login codes only make full and person tokens.
const LIVE_SIGNIN_TOKEN = `tokens.account_id = ? AND tokens.revoked_at IS NULL AND (tokens.person_id IS NULL OR people.id IS NOT NULL)`;
const SIGNIN_PEOPLE = `LEFT JOIN agents people ON people.id = tokens.person_id AND people.account_id = tokens.account_id
  AND people.removed_at IS NULL AND people.person = 1`;

/**
 * For GET /api/signins: one page of the account's live dashboard sign-ins, oldest first, with `current` on the one whose
 * row id is `current`, the request's own. `by` is the row of the admin person asking. Throws `NotAdminError` unless they
 * are still a live admin of the account.
 */
export const listSigninsBy = (db: Db, account: AccountId, by: number, current: number | undefined, limit: number, offset: number): AccountSignin[] =>
  db.transaction(() => {
    requireAdmin(db, account, by);
    const rows = db
      .prepare(
        `SELECT dashboard_sessions.id, dashboard_sessions.token_id, dashboard_sessions.created_at, tokens.person_id, people.name AS person
         FROM dashboard_sessions JOIN tokens ON tokens.id = dashboard_sessions.token_id ${SIGNIN_PEOPLE}
         WHERE ${LIVE_SIGNIN_TOKEN} ORDER BY dashboard_sessions.id LIMIT ? OFFSET ?`,
      )
      .all(account, limit, offset) as { id: number; token_id: number; created_at: number; person_id: number | null; person: string | null }[];
    return rows.map((r): AccountSignin => ({
      id: r.id,
      tokenId: r.token_id,
      kind: r.person_id !== null ? "person" : "full",
      ...(r.person !== null && { person: r.person }),
      createdAt: new Date(r.created_at).toISOString(),
      ...(r.id === current && { current: true as const }),
    }));
  }).immediate();

/**
 * For DELETE /api/signins: ends the account's live dashboard sign-in `id` by deleting its row, the request's own
 * included, so its next request gets 401 while its token and the token's other sign-ins keep working, and answers its
 * id, or undefined, changing nothing, for an id that is no live sign-in of the account, another account's included.
 * Nothing references `dashboard_sessions`, so the delete cascades nowhere. `by` is the row of the admin person asking.
 * Throws `NotAdminError` unless they are still a live admin of the account.
 */
export const endSigninBy = (db: Db, account: AccountId, by: number, id: number): { id: number } | undefined =>
  db.transaction(() => {
    requireAdmin(db, account, by);
    const changed = db
      .prepare(
        `DELETE FROM dashboard_sessions WHERE id = ? AND EXISTS (SELECT 1 FROM tokens ${SIGNIN_PEOPLE}
           WHERE tokens.id = dashboard_sessions.token_id AND ${LIVE_SIGNIN_TOKEN})`,
      )
      .run(id, account).changes;
    return changed === 0 ? undefined : { id };
  }).immediate();

/** An unused invite as GET /api/invites lists it: never its code or hash. */
export interface PendingInvite {
  id: number;
  person: string;
  createdAt: string;
  expiresAt: string;
}

/**
 * One page of the account's invites that are not used, cancelled or expired, and whose person is still live, newest
 * first. `login-link` codes are not invites and are never listed.
 */
export function listInvites(db: Db, account: AccountId, limit: number, offset: number, now = Date.now()): PendingInvite[] {
  const rows = db
    .prepare(
      `SELECT login_codes.id, agents.name, login_codes.created_at, login_codes.expires_at
       FROM login_codes JOIN agents ON agents.id = login_codes.person_id AND agents.account_id = login_codes.account_id
         AND agents.removed_at IS NULL AND agents.person = 1
       WHERE login_codes.account_id = ? AND login_codes.invite = 1 AND login_codes.used_at IS NULL
         AND login_codes.cancelled_at IS NULL AND login_codes.expires_at > ?
       ORDER BY login_codes.id DESC LIMIT ? OFFSET ?`,
    )
    .all(account, now, limit, offset) as { id: number; name: string; created_at: number; expires_at: number }[];
  return rows.map((r) => ({
    id: r.id,
    person: r.name,
    createdAt: new Date(r.created_at).toISOString(),
    expiresAt: new Date(r.expires_at).toISOString(),
  }));
}

/**
 * Cancels the account's invite `id` while `listInvites` would list it: not used, cancelled or expired, and its person
 * live. Looked up by id and account together; false for any other id, another account's included. It sets `used_at` as
 * well (see `migrate` in db.ts), so a server from before `cancelled_at` refuses it too.
 */
export const cancelInvite = (db: Db, account: AccountId, id: number, now = Date.now()): boolean =>
  db
    .prepare(
      `UPDATE login_codes SET cancelled_at = ?, used_at = ?
       WHERE id = ? AND account_id = ? AND invite = 1 AND used_at IS NULL AND cancelled_at IS NULL AND expires_at > ?
         AND EXISTS (SELECT 1 FROM agents WHERE agents.id = login_codes.person_id AND agents.account_id = login_codes.account_id
           AND agents.removed_at IS NULL AND agents.person = 1)`,
    )
    .run(now, now, id, account, now).changes === 1;

/**
 * Redeems `code` for a new token of its account: a person token of its person, found by row and only while it is a
 * live person of the code's own account, else a full token. Answers the id of a new dashboard sign-in session for that
 * token, stored only as a hash in `dashboard_sessions`; the token itself is returned to nobody. One transaction finds
 * the code, marks it used, issues the token and starts the session, so a code gives at most one, from any number of
 * processes. Throws `LoginRefused` for a cancelled invite, a used code, and for an unknown or expired one or a person
 * since removed; the message never quotes the code.
 */
export const redeemLoginCode = (db: Db, code: string, now = Date.now()): string =>
  db.transaction((): string => {
    if (!CODE.test(code)) throw new LoginRefused("invalid");
    const row = db
      .prepare("SELECT id, account_id, person_id, expires_at, used_at, cancelled_at FROM login_codes WHERE code_hash = ?")
      .get(sha256(code)) as
      | { id: number; account_id: AccountId; person_id: number | null; expires_at: number; used_at: number | null; cancelled_at: number | null }
      | undefined;
    if (!row) throw new LoginRefused("invalid");
    // A cancelled invite has `used_at` set too, so this comes first.
    if (row.cancelled_at !== null) throw new LoginRefused("cancelled");
    if (row.used_at !== null) throw new LoginRefused("used");
    if (row.expires_at <= now) throw new LoginRefused("invalid");
    let person: { id: number; name: string } | undefined;
    if (row.person_id !== null) {
      person = db
        .prepare("SELECT id, name FROM agents WHERE id = ? AND account_id = ? AND person = 1 AND removed_at IS NULL")
        .get(row.person_id, row.account_id) as { id: number; name: string } | undefined;
      if (!person) throw new LoginRefused("invalid");
    }
    db.prepare("UPDATE login_codes SET used_at = ? WHERE id = ?").run(now, row.id);
    const { id } = issueToken(db, row.account_id, false, false, undefined, person);
    const session = randomBytes(32).toString("hex");
    db.prepare("INSERT INTO dashboard_sessions (hash, token_id, created_at) VALUES (?, ?, ?)").run(sha256(session), id, now);
    return session;
  }).immediate();
