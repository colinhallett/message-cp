import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { AccountId, Db } from "./db.js";

export class ToolError extends Error {}

export const NOT_REGISTERED = "This session is not registered. Call `register` first.";

// Every function here takes the caller's account and reads or writes only that account's agents: another account's
// agent of the same name is invisible, never "taken", and gives the same answer as no agent at all.

export interface Agent {
  name: string;
  bio: string;
  registeredAt: string;
  lastSeen: string;
}

interface Row {
  name: string;
  bio: string;
  registered_at: number;
  last_seen: number;
}

const NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const MAX_BIO_LENGTH = 500;

function toAgent(row: Row): Agent {
  return {
    name: row.name,
    bio: row.bio,
    registeredAt: new Date(row.registered_at).toISOString(),
    lastSeen: new Date(row.last_seen).toISOString(),
  };
}

export function validateName(name: string): void {
  if (!NAME_PATTERN.test(name)) {
    throw new ToolError(
      "Invalid name: use 1-32 characters from letters, digits, '-' and '_'.",
    );
  }
  if (name.toLowerCase() === "all") {
    throw new ToolError("The name 'all' is reserved.");
  }
}

const MAX_KEY_LENGTH = 256;

const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");
const sameHash = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export type RegisterResult = Agent & { key?: string };

/** Which registration a session belongs to. Survives a takeover of the name, not a removal. */
export interface Identity {
  id: number;
  registeredAt: number;
  instance: string | null;
}

interface IdentityRow {
  id: number;
  registered_at: number;
  instance: string | null;
}

const toIdentity = (row: IdentityRow): Identity => ({
  id: row.id,
  registeredAt: row.registered_at,
  instance: row.instance,
});

function validateKey(key: string): void {
  if (key.length < 1 || key.length > MAX_KEY_LENGTH) {
    throw new ToolError(`Invalid key: use 1-${MAX_KEY_LENGTH} characters.`);
  }
}

/**
 * Creates the agent, or takes over an existing one with the same name (any case).
 * An agent that has a key can only be taken over with that key; one without a key (registered
 * before keys existed) is claimed by this call. With no `key` given a new one is generated and
 * returned, this once; only its hash is stored. `bio` undefined keeps an existing agent's bio.
 */
export const registerAgent = (db: Db, account: AccountId, name: string, bio?: string, key?: string): RegisterResult =>
  registerWithIdentity(db, account, name, bio, key).result;

/** `registerAgent`, also returning the identity of the registration the caller now holds. */
export const registerWithIdentity = (
  db: Db,
  account: AccountId,
  name: string,
  bio?: string,
  key?: string,
): { result: RegisterResult; identity: Identity } =>
  db.transaction(() => {
    validateName(name);
    if (bio !== undefined && bio.length > MAX_BIO_LENGTH) {
      throw new ToolError(`Bio is too long: at most ${MAX_BIO_LENGTH} characters.`);
    }
    if (key !== undefined) validateKey(key);
    const existing = db
      .prepare("SELECT key_hash FROM agents WHERE account_id = ? AND name = ? AND removed_at IS NULL")
      .get(account, name) as
      | { key_hash: string | null }
      | undefined;
    if (existing && existing.key_hash !== null && (key === undefined || !sameHash(hashKey(key), existing.key_hash))) {
      throw new ToolError(
        `Agent '${name}' is already registered and has a key. Pass its key to take it over.`,
      );
    }
    const issued = key === undefined;
    const effectiveKey = key ?? randomBytes(32).toString("hex");
    const keyHash = hashKey(effectiveKey);
    const now = Date.now();
    const row = db
      .prepare(
        `INSERT INTO agents (account_id, name, bio, registered_at, last_seen, key_hash, instance, wait_key_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         -- Reached on a conflict only after the key check above passed. Another account's agent of the same name never conflicts.
         ON CONFLICT(account_id, name) DO UPDATE SET bio = COALESCE(?, bio), last_seen = excluded.last_seen, key_hash = excluded.key_hash,
           -- A takeover with the same generated key keeps it; one with a chosen key leaves wait_key_hash unequal to key_hash.
           wait_key_hash = COALESCE(excluded.wait_key_hash, wait_key_hash)
         RETURNING id, name, bio, registered_at, last_seen, instance`,
      )
      .get(account, name, bio ?? "", now, now, keyHash, randomBytes(16).toString("hex"), issued ? keyHash : null, bio ?? null) as Row & IdentityRow;
    // A caller that supplied its own key already has it.
    return { result: issued ? { ...toAgent(row), key: effectiveKey } : toAgent(row), identity: toIdentity(row) };
  }).immediate();

/**
 * The agent a supervisor chose for this process through MEMORY_CP_AGENT and MEMORY_CP_AGENT_KEY:
 * created or claimed with that key. Throws ToolError if the agent has a different key.
 */
export function agentFromEnv(db: Db, account: AccountId, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return registerFromEnv(db, account, env)?.name;
}

/** `agentFromEnv`, also returning the identity of the registration it made, so a session binds to exactly that one. */
export function registerFromEnv(
  db: Db,
  account: AccountId,
  env: NodeJS.ProcessEnv = process.env,
): { name: string; identity: Identity } | undefined {
  const name = env.MEMORY_CP_AGENT;
  const key = env.MEMORY_CP_AGENT_KEY;
  if (name === undefined && key === undefined) return undefined;
  if (!name || !key) {
    throw new ToolError("MEMORY_CP_AGENT and MEMORY_CP_AGENT_KEY must be set together.");
  }
  const { result, identity } = registerWithIdentity(db, account, name, undefined, key);
  return { name: result.name, identity };
}

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 200;

/** One page of the account's agents ordered by name; pass `offset` to read the rest. */
export function listAgents(db: Db, account: AccountId, limit = DEFAULT_LIST_LIMIT, offset = 0): Agent[] {
  const rows = db
    .prepare(
      "SELECT name, bio, registered_at, last_seen FROM agents WHERE account_id = ? AND removed_at IS NULL ORDER BY name LIMIT ? OFFSET ?",
    )
    .all(account, Math.min(limit, MAX_LIST_LIMIT), offset) as Row[];
  return rows.map(toAgent);
}

export function getAgent(db: Db, account: AccountId, name: string): Agent | undefined {
  const row = db
    .prepare("SELECT name, bio, registered_at, last_seen FROM agents WHERE account_id = ? AND name = ? AND removed_at IS NULL")
    .get(account, name) as Row | undefined;
  return row && toAgent(row);
}

/** The identity of the agent registered under `name` right now, if any. */
export function identityOf(db: Db, account: AccountId, name: string): Identity | undefined {
  const row = db
    .prepare("SELECT id, registered_at, instance FROM agents WHERE account_id = ? AND name = ? AND removed_at IS NULL")
    .get(account, name) as
    | IdentityRow
    | undefined;
  return row && toIdentity(row);
}

/** The name of the agent `identity` still belongs to, or undefined once that registration was removed. */
export function nameOfIdentity(db: Db, account: AccountId, identity: Identity): string | undefined {
  const row = db
    .prepare("SELECT name FROM agents WHERE account_id = ? AND id = ? AND registered_at = ? AND instance IS ? AND removed_at IS NULL")
    .get(account, identity.id, identity.registeredAt, identity.instance) as { name: string } | undefined;
  return row?.name;
}

export function touchAgent(db: Db, account: AccountId, name: string): void {
  db.prepare("UPDATE agents SET last_seen = ? WHERE account_id = ? AND name = ? AND removed_at IS NULL").run(Date.now(), account, name);
}

export interface Unregistered {
  removed: string;
  keptMessages: number;
}

/**
 * The name a removed agent's row is given, so the real name is free again. `:` is outside the name pattern, so no
 * one can register it, and the id makes it unique.
 */
const removedName = (id: number) => `removed:${id}`;

// Match no key and no session's instance, so a release from before removals were kept, run on this database, can
// neither take over or remove a removed agent's row by name nor act as it from a session that was registered as it,
// and so cannot read or delete the messages kept with it.
const REMOVED_KEY_HASH = "removed";
const REMOVED_INSTANCE = "removed";

/**
 * Removes the agent `name` from the directory and frees its name. The row stays, marked removed, with its real name
 * in `removed_name`, so the messages addressed to it are kept and its id is never given to a new agent. An agent
 * with a key is removed only with that key, unless `own` is the identity of the caller's session: then that exact
 * registration is removed, or nothing if it is already gone, so a name registered by someone else in the meantime is
 * never touched.
 */
export const removeAgent = (db: Db, account: AccountId, name: string, key?: string, own?: Identity): Unregistered =>
  db.transaction((): Unregistered => {
    const row = (
      own
        ? db
            .prepare(
              "SELECT id, name, key_hash FROM agents WHERE account_id = ? AND id = ? AND registered_at = ? AND instance IS ? AND removed_at IS NULL",
            )
            .get(account, own.id, own.registeredAt, own.instance)
        : db.prepare("SELECT id, name, key_hash FROM agents WHERE account_id = ? AND name = ? AND removed_at IS NULL").get(account, name)
    ) as { id: number; name: string; key_hash: string | null } | undefined;
    if (!row) throw new ToolError(own ? NOT_REGISTERED : `No agent named '${name}'.`);
    if (row.key_hash !== null && !own) {
      if (key === undefined) throw new ToolError(`Agent '${row.name}' has a key. Pass its key to remove it.`);
      if (!sameHash(hashKey(key), row.key_hash)) throw new ToolError(`Wrong key for agent '${row.name}'.`);
    }
    db.prepare(
      "UPDATE agents SET name = ?, removed_name = name, removed_at = ?, key_hash = ?, instance = ? WHERE id = ?",
    ).run(removedName(row.id), Date.now(), REMOVED_KEY_HASH, REMOVED_INSTANCE, row.id);
    const keptMessages = (db.prepare("SELECT COUNT(*) AS n FROM messages WHERE recipient_id = ?").get(row.id) as { n: number }).n;
    return { removed: row.name, keptMessages };
  }).immediate();

/**
 * The account of the one live agent named `name` whose key is `key`, for `/wait` from an agent that has no account
 * token. Only a key `register` generated counts: a key the caller chose may be one anyone could guess, and /wait is
 * open to every account. `wait_key_hash` must still equal `key_hash`, so a key replaced since, by any release, or a
 * removed agent, does not count. Undefined when no agent matches, or when more than one does.
 */
export function accountForAgentKey(db: Db, name: string, key: string): AccountId | undefined {
  if (key.length < 1 || key.length > MAX_KEY_LENGTH) return undefined;
  const rows = db
    .prepare("SELECT account_id FROM agents WHERE name = ? AND key_hash = ? AND wait_key_hash = key_hash AND removed_at IS NULL LIMIT 2")
    .all(name, hashKey(key)) as { account_id: number }[];
  return rows.length === 1 ? rows[0].account_id : undefined;
}
