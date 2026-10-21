import { createHash } from "node:crypto";
import { nameOfIdentity, type Identity } from "./agents.js";
import type { AccountId, Db } from "./db.js";

// The registered HTTP sessions `serve` can restore after a restart. Only a hash of each session id is stored, as with
// tokens and keys: anyone holding the id and the account's token could act as the session's agent.

const hashSessionId = (id: string) => createHash("sha256").update(id).digest("hex");

/** Records that session `id` of `account` is `identity`, replacing what it was before, unless it has ended. */
export function saveSession(db: Db, id: string, account: AccountId, identity: Identity, now = Date.now()): void {
  db.prepare(
    `INSERT INTO http_sessions (hash, account_id, agent_id, registered_at, instance, last_used) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (hash) DO UPDATE SET account_id = excluded.account_id, agent_id = excluded.agent_id,
       registered_at = excluded.registered_at, instance = excluded.instance, last_used = excluded.last_used
     WHERE http_sessions.ended = 0`,
  ).run(hashSessionId(id), account, identity.id, identity.registeredAt, identity.instance, now);
}

export function touchSession(db: Db, id: string, now = Date.now()): void {
  db.prepare("UPDATE http_sessions SET last_used = ? WHERE hash = ? AND ended = 0").run(now, hashSessionId(id));
}

/**
 * Marks session `id` ended for good. The row stays until the idle sweep, so that a server still holding the session,
 * or a `register` on it there, cannot make it restorable again.
 */
export function endSession(db: Db, id: string, now = Date.now()): void {
  db.prepare("UPDATE http_sessions SET ended = 1, last_used = ? WHERE hash = ?").run(now, hashSessionId(id));
}

/** Whether session `id` has been ended by a DELETE, on this server or another one sharing the database. */
export function sessionEnded(db: Db, id: string): boolean {
  return db.prepare("SELECT 1 FROM http_sessions WHERE hash = ? AND ended = 1").get(hashSessionId(id)) !== undefined;
}

/**
 * Forgets every session last used before `cutoff`, and every ended one last used before `endedCutoff`: an ended row is
 * kept longer, until every server's live copy of the session has met it on a request or been swept as idle.
 */
export function forgetIdleSessions(db: Db, cutoff: number, endedCutoff: number): void {
  db.prepare("DELETE FROM http_sessions WHERE last_used < ? AND (ended = 0 OR last_used < ?)").run(cutoff, endedCutoff);
}

/**
 * The identity session `id` was registered as, if it belongs to `account`, has not ended, was used at or after `cutoff`
 * and its registration is still the agent's current one. A session whose agent was removed is forgotten, so it is never
 * restored, not even as a later agent with the same name. Another account's session is left alone and looks like none,
 * and an ended one keeps its row.
 */
export function restorableSession(db: Db, id: string, account: AccountId, cutoff: number): Identity | undefined {
  const hash = hashSessionId(id);
  const row = db
    .prepare("SELECT account_id, agent_id, registered_at, instance, last_used, ended FROM http_sessions WHERE hash = ?")
    .get(hash) as
    | {
        account_id: AccountId;
        agent_id: number;
        registered_at: number;
        instance: string | null;
        last_used: number;
        ended: number;
      }
    | undefined;
  if (!row || row.account_id !== account || row.ended) return undefined;
  const identity: Identity = { id: row.agent_id, registeredAt: row.registered_at, instance: row.instance };
  if (row.last_used < cutoff || nameOfIdentity(db, account, identity) === undefined) {
    db.prepare("DELETE FROM http_sessions WHERE hash = ?").run(hash);
    return undefined;
  }
  return identity;
}
