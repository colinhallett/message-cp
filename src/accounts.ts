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
  /** For a person token, the stored name of the person it sends and posts as. */
  person?: string;
}

/**
 * Who a bearer token acts as: its account, whether it may only read, and whether it may do only what an agent does
 * (/mcp, /wait and GET /api/token). Never both, and neither for a full token or a person token. A full token acts as no
 * person, so it never sends or posts as one (POST /api/send and /api/post), nor changes people or agents or makes
 * invites. A person token reads what a read-only token reads, sends and posts only as its person, approves MCP clients
 * (POST /oauth/approve) and, while its person is an admin, deletes the account's conversations (DELETE
 * /api/conversation), adds, marks, unmarks and removes other people (/api/people), makes, lists and cancels invites
 * (/api/invites), removes agents and resets their keys (DELETE /api/agents, POST /api/agents/key), lists and removes
 * webhooks (/api/webhooks), and revokes the account's approved clients (DELETE /api/approvals).
 */
export interface TokenAccess {
  account: AccountId;
  readOnly: boolean;
  agentOnly: boolean;
  /** For an agent token `connect` made, the one live agent of the account it acts as: its registration and name. */
  agent?: BoundAgent;
  /** For a person token (`token add --person`), the one live person of the account it sends and posts as. */
  person?: BoundPerson;
  /**
   * For an agent token an approval issued to a client that registers its own agents, the token's row id: it registers
   * new names and acts again only as the agents it registered (those whose `token_id` is this id). Never with `agent`.
   */
  registers?: number;
}

/** The person a person token acts as: their row in `agents`, their name and, where read, whether they are an admin. */
export interface BoundPerson {
  id: number;
  name: string;
  /** Read from the person's row on each request by `accountForToken`, so marking or unmarking applies at once. */
  admin?: boolean;
}

/** The agent a bound token acts as: its row in `agents`, the registration that row holds now, and its name. */
export interface BoundAgent {
  id: number;
  registeredAt: number;
  instance: string | null;
  name: string;
}

/** A token that still works, as `token list` shows it: never the token or its hash. */
export interface TokenInfo {
  id: number;
  account: string;
  kind: "full" | "read-only" | "agent" | "person";
  /** For a token the OAuth code exchange issued, the client it was issued to, as `exchangeCode` recorded it. */
  client?: ApprovedClient;
  createdAt: string;
}

/** The client an OAuth token was issued to: its `client_name` then (null for none), and its metadata URL's host (null for a registered client). */
export interface ApprovedClient {
  name: string | null;
  host: string | null;
}

/** An unrevoked token the OAuth code exchange issued, as GET /api/approvals serves it: never the token or its hash. */
export interface Approval {
  id: number;
  /** Whether the token registers its own agents, in which case it has no agent of its own. */
  registers: boolean;
  /** The agent a single-agent approval acts as; null for one that registers its own agents. */
  agent: string | null;
  /** For one that registers its own agents only, the live agents it registered, in name order; empty for none. */
  agents?: string[];
  clientName: string | null;
  clientHost: string | null;
  issuedAt: string;
}

const NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * Stores and returns a new token for the account of row id `account`, of the kind the flags say; with `registers`, an
 * agent token bound to no agent that registers its own agents. The caller checks the account, agent and person exist,
 * inside its own transaction; `addToken` and `redeemLoginCode` in login.ts do.
 */
export function issueToken(
  db: Db,
  account: AccountId,
  readOnly = false,
  agentOnly = false,
  agent?: number,
  person?: BoundPerson,
  registers = false,
): Omit<NewToken, "account"> {
  if (readOnly && agentOnly) throw new AccountError("A token is read-only or agent-only, not both.");
  if (agent !== undefined && !agentOnly) throw new AccountError("Only an agent token is bound to an agent.");
  if (person && (readOnly || agentOnly)) throw new AccountError("A person token is neither read-only nor agent-only.");
  if (registers && (!agentOnly || agent !== undefined)) throw new AccountError("Only an agent token bound to no agent registers its own agents.");
  const token = randomBytes(32).toString("hex");
  // An agent or person token is stored read-only too, so a server from before it that shares the database refuses it
  // everything but the read-only endpoints instead of taking it for a full token.
  const { id } = db
    .prepare(
      "INSERT INTO tokens (account_id, hash, created_at, read_only, agent_only, agent_id, person_id, registers) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
    )
    .get(account, hashToken(token), Date.now(), readOnly || agentOnly || person ? 1 : 0, agentOnly ? 1 : 0, agent ?? null, person?.id ?? null, registers ? 1 : 0) as {
    id: number;
  };
  return { id, token, readOnly, agentOnly, ...(person && { person: person.name }) };
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
 * cannot act as a person; with `agent` as well, one that acts only as the account's agent of that row id; with
 * `person`, one that sends and posts only as the account's live person of that name (any case); with `agentOnly` and
 * `registers`, one bound to no agent that registers its own agents.
 */
export const addToken = (
  db: Db,
  account: string,
  readOnly = false,
  agentOnly = false,
  agent?: number,
  person?: string,
  registers = false,
): NewToken =>
  db.transaction((): NewToken => {
    const row = db.prepare("SELECT id, name FROM accounts WHERE name = ?").get(account) as { id: number; name: string } | undefined;
    if (!row) throw new AccountError(`No account named '${account}'.`);
    if (agent !== undefined && !db.prepare("SELECT 1 FROM agents WHERE id = ? AND account_id = ? AND removed_at IS NULL AND person = 0").get(agent, row.id)) {
      throw new AccountError(`No live agent with id ${agent} in account '${row.name}'.`);
    }
    let bound: BoundPerson | undefined;
    if (person !== undefined) {
      const live = db
        .prepare("SELECT id, name, person FROM agents WHERE account_id = ? AND name = ? AND removed_at IS NULL")
        .get(row.id, person) as (BoundPerson & { person: number }) | undefined;
      if (live?.person === 0) throw new AccountError(`The name '${live.name}' belongs to an agent, not a person.`);
      if (!live) throw new AccountError(`No person named '${person}' in account '${row.name}'.`);
      bound = { id: live.id, name: live.name };
    }
    return { ...issueToken(db, row.id, readOnly, agentOnly, agent, bound, registers), account: row.name };
  }).immediate();

/** Every token that still works, oldest first, with its account and kind, and for an OAuth token its client. */
export function listTokens(db: Db): TokenInfo[] {
  const rows = db
    .prepare(
      `SELECT tokens.id, accounts.name, tokens.read_only, tokens.agent_only, tokens.person_id, tokens.created_at,
         tokens.oauth, tokens.client_name, tokens.client_host
       FROM tokens JOIN accounts ON accounts.id = tokens.account_id WHERE tokens.revoked_at IS NULL ORDER BY tokens.id`,
    )
    .all() as {
    id: number;
    name: string;
    read_only: number;
    agent_only: number;
    person_id: number | null;
    created_at: number;
    oauth: number | null;
    client_name: string | null;
    client_host: string | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    account: r.name,
    // A person token's row has read_only set too (see `issueToken`), so its person comes first.
    kind: r.person_id !== null ? "person" : r.agent_only === 1 ? "agent" : r.read_only === 1 ? "read-only" : "full",
    ...(r.oauth === 1 && { client: { name: r.client_name, host: r.client_host } }),
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

/** Records on the token of row id `token` that the OAuth code exchange issued it to `client`. Run inside that exchange's transaction. */
export function recordClient(db: Db, token: number, client: ApprovedClient): void {
  db.prepare("UPDATE tokens SET oauth = 1, client_name = ?, client_host = ? WHERE id = ?").run(client.name, client.host, token);
}

/**
 * One page of the account's unrevoked tokens the OAuth code exchange issued, newest first, each with its client and
 * either its agent or, for one that registers its own agents, the live agents of the account it registered, which may
 * be none. A single-agent token whose agent was removed is left out, as `accountForToken` refuses it, and so is one
 * issued before the exchange recorded its client.
 */
export function listApprovals(db: Db, account: AccountId, limit: number, offset: number): Approval[] {
  // A token that registers is kept in the shape `accountForToken` accepts as registering. Its agents are looked for in
  // its own account only; the unary + keeps SQLite finding them through agents_by_token rather than agents_live, which
  // would read every live agent of the account for each token.
  const rows = db
    .prepare(
      `SELECT tokens.id, agents.name, tokens.client_name, tokens.client_host, tokens.created_at,
         CASE WHEN agents.id IS NULL THEN
           (SELECT json_group_array(own.name ORDER BY own.name) FROM agents own
            WHERE own.token_id = tokens.id AND +own.account_id = tokens.account_id AND own.removed_at IS NULL AND own.person = 0)
         END AS registered
       FROM tokens LEFT JOIN agents ON agents.id = tokens.agent_id AND agents.account_id = tokens.account_id
         AND agents.removed_at IS NULL AND agents.person = 0
       WHERE tokens.account_id = ? AND tokens.oauth = 1 AND tokens.revoked_at IS NULL
         AND (agents.id IS NOT NULL OR (tokens.registers = 1 AND tokens.agent_only = 1 AND tokens.agent_id IS NULL))
       ORDER BY tokens.id DESC LIMIT ? OFFSET ?`,
    )
    .all(account, limit, offset) as {
    id: number;
    name: string | null;
    client_name: string | null;
    client_host: string | null;
    created_at: number;
    registered: string | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    // Only a token stored as registering, with no agent, is kept without a live agent.
    registers: r.name === null,
    agent: r.name,
    ...(r.name === null && { agents: JSON.parse(r.registered!) as string[] }),
    clientName: r.client_name,
    clientHost: r.client_host,
    issuedAt: new Date(r.created_at).toISOString(),
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
 * agent-only), else the account of a token created with `message-cp`, as long as it has not been revoked. A token bound
 * to an agent comes with that agent, and only while it is a live agent of the token's own account; a person token
 * comes with its person, only while that row is a live person of the token's own account, and with whether that row is
 * marked admin now. A token that registers its own agents comes with its row id. Undefined for anything else, a bound
 * token whose agent or person has been removed included.
 */
/** The name of the account `account`. */
export const accountName = (db: Db, account: AccountId): string =>
  db.prepare("SELECT name FROM accounts WHERE id = ?").pluck().get(account) as string;

export function accountForToken(db: Db, token: string, ownerToken: string): TokenAccess | undefined {
  const hash = hashToken(token);
  // Constant-time against the owner's token, as before accounts; created tokens are found by their hash.
  if (timingSafeEqual(Buffer.from(hash), Buffer.from(hashToken(ownerToken)))) {
    return { account: OWNER_ACCOUNT, readOnly: false, agentOnly: false };
  }
  // The agent and the person are looked for in the token's account only, so a token never acts as another account's.
  // The person is found by row, so a later person given a removed person's name is not theirs.
  const row = db
    .prepare(
      `SELECT tokens.id AS token_id, tokens.registers, tokens.account_id, tokens.read_only, tokens.agent_only, tokens.agent_id,
         agents.id, agents.registered_at, agents.instance, agents.name,
         tokens.person_id, people.id AS person_row, people.name AS person_name, people.admin AS person_admin
       FROM tokens LEFT JOIN agents ON agents.id = tokens.agent_id AND agents.account_id = tokens.account_id
         AND agents.removed_at IS NULL AND agents.person = 0
       LEFT JOIN agents people ON people.id = tokens.person_id AND people.account_id = tokens.account_id
         AND people.removed_at IS NULL AND people.person = 1
       WHERE tokens.hash = ? AND tokens.revoked_at IS NULL`,
    )
    .get(hash) as
    | {
        token_id: number;
        registers: number;
        account_id: number;
        read_only: number;
        agent_only: number;
        agent_id: number | null;
        id: number | null;
        registered_at: number;
        instance: string | null;
        name: string;
        person_id: number | null;
        person_row: number | null;
        person_name: string | null;
        person_admin: number | null;
      }
    | undefined;
  if (!row || (row.agent_id !== null && row.id === null) || (row.person_id !== null && row.person_row === null)) return undefined;
  if (row.person_row !== null && row.person_name !== null) {
    const person: BoundPerson = { id: row.person_row, name: row.person_name, admin: row.person_admin === 1 };
    return { account: row.account_id, readOnly: false, agentOnly: false, person };
  }
  // An agent token's row also has read_only set (see `issueToken`); it is agent-only here, never both.
  const access: TokenAccess = { account: row.account_id, readOnly: row.read_only === 1 && row.agent_only !== 1, agentOnly: row.agent_only === 1 };
  if (row.id !== null) access.agent = { id: row.id, registeredAt: row.registered_at, instance: row.instance, name: row.name };
  // Only an agent-only token bound to no agent, as `issueToken` stores it; never a full, read-only or person token.
  if (row.registers === 1 && row.agent_only === 1 && row.agent_id === null) access.registers = row.token_id;
  return access;
}
