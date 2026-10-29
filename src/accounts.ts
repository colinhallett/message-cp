import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { endTokenAgents } from "./agents.js";
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
  /**
   * For a dashboard sign-in session (`dashboard_sessions`, from a login link or an invite) in place of its token, the
   * session's row id. It reaches what its token reaches, except /mcp and /wait. Set only when the bearer was a session id.
   */
  session?: number;
  /**
   * For an agent token the OAuth code exchange issued (an approval), single-agent or registering, the token's row id:
   * its sessions may ask for a listen token (`issueListenToken`). Never for a listen token itself.
   */
  approval?: number;
  /**
   * True for a listen token (`issueListenToken`), with `agent` set to its agent: it may only wait for that agent's mail on
   * GET /wait. Never with `approval`, `registers` or `session`.
   */
  listen?: true;
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
  /**
   * When a request last used it, to within TOKEN_USE_RESOLUTION_MS (earlier if a write was skipped or failed); null
   * until a request is recorded, so also for a token used only while every write was skipped or failed.
   */
  lastUsedAt: string | null;
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
         tokens.oauth, tokens.client_name, tokens.client_host, tokens.last_used_at
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
    last_used_at: number | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    account: r.name,
    // A person token's row has read_only set too (see `issueToken`), so its person comes first.
    kind: r.person_id !== null ? "person" : r.agent_only === 1 ? "agent" : r.read_only === 1 ? "read-only" : "full",
    ...(r.oauth === 1 && { client: { name: r.client_name, host: r.client_host } }),
    createdAt: new Date(r.created_at).toISOString(),
    lastUsedAt: r.last_used_at === null ? null : new Date(r.last_used_at).toISOString(),
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

/**
 * Stops the token `id` working for every request from now on. For a token that registers its own agents, also ends
 * each live agent it registered, as `endTokenAgents` does, in the same transaction. Returns the account it belonged to
 * and the names of the agents it ended, in name order, none for any other token.
 */
export const revokeToken = (db: Db, id: number): { account: string; agents: string[] } =>
  db.transaction(() => {
    const row = db
      .prepare(
        `UPDATE tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL
         RETURNING account_id, (SELECT name FROM accounts WHERE accounts.id = tokens.account_id) AS account`,
      )
      .get(Date.now(), id) as { account_id: AccountId; account: string } | undefined;
    if (!row) throw new AccountError(`No working token with id ${id}.`);
    return { account: row.account, agents: endTokenAgents(db, row.account_id, id) };
  }).immediate();

/** The name of the account `account`. */
export const accountName = (db: Db, account: AccountId): string =>
  db.prepare("SELECT name FROM accounts WHERE id = ?").pluck().get(account) as string;

/** How stale a token's `last_used_at` may get before a request that uses it writes it again: a busy token writes about once a minute. */
export const TOKEN_USE_RESOLUTION_MS = 60_000;

/**
 * Records on the token of row id `token` that a request used it now, unless it was recorded within
 * TOKEN_USE_RESOLUTION_MS. `lastUsedAt` is the value the caller's lookup read: when that is recent enough nothing is
 * written, so such a request never waits for SQLite's write lock; otherwise the `UPDATE` checks the window again, so
 * processes that read the same stale value write it once. Best effort, and outside any transaction: a lock held past the
 * busy timeout skips it quietly, any other error logs one fixed line, never anything about the token, and the request
 * goes on either way.
 */
function recordUse(db: Db, token: number, lastUsedAt: number | null): void {
  const now = Date.now();
  if (lastUsedAt !== null && lastUsedAt >= now - TOKEN_USE_RESOLUTION_MS) return;
  try {
    db.prepare("UPDATE tokens SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)").run(
      now,
      token,
      now - TOKEN_USE_RESOLUTION_MS,
    );
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (typeof code !== "string" || !code.startsWith("SQLITE_BUSY")) console.error("message-cp: could not record when a token was last used");
  }
}

/**
 * The account a bearer token belongs to: the owner's for `ownerToken` (MESSAGE_CP_HTTP_TOKEN, never read-only or
 * agent-only), else the account of a token created with `message-cp`, as long as it has not been revoked. A token bound
 * to an agent comes with that agent, and only while it is a live agent of the token's own account; a person token
 * comes with its person, only while that row is a live person of the token's own account, and with whether that row is
 * marked admin now. A token that registers its own agents comes with its row id. Undefined for anything else, a bound
 * token whose agent or person has been removed included. A created token it accepts is recorded as used now (see
 * `recordUse`), even if a later check refuses the request; nothing is recorded for `ownerToken` or a refused token.
 *
 * `token` may also be a dashboard sign-in session id (`dashboard_sessions`, made by `redeemLoginCode`). When no token's
 * hash matches, the session is found by its hash and its token by `tokens.id`, then every check above applies to that
 * token's row, so a session of a revoked token, or of a person token whose person was removed, gives undefined as the
 * token itself would. Its answer is its token's, with `session` set to the session's row id.
 */
export function accountForToken(db: Db, token: string, ownerToken: string): TokenAccess | undefined {
  const hash = hashToken(token);
  // Constant-time against the owner's token, as before accounts; created tokens are found by their hash.
  if (timingSafeEqual(Buffer.from(hash), Buffer.from(hashToken(ownerToken)))) {
    return { account: OWNER_ACCOUNT, readOnly: false, agentOnly: false };
  }
  // The agent and the person are looked for in the token's account only, so a token never acts as another account's.
  // The person is found by row, so a later person given a removed person's name is not theirs. A session is checked
  // through its token's row by the same query, keyed by `tokens.id` instead of `tokens.hash`.
  const select = (key: "hash" | "id", value: string | number) => db
    .prepare(
      `SELECT tokens.id AS token_id, tokens.last_used_at, tokens.registers, tokens.oauth, tokens.account_id, tokens.read_only, tokens.agent_only, tokens.agent_id,
         agents.id, agents.registered_at, agents.instance, agents.name,
         tokens.person_id, people.id AS person_row, people.name AS person_name, people.admin AS person_admin
       FROM tokens LEFT JOIN agents ON agents.id = tokens.agent_id AND agents.account_id = tokens.account_id
         AND agents.removed_at IS NULL AND agents.person = 0
       LEFT JOIN agents people ON people.id = tokens.person_id AND people.account_id = tokens.account_id
         AND people.removed_at IS NULL AND people.person = 1
       WHERE tokens.${key} = ? AND tokens.revoked_at IS NULL`,
    )
    .get(value) as
    | {
        token_id: number;
        last_used_at: number | null;
        registers: number;
        oauth: number | null;
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
  let row = select("hash", hash);
  let session: number | undefined;
  if (!row) {
    const found = db.prepare("SELECT id, token_id FROM dashboard_sessions WHERE hash = ?").get(hash) as { id: number; token_id: number } | undefined;
    if (found) {
      row = select("id", found.token_id);
      session = found.id;
    } else {
      return listenAccess(db, hash);
    }
  }
  if (!row || (row.agent_id !== null && row.id === null) || (row.person_id !== null && row.person_row === null)) return undefined;
  recordUse(db, row.token_id, row.last_used_at);
  if (row.person_row !== null && row.person_name !== null) {
    const person: BoundPerson = { id: row.person_row, name: row.person_name, admin: row.person_admin === 1 };
    return { account: row.account_id, readOnly: false, agentOnly: false, person, ...(session !== undefined && { session }) };
  }
  // An agent token's row also has read_only set (see `issueToken`); it is agent-only here, never both.
  const access: TokenAccess = { account: row.account_id, readOnly: row.read_only === 1 && row.agent_only !== 1, agentOnly: row.agent_only === 1 };
  if (row.id !== null) access.agent = { id: row.id, registeredAt: row.registered_at, instance: row.instance, name: row.name };
  // Only an agent-only token bound to no agent, as `issueToken` stores it; never a full, read-only or person token.
  if (row.registers === 1 && row.agent_only === 1 && row.agent_id === null) access.registers = row.token_id;
  // Only an agent token, which is what the code exchange issues; a sign-in session is never one.
  if (row.oauth === 1 && row.agent_only === 1 && session === undefined) access.approval = row.token_id;
  if (session !== undefined) access.session = session;
  return access;
}

// A listen token's agent, while it is a live agent of its approval's account that the approval still acts as: the
// single agent it is bound to, or one it registered. The approval must be an unrevoked agent token the code exchange
// issued.
export const LISTEN_AGENT = `FROM listen_tokens
  JOIN tokens ON tokens.id = listen_tokens.token_id AND tokens.revoked_at IS NULL AND tokens.oauth = 1 AND tokens.agent_only = 1
  JOIN agents ON agents.id = listen_tokens.agent_id AND agents.account_id = tokens.account_id AND agents.removed_at IS NULL
    AND agents.person = 0 AND (tokens.agent_id = agents.id OR (tokens.registers = 1 AND tokens.agent_id IS NULL AND agents.token_id = tokens.id))`;

/** The access of the listen token with hash `hash`: its agent, and nothing else. Undefined once `LISTEN_AGENT` fails. */
function listenAccess(db: Db, hash: string): TokenAccess | undefined {
  const row = db
    .prepare(`SELECT tokens.account_id, agents.id, agents.registered_at, agents.instance, agents.name ${LISTEN_AGENT} WHERE listen_tokens.hash = ?`)
    .get(hash) as { account_id: number; id: number; registered_at: number; instance: string | null; name: string } | undefined;
  if (!row) return undefined;
  return {
    account: row.account_id,
    readOnly: false,
    agentOnly: true,
    agent: { id: row.id, registeredAt: row.registered_at, instance: row.instance, name: row.name },
    listen: true,
  };
}

/**
 * A new listen token for the live agent `identity` of account `account`, through the approval token of row id
 * `approval`: one that only waits for that agent's mail on GET /wait. It replaces the agent's earlier one, which stops
 * working. Only its hash is stored. Undefined, storing nothing, unless `identity` is still that registration and
 * `LISTEN_AGENT` holds for it, so a session never gets one for another approval's agent or another account's.
 */
export const issueListenToken = (db: Db, account: AccountId, identity: { id: number; registeredAt: number; instance: string | null }, approval: number): string | undefined =>
  db.transaction((): string | undefined => {
    const allowed = db
      .prepare(
        `SELECT 1 FROM tokens JOIN agents ON agents.id = ? AND agents.account_id = tokens.account_id AND agents.removed_at IS NULL
           AND agents.person = 0 AND agents.registered_at = ? AND agents.instance IS ?
           AND (tokens.agent_id = agents.id OR (tokens.registers = 1 AND tokens.agent_id IS NULL AND agents.token_id = tokens.id))
         WHERE tokens.id = ? AND tokens.account_id = ? AND tokens.revoked_at IS NULL AND tokens.oauth = 1 AND tokens.agent_only = 1`,
      )
      .get(identity.id, identity.registeredAt, identity.instance, approval, account);
    if (!allowed) return undefined;
    const token = randomBytes(32).toString("hex");
    db.prepare(
      `INSERT INTO listen_tokens (agent_id, token_id, hash, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(agent_id) DO UPDATE SET token_id = excluded.token_id, hash = excluded.hash, created_at = excluded.created_at`,
    ).run(identity.id, approval, hashToken(token), Date.now());
    return token;
  }).immediate();
