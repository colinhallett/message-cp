import { createHash, randomBytes } from "node:crypto";
import { issueToken } from "./accounts.js";
import { publicUrl } from "./connect.js";
import type { AccountId, Db } from "./db.js";

// `message-cp login-link`: a dashboard link carrying a one-time code, made on the server, that signs a browser in as the
// account's owner (a full token) or as one of its people (a person token), so nobody copies a token. The code is
// printed once, by the CLI, and stored only as a hash; POST /api/login redeems it once for a new token, which
// `token list` shows and `token revoke` stops like any other. Nothing here logs anything.

export class LoginError extends Error {}

/** Why a code gave no token: used once already, or unknown, expired, or for a person no longer live. */
export class LoginRefused extends Error {
  constructor(readonly reason: "used" | "invalid") {
    super(reason === "used" ? "This link was already used." : "This link has expired or is not valid.");
  }
}

/** Codes not yet used or expired, kept at once; past this a new one is refused. */
export const MAX_LOGIN_CODES = 1000;
/** How long a link works once it is made. */
export const LOGIN_CODE_TTL_MS = 5 * 60 * 1000;
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
    db.prepare("DELETE FROM login_codes WHERE expires_at <= ?").run(now);
    const pending = db.prepare("SELECT count(*) FROM login_codes WHERE used_at IS NULL").pluck().get() as number;
    if (pending >= MAX_LOGIN_CODES) throw new LoginError(`There are already ${MAX_LOGIN_CODES} unused links; try again once some expire.`);
    const code = randomBytes(32).toString("hex");
    const expiresAt = now + LOGIN_CODE_TTL_MS;
    db.prepare("INSERT INTO login_codes (code_hash, account_id, person_id, expires_at) VALUES (?, ?, ?, ?)").run(
      sha256(code),
      acct.id,
      bound?.id ?? null,
      expiresAt,
    );
    return { code, account: acct.name, ...(bound && { person: bound.name }), expiresAt };
  }).immediate();

/**
 * Redeems `code` for a new token of its account: a person token of its person, found by row and only while it is a
 * live person of the code's own account, else a full token. One transaction finds the code, marks it used and issues
 * the token, so a code gives at most one token, from any number of processes. Throws `LoginRefused` for a used code,
 * and for an unknown or expired one or a person since removed; the message never quotes the code.
 */
export const redeemLoginCode = (db: Db, code: string, now = Date.now()): string =>
  db.transaction((): string => {
    if (!CODE.test(code)) throw new LoginRefused("invalid");
    const row = db.prepare("SELECT id, account_id, person_id, expires_at, used_at FROM login_codes WHERE code_hash = ?").get(sha256(code)) as
      | { id: number; account_id: AccountId; person_id: number | null; expires_at: number; used_at: number | null }
      | undefined;
    if (!row) throw new LoginRefused("invalid");
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
