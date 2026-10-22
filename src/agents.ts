import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { AccountId, Db } from "./db.js";
import { setting } from "./settings.js";

export class ToolError extends Error {}

export const NOT_REGISTERED = "This session is not registered. Call `register` first.";

// Every function here takes the caller's account and reads or writes only that account's agents: another account's
// agent of the same name is invisible, never "taken", and gives the same answer as no agent at all.

export interface Agent {
  name: string;
  bio: string;
  registeredAt: string;
  lastSeen: string;
  /** True for a person the operator added with `message-cp person add`, false for an agent. */
  person: boolean;
}

interface Row {
  name: string;
  bio: string;
  registered_at: number;
  last_seen: number;
  person: number;
}

export const NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const MAX_BIO_LENGTH = 500;

function toAgent(row: Row): Agent {
  return {
    name: row.name,
    bio: row.bio,
    registeredAt: new Date(row.registered_at).toISOString(),
    lastSeen: new Date(row.last_seen).toISOString(),
    person: row.person === 1,
  };
}

/** The refusal for `register` and `unregister` on a person's name. */
const personRefusal = (name: string) => `The name '${name}' belongs to a person, not an agent. No agent can register or remove it.`;

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
      .prepare("SELECT name, key_hash, person FROM agents WHERE account_id = ? AND name = ? AND removed_at IS NULL")
      .get(account, name) as
      | { name: string; key_hash: string | null; person: number }
      | undefined;
    // Before the key check: no key, not even a right one, makes a person's name an agent's.
    if (existing?.person === 1) throw new ToolError(personRefusal(existing.name));
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
        `INSERT INTO agents (account_id, name, bio, registered_at, last_seen, key_hash, instance) VALUES (?, ?, ?, ?, ?, ?, ?)
         -- Reached on a conflict only after the key check above passed. Another account's agent of the same name never conflicts.
         ON CONFLICT(account_id, name) DO UPDATE SET bio = COALESCE(?, bio), last_seen = excluded.last_seen, key_hash = excluded.key_hash
         RETURNING id, name, bio, registered_at, last_seen, person, instance`,
      )
      .get(account, name, bio ?? "", now, now, keyHash, randomBytes(16).toString("hex"), bio ?? null) as Row & IdentityRow;
    // A caller that supplied its own key already has it.
    return { result: issued ? { ...toAgent(row), key: effectiveKey } : toAgent(row), identity: toIdentity(row) };
  }).immediate();

/**
 * The agent a supervisor chose for this process through MESSAGE_CP_AGENT and MESSAGE_CP_AGENT_KEY:
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
  const name = setting("AGENT", env);
  const key = setting("AGENT_KEY", env);
  if (name === undefined && key === undefined) return undefined;
  if (!name || !key) {
    throw new ToolError("MESSAGE_CP_AGENT and MESSAGE_CP_AGENT_KEY must be set together.");
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
      "SELECT name, bio, registered_at, last_seen, person FROM agents WHERE account_id = ? AND removed_at IS NULL ORDER BY name LIMIT ? OFFSET ?",
    )
    .all(account, Math.min(limit, MAX_LIST_LIMIT), offset) as Row[];
  return rows.map(toAgent);
}

export function getAgent(db: Db, account: AccountId, name: string): Agent | undefined {
  const row = db
    .prepare("SELECT name, bio, registered_at, last_seen, person FROM agents WHERE account_id = ? AND name = ? AND removed_at IS NULL")
    .get(account, name) as Row | undefined;
  return row && toAgent(row);
}

/** The identity of the agent registered under `name` right now, if any. A person has none: nothing acts as one. */
export function identityOf(db: Db, account: AccountId, name: string): Identity | undefined {
  const row = db
    .prepare("SELECT id, registered_at, instance FROM agents WHERE account_id = ? AND name = ? AND removed_at IS NULL AND person = 0")
    .get(account, name) as
    | IdentityRow
    | undefined;
  return row && toIdentity(row);
}

/**
 * The row id and stored name of the account's live person `name` (any case), or undefined for an agent, a removed row
 * or no row at all. Only the HTTP routes that send and post as a person use it.
 */
export function personOf(db: Db, account: AccountId, name: string): { id: number; name: string } | undefined {
  return db
    .prepare("SELECT id, name FROM agents WHERE account_id = ? AND name = ? AND removed_at IS NULL AND person = 1")
    .get(account, name) as { id: number; name: string } | undefined;
}

/**
 * The name of the agent `identity` still belongs to, or undefined once that registration was removed. Undefined for a
 * person's row too, so no session or channel member can act as a person.
 */
export function nameOfIdentity(db: Db, account: AccountId, identity: Identity): string | undefined {
  const row = db
    .prepare(
      "SELECT name FROM agents WHERE account_id = ? AND id = ? AND registered_at = ? AND instance IS ? AND removed_at IS NULL AND person = 0",
    )
    .get(account, identity.id, identity.registeredAt, identity.instance) as { name: string } | undefined;
  return row?.name;
}

export function touchAgent(db: Db, account: AccountId, name: string): void {
  db.prepare("UPDATE agents SET last_seen = ? WHERE account_id = ? AND name = ? AND removed_at IS NULL").run(Date.now(), account, name);
}

/** How long a status line stays current after `set_status` set it. */
export const STATUS_TTL_MS = 5 * 60 * 1000;
export const MAX_STATUS_LENGTH = 100;

export interface StatusResult {
  /** The line as stored, or null when the call cleared it. */
  status: string | null;
  /** When the line stops being current, or null when there is none. */
  expiresAt: string | null;
}

// A newline, any other control character, or a line or paragraph separator: the line has to stay one line.
const NOT_ONE_LINE = /[\p{Cc}\p{Zl}\p{Zp}]/u;
// Bidirectional marks, embeddings, overrides and isolates, which could reorder the text shown around the line. Other
// format characters, such as the zero-width joiner in emoji sequences, are allowed.
const BIDI_CONTROL = /\p{Bidi_Control}/u;

/**
 * Sets the status line of the caller's own registration, `own`, replacing any earlier one, or clears it when `text` is
 * empty or only spaces. Throws, changing nothing, for a line that is too long, not one line or holds a bidirectional
 * formatting character, or NOT_REGISTERED once that registration was removed. A person's row never matches.
 */
export const setStatus = (db: Db, account: AccountId, own: Identity, text: string, now = Date.now()): StatusResult => {
  // Before the blank check, so a lone newline or tab is refused rather than taken as clearing the line.
  if (NOT_ONE_LINE.test(text)) throw new ToolError("Status must be one line, with no newline or other control character.");
  if (BIDI_CONTROL.test(text)) throw new ToolError("Status must not contain bidirectional formatting characters.");
  const clear = text.trim().length === 0;
  if (!clear) {
    // Count characters (code points), as validateBody does.
    let n = 0;
    for (const _ of text) if (++n > MAX_STATUS_LENGTH) break;
    if (n > MAX_STATUS_LENGTH) throw new ToolError(`Status is too long: at most ${MAX_STATUS_LENGTH} characters.`);
  }
  return db
    .transaction((): StatusResult => {
      const changed = db
        .prepare(
          "UPDATE agents SET status = ?, status_at = ? WHERE account_id = ? AND id = ? AND registered_at = ? AND instance IS ? AND removed_at IS NULL AND person = 0",
        )
        .run(clear ? null : text, clear ? null : now, account, own.id, own.registeredAt, own.instance).changes;
      if (changed === 0) throw new ToolError(NOT_REGISTERED);
      return clear ? { status: null, expiresAt: null } : { status: text, expiresAt: new Date(now + STATUS_TTL_MS).toISOString() };
    })
    .immediate();
};

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
              "SELECT id, name, key_hash, person FROM agents WHERE account_id = ? AND id = ? AND registered_at = ? AND instance IS ? AND removed_at IS NULL",
            )
            .get(account, own.id, own.registeredAt, own.instance)
        : db.prepare("SELECT id, name, key_hash, person FROM agents WHERE account_id = ? AND name = ? AND removed_at IS NULL").get(account, name)
    ) as { id: number; name: string; key_hash: string | null; person: number } | undefined;
    if (!row) throw new ToolError(own ? NOT_REGISTERED : `No agent named '${name}'.`);
    if (row.person === 1) throw new ToolError(personRefusal(row.name));
    if (row.key_hash !== null && !own) {
      if (key === undefined) throw new ToolError(`Agent '${row.name}' has a key. Pass its key to remove it.`);
      if (!sameHash(hashKey(key), row.key_hash)) throw new ToolError(`Wrong key for agent '${row.name}'.`);
    }
    db.prepare(
      "UPDATE agents SET name = ?, removed_name = name, removed_at = ?, key_hash = ?, instance = ?, status = NULL, status_at = NULL WHERE id = ?",
    ).run(removedName(row.id), Date.now(), REMOVED_KEY_HASH, REMOVED_INSTANCE, row.id);
    const keptMessages = (db.prepare("SELECT COUNT(*) AS n FROM messages WHERE recipient_id = ?").get(row.id) as { n: number }).n;
    return { removed: row.name, keptMessages };
  }).immediate();

export class PurgeError extends Error {}

export interface Purged {
  name: string;
  account: string;
  messages: number;
  mentions: number;
}

/**
 * For `message-cp agent remove`: removes the agent `name` (any case) of the account named `account`, live or only
 * left as removed rows, with every direct message to or from it and its mentions, and frees its name as `removeAgent`
 * does. Channels, posts and read positions stay. The rows stay too, marked removed: posts and read positions point
 * at them. Refuses, changing nothing, a live person's name, a name no agent of the account has had, or an unknown
 * account.
 */
export const purgeAgent = (db: Db, account: string, name: string): Purged =>
  db.transaction((): Purged => {
    const acct = db.prepare("SELECT id, name FROM accounts WHERE name = ?").get(account) as { id: AccountId; name: string } | undefined;
    if (!acct) throw new PurgeError(`No account named '${account}'.`);
    const live = db
      .prepare("SELECT id, name, person FROM agents WHERE account_id = ? AND name = ? AND removed_at IS NULL")
      .get(acct.id, name) as { id: number; name: string; person: number } | undefined;
    // Before anything is deleted, so a person's messages, and any sent under the name they now have, are never touched.
    if (live?.person === 1) throw new PurgeError(`The name '${live.name}' belongs to a person, not an agent.`);
    const removed = db
      .prepare("SELECT id, removed_name FROM agents WHERE account_id = ? AND person = 0 AND removed_at IS NOT NULL AND removed_name = ? COLLATE NOCASE ORDER BY id")
      .all(acct.id, name) as { id: number; removed_name: string }[];
    const ids = [...(live ? [live.id] : []), ...removed.map((r) => r.id)];
    if (ids.length === 0) throw new PurgeError(`No agent named '${name}' in account '${acct.name}'.`);
    // The same rows as `ids`, as a subquery, so no statement needs one bound variable per registration. A person
    // removed with `person remove` is not one of them.
    const rows = `SELECT id FROM agents WHERE account_id = ? AND (id = ? OR (person = 0 AND removed_at IS NOT NULL AND removed_name = ? COLLATE NOCASE))`;
    const rowArgs = [acct.id, live?.id ?? null, name];
    const messages = db
      .prepare(
        `DELETE FROM messages WHERE recipient_id IN (${rows})
         OR (sender = ? COLLATE NOCASE AND recipient_id IN (SELECT id FROM agents WHERE account_id = ?))`,
      )
      .run(...rowArgs, name, acct.id).changes;
    const mentions = db.prepare(`DELETE FROM mentions WHERE agent_id IN (${rows})`).run(...rowArgs).changes;
    if (live) {
      db.prepare(
        "UPDATE agents SET name = ?, removed_name = name, removed_at = ?, key_hash = ?, instance = ?, status = NULL, status_at = NULL WHERE id = ?",
      ).run(removedName(live.id), Date.now(), REMOVED_KEY_HASH, REMOVED_INSTANCE, live.id);
    }
    return { name: live?.name ?? removed[removed.length - 1]!.removed_name, account: acct.name, messages, mentions };
  }).immediate();

export class PersonError extends Error {}

export interface Person {
  name: string;
  account: string;
  addedAt: string;
}

// Matches no key and no session's instance, like REMOVED_KEY_HASH, so nothing can act as a person. The `person`
// checks in registerWithIdentity and removeAgent are what refuse; this only keeps an older release from claiming it.
const PERSON_KEY_HASH = "person";
const PERSON_INSTANCE = "person";

/**
 * Adds the person `name` to the account named `account`, as a row of `agents` marked `person`, so messages, mentions
 * and webhooks reach it as they reach an agent. Refuses a name a live agent or person of that account has (any case).
 */
export const addPerson = (db: Db, account: string, name: string): Person =>
  db.transaction((): Person => {
    try {
      validateName(name);
    } catch (err) {
      if (err instanceof ToolError) throw new PersonError(err.message);
      throw err;
    }
    const acct = db.prepare("SELECT id, name FROM accounts WHERE name = ?").get(account) as { id: AccountId; name: string } | undefined;
    if (!acct) throw new PersonError(`No account named '${account}'.`);
    const taken = db
      .prepare("SELECT name, person FROM agents WHERE account_id = ? AND name = ? AND removed_at IS NULL")
      .get(acct.id, name) as { name: string; person: number } | undefined;
    if (taken) throw new PersonError(`The name '${taken.name}' is already used by ${taken.person === 1 ? "a person" : "an agent"} in account '${acct.name}'.`);
    const now = Date.now();
    db.prepare(
      "INSERT INTO agents (account_id, name, bio, registered_at, last_seen, key_hash, instance, person) VALUES (?, ?, '', ?, ?, ?, ?, 1)",
    ).run(acct.id, name, now, now, PERSON_KEY_HASH, PERSON_INSTANCE);
    return { name, account: acct.name, addedAt: new Date(now).toISOString() };
  }).immediate();

/**
 * For `message-cp person remove`: removes the live person `name` (any case) of the account named `account`, with every
 * direct message to them or sent from the name since they were added, and their mentions, and frees the name, as
 * `purgeAgent` does for an agent. Channels, posts and read positions stay, and so does the row, marked removed.
 * Removed rows of earlier agents with that name, and the messages they sent, are left to `agent remove`. Refuses,
 * changing nothing, an agent's name, a name no live person of the account has, or an unknown account.
 */
export const removePerson = (db: Db, account: string, name: string): Purged =>
  db.transaction((): Purged => {
    const acct = db.prepare("SELECT id, name FROM accounts WHERE name = ?").get(account) as { id: AccountId; name: string } | undefined;
    if (!acct) throw new PersonError(`No account named '${account}'.`);
    const live = db
      .prepare("SELECT id, name, person, registered_at FROM agents WHERE account_id = ? AND name = ? AND removed_at IS NULL")
      .get(acct.id, name) as { id: number; name: string; person: number; registered_at: number } | undefined;
    // Before anything is deleted, so an agent's messages are never touched.
    if (live?.person === 0) throw new PersonError(`The name '${live.name}' belongs to an agent, not a person. Remove it with \`agent remove\`.`);
    if (!live) throw new PersonError(`No person named '${name}' in account '${acct.name}'.`);
    // Only the person sends under the name while it is theirs, so messages from it since they were added, by the
    // server's clock, are theirs; older ones are an earlier agent's, which keeps them until `agent remove`.
    const messages = db
      .prepare(
        `DELETE FROM messages WHERE recipient_id = ?
         OR (sender = ? COLLATE NOCASE AND created_at >= ? AND recipient_id IN (SELECT id FROM agents WHERE account_id = ?))`,
      )
      .run(live.id, live.name, live.registered_at, acct.id).changes;
    const mentions = db.prepare("DELETE FROM mentions WHERE agent_id = ?").run(live.id).changes;
    db.prepare(
      "UPDATE agents SET name = ?, removed_name = name, removed_at = ?, key_hash = ?, instance = ?, status = NULL, status_at = NULL WHERE id = ?",
    ).run(removedName(live.id), Date.now(), REMOVED_KEY_HASH, REMOVED_INSTANCE, live.id);
    return { name: live.name, account: acct.name, messages, mentions };
  }).immediate();

/** The live people of the account named `account`, or of every account without it, by account then name. */
export function listPeople(db: Db, account?: string): Person[] {
  if (account !== undefined && !db.prepare("SELECT 1 FROM accounts WHERE name = ?").get(account)) {
    throw new PersonError(`No account named '${account}'.`);
  }
  const rows = db
    .prepare(
      `SELECT agents.name, accounts.name AS account, agents.registered_at
       FROM agents JOIN accounts ON accounts.id = agents.account_id
       WHERE agents.person = 1 AND agents.removed_at IS NULL AND (? IS NULL OR accounts.name = ?)
       ORDER BY accounts.name, agents.name`,
    )
    .all(account ?? null, account ?? null) as { name: string; account: string; registered_at: number }[];
  return rows.map((r) => ({ name: r.name, account: r.account, addedAt: new Date(r.registered_at).toISOString() }));
}
