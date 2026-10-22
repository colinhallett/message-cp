import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { OWNER_ACCOUNT, type AccountId, type Db } from "./db.js";

// Accounts and their tokens. The operator manages them with `message-cp account` and `message-cp token` on the server.
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
  readOnly: boolean;
  agentOnly: boolean;
}

/**
 * Who a bearer token acts as: its account, whether it may only read, and whether it may do what an agent does but not
 * act as a person (POST /api/send and /api/post). Never both.
 */
export interface TokenAccess {
  account: AccountId;
  readOnly: boolean;
  agentOnly: boolean;
}

/** A token that still works, as `token list` shows it: never the token or its hash. */
export interface TokenInfo {
  id: number;
  account: string;
  kind: "full" | "read-only" | "agent";
  createdAt: string;
}

const NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

function issueToken(db: Db, account: AccountId, readOnly = false, agentOnly = false): Omit<NewToken, "account"> {
  if (readOnly && agentOnly) throw new AccountError("A token is read-only or agent-only, not both.");
  const token = randomBytes(32).toString("hex");
  // An agent token is stored read-only too, so a server from before agent tokens that shares the database refuses it
  // everything but the read-only endpoints instead of taking it for a full token.
  const { id } = db
    .prepare("INSERT INTO tokens (account_id, hash, created_at, read_only, agent_only) VALUES (?, ?, ?, ?, ?) RETURNING id")
    .get(account, hashToken(token), Date.now(), readOnly || agentOnly ? 1 : 0, agentOnly ? 1 : 0) as { id: number };
  return { id, token, readOnly, agentOnly };
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

/**
 * Another token for the account named `account`; with `readOnly`, one that can only read; with `agentOnly`, one that
 * cannot act as a person.
 */
export const addToken = (db: Db, account: string, readOnly = false, agentOnly = false): NewToken =>
  db.transaction((): NewToken => {
    const row = db.prepare("SELECT id, name FROM accounts WHERE name = ?").get(account) as { id: number; name: string } | undefined;
    if (!row) throw new AccountError(`No account named '${account}'.`);
    return { ...issueToken(db, row.id, readOnly, agentOnly), account: row.name };
  }).immediate();

/** Every token that still works, oldest first, with its account and kind. */
export function listTokens(db: Db): TokenInfo[] {
  const rows = db
    .prepare(
      `SELECT tokens.id, accounts.name, tokens.read_only, tokens.agent_only, tokens.created_at
       FROM tokens JOIN accounts ON accounts.id = tokens.account_id WHERE tokens.revoked_at IS NULL ORDER BY tokens.id`,
    )
    .all() as { id: number; name: string; read_only: number; agent_only: number; created_at: number }[];
  return rows.map((r) => ({
    id: r.id,
    account: r.name,
    kind: r.agent_only === 1 ? "agent" : r.read_only === 1 ? "read-only" : "full",
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

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
 * The account a bearer token belongs to: the owner's for `ownerToken` (MESSAGE_CP_HTTP_TOKEN, never read-only or
 * agent-only), else the account of a token created with `message-cp`, as long as it has not been revoked. Undefined for
 * anything else.
 */
export function accountForToken(db: Db, token: string, ownerToken: string): TokenAccess | undefined {
  const hash = hashToken(token);
  // Constant-time against the owner's token, as before accounts; created tokens are found by their hash.
  if (timingSafeEqual(Buffer.from(hash), Buffer.from(hashToken(ownerToken)))) {
    return { account: OWNER_ACCOUNT, readOnly: false, agentOnly: false };
  }
  const row = db
    .prepare("SELECT account_id, read_only, agent_only FROM tokens WHERE hash = ? AND revoked_at IS NULL")
    .get(hash) as { account_id: number; read_only: number; agent_only: number } | undefined;
  // An agent token's row also has read_only set (see `issueToken`); it is agent-only here, never both.
  return row && { account: row.account_id, readOnly: row.read_only === 1 && row.agent_only !== 1, agentOnly: row.agent_only === 1 };
}
