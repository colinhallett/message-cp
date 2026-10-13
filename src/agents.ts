import { createHash, randomBytes } from "node:crypto";
import type { Db } from "./db.js";

export class ToolError extends Error {}

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
export const registerAgent = (db: Db, name: string, bio?: string, key?: string): Agent & { key?: string } =>
  db.transaction(() => {
    validateName(name);
    if (bio !== undefined && bio.length > MAX_BIO_LENGTH) {
      throw new ToolError(`Bio is too long: at most ${MAX_BIO_LENGTH} characters.`);
    }
    if (key !== undefined) validateKey(key);
    const existing = db.prepare("SELECT key_hash FROM agents WHERE name = ?").get(name) as
      | { key_hash: string | null }
      | undefined;
    if (existing?.key_hash && (key === undefined || hashKey(key) !== existing.key_hash)) {
      throw new ToolError(
        `Agent '${name}' is already registered and has a key. Pass its key to take it over.`,
      );
    }
    const issued = key === undefined ? randomBytes(32).toString("hex") : undefined;
    const keyHash = hashKey(key ?? issued!);
    const now = Date.now();
    const row = db
      .prepare(
        `INSERT INTO agents (name, bio, registered_at, last_seen, key_hash) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET bio = COALESCE(?, bio), last_seen = excluded.last_seen, key_hash = excluded.key_hash
         RETURNING name, bio, registered_at, last_seen`,
      )
      .get(name, bio ?? "", now, now, keyHash, bio ?? null) as Row;
    // A caller that supplied its own key already has it.
    return issued === undefined ? toAgent(row) : { ...toAgent(row), key: issued };
  }).immediate();

/**
 * The agent a supervisor chose for this process through MEMORY_CP_AGENT and MEMORY_CP_AGENT_KEY:
 * created or claimed with that key. Throws ToolError if the agent has a different key.
 */
export function agentFromEnv(db: Db, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const name = env.MEMORY_CP_AGENT;
  const key = env.MEMORY_CP_AGENT_KEY;
  if (!name && !key) return undefined;
  if (!name || !key) {
    throw new ToolError("MEMORY_CP_AGENT and MEMORY_CP_AGENT_KEY must be set together.");
  }
  return registerAgent(db, name, undefined, key).name;
}

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 200;

/** One page of agents ordered by name; pass `offset` to read the rest. */
export function listAgents(db: Db, limit = DEFAULT_LIST_LIMIT, offset = 0): Agent[] {
  const rows = db
    .prepare(
      "SELECT name, bio, registered_at, last_seen FROM agents ORDER BY name LIMIT ? OFFSET ?",
    )
    .all(Math.min(limit, MAX_LIST_LIMIT), offset) as Row[];
  return rows.map(toAgent);
}

export function getAgent(db: Db, name: string): Agent | undefined {
  const row = db
    .prepare("SELECT name, bio, registered_at, last_seen FROM agents WHERE name = ?")
    .get(name) as Row | undefined;
  return row && toAgent(row);
}

export function touchAgent(db: Db, name: string): void {
  db.prepare("UPDATE agents SET last_seen = ? WHERE name = ?").run(Date.now(), name);
}
