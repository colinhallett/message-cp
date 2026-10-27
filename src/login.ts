import { createHash, randomBytes } from "node:crypto";
import { issueToken } from "./accounts.js";
import { PersonError, addPerson } from "./agents.js";
import { publicUrl } from "./connect.js";
import type { AccountId, Db } from "./db.js";

// `message-cp login-link`: a dashboard link carrying a one-time code, made on the server, that signs a browser in as the
// account's owner (a full token) or as one of its people (a person token), so nobody copies a token. The code is
// printed once, by the CLI, and stored only as a hash; POST /api/login redeems it once for a new token, which
// `token list` shows and `token revoke` stops like any other. Nothing here logs anything.
//
// An invite is the same kind of code, for a person, made by an admin person's token over HTTP (POST /api/people and
// /api/invites) rather than on the server. It lasts INVITE_TTL_MS, is listed (never its code) until it is used, cancelled
// or expires, and can be cancelled.

export class LoginError extends Error {}

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
 * and makes their first invite, in one transaction, so a refused name or a refused invite stores neither. Throws
 * `PersonError` as `addPerson` does and `LoginError` past MAX_INVITES_PER_ACCOUNT.
 */
export const addInvitedPerson = (db: Db, account: AccountId, name: string, admin: boolean, now = Date.now()): InvitedPerson =>
  db.transaction((): InvitedPerson => {
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
 * Throws `LoginError` past MAX_INVITES_PER_ACCOUNT.
 */
export const makeInvite = (db: Db, account: AccountId, person: string, now = Date.now()): InvitedPerson | undefined =>
  db.transaction(() => {
    const live = db
      .prepare("SELECT id, name, admin FROM agents WHERE account_id = ? AND name = ? AND removed_at IS NULL AND person = 1")
      .get(account, person) as { id: number; name: string; admin: number } | undefined;
    if (!live) return undefined;
    const { id, code, expiresAt } = storeCode(db, account, live.id, true, now);
    return { name: live.name, admin: live.admin === 1, invite: { id, code, expiresAt } };
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
 * live person of the code's own account, else a full token. One transaction finds the code, marks it used and issues
 * the token, so a code gives at most one token, from any number of processes. Throws `LoginRefused` for a cancelled
 * invite, a used code, and for an unknown or expired one or a person since removed; the message never quotes the code.
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
    return issueToken(db, row.account_id, false, false, undefined, person).token;
  }).immediate();
