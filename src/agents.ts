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

/** Creates the agent, or takes over an existing one with the same name (any case). */
export function registerAgent(db: Db, name: string, bio: string): Agent {
  validateName(name);
  if (bio.length > MAX_BIO_LENGTH) {
    throw new ToolError(`Bio is too long: at most ${MAX_BIO_LENGTH} characters.`);
  }
  const now = Date.now();
  const row = db
    .prepare(
      `INSERT INTO agents (name, bio, registered_at, last_seen) VALUES (?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET bio = excluded.bio, last_seen = excluded.last_seen
       RETURNING name, bio, registered_at, last_seen`,
    )
    .get(name, bio, now, now) as Row;
  return toAgent(row);
}

export function listAgents(db: Db): Agent[] {
  const rows = db
    .prepare("SELECT name, bio, registered_at, last_seen FROM agents ORDER BY name")
    .all() as Row[];
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
