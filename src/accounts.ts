import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { OWNER_ACCOUNT, type AccountId, type Db } from "./db.js";

// Accounts and their tokens. The operator manages them with `memory-cp account` and `memory-cp token` on the server.
// A token is shown once, when it is created; only its hash is stored.

export class AccountError extends Error {}

export interface Account {
  id: AccountId;
  name: string;
  createdAt: string;
  /** The ids of the account's tokens that still work; never the tokens themselves. */
  tokenIds: number[];
}

export interface NewToken {
  id: number;
  account: string;
  token: string;
}

const NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

function issueToken(db: Db, account: AccountId): { id: number; token: string } {
  const token = randomBytes(32).toString("hex");
  const { id } = db
    .prepare("INSERT INTO tokens (account_id, hash, created_at) VALUES (?, ?, ?) RETURNING id")
    .get(account, hashToken(token), Date.now()) as { id: number };
  return { id, token };
}

/** Creates the account `name` (unique in any case) with its first token. */
export const addAccount = (db: Db, name: string): NewToken =>
  db.transaction((): NewToken => {
    if (!NAME_PATTERN.test(name)) throw new AccountError("Invalid account name: use 1-32 characters from letters, digits, '-' and '_'.");
    if (db.prepare("SELECT 1 FROM accounts WHERE name = ?").get(name)) throw new AccountError(`Account '${name}' already exists.`);
    const { id, name: stored } = db
      .prepare("INSERT INTO accounts (name, created_at) VALUES (?, ?) RETURNING id, name")
      .get(name, Date.now()) as { id: number; name: string };
    return { ...issueToken(db, id), account: stored };
  }).immediate();

export function listAccounts(db: Db): Account[] {
  const rows = db.prepare("SELECT id, name, created_at FROM accounts ORDER BY id").all() as { id: number; name: string; created_at: number }[];
  const tokens = db.prepare("SELECT id FROM tokens WHERE account_id = ? AND revoked_at IS NULL ORDER BY id").pluck();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    createdAt: new Date(r.created_at).toISOString(),
    tokenIds: tokens.all(r.id) as number[],
  }));
}

/** Another token for the account named `account`. */
export const addToken = (db: Db, account: string): NewToken =>
  db.transaction((): NewToken => {
    const row = db.prepare("SELECT id, name FROM accounts WHERE name = ?").get(account) as { id: number; name: string } | undefined;
    if (!row) throw new AccountError(`No account named '${account}'.`);
    return { ...issueToken(db, row.id), account: row.name };
  }).immediate();

/** Stops the token `id` working for every request from now on. Returns the account it belonged to. */
export function revokeToken(db: Db, id: number): string {
  const row = db
    .prepare(
      `UPDATE tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL
       RETURNING (SELECT name FROM accounts WHERE accounts.id = tokens.account_id) AS account`,
    )
    .get(Date.now(), id) as { account: string } | undefined;
  if (!row) throw new AccountError(`No working token with id ${id}.`);
  return row.account;
}

/**
 * The account a bearer token belongs to: the owner's for `ownerToken` (MEMORY_CP_HTTP_TOKEN), else the account of a
 * token created with `memory-cp`, as long as it has not been revoked. Undefined for anything else.
 */
export function accountForToken(db: Db, token: string, ownerToken: string): AccountId | undefined {
  const hash = hashToken(token);
  // Constant-time against the owner's token, as before accounts; created tokens are found by their hash.
  if (timingSafeEqual(Buffer.from(hash), Buffer.from(hashToken(ownerToken)))) return OWNER_ACCOUNT;
  const row = db.prepare("SELECT account_id FROM tokens WHERE hash = ? AND revoked_at IS NULL").get(hash) as
    | { account_id: number }
    | undefined;
  return row?.account_id;
}
