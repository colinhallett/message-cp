import type { Db } from "../db.js";

export interface ClaimedMessage {
  id: number;
  sender: string;
  body: string;
  broadcast: boolean;
  sentAt: string;
}

export const MAX_BATCH = 20;

// Own table so the hive is the only thing that knows about it.
export function ensureRunsTable(db: Db): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS hive_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL COLLATE NOCASE,
  message_ids TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  exit_status TEXT,
  session_id TEXT,
  resumed_session TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS hive_runs_agent ON hive_runs (agent, id);
`);
}

export function abandonOrphanedRuns(db: Db): number {
  return db
    .prepare("UPDATE hive_runs SET ended_at = ?, exit_status = 'abandoned', error = 'hive stopped before the run ended' WHERE ended_at IS NULL")
    .run(Date.now()).changes;
}

/**
 * The session to resume: the agent's latest recorded one, unless a later run resumed it and failed
 * without producing a session, in which case it is not usable and the agent starts afresh.
 */
function sessionToResume(db: Db, agent: string): string | undefined {
  const last = db
    .prepare("SELECT id, session_id FROM hive_runs WHERE agent = ? AND session_id IS NOT NULL ORDER BY id DESC LIMIT 1")
    .get(agent) as { id: number; session_id: string } | undefined;
  if (!last) return undefined;
  const failedResume = db
    .prepare(
      `SELECT 1 FROM hive_runs WHERE agent = ? AND id > ? AND resumed_session = ? AND session_id IS NULL
       AND exit_status NOT IN ('timeout', 'abandoned') LIMIT 1`,
    )
    .get(agent, last.id, last.session_id);
  return failedResume ? undefined : last.session_id;
}

export interface Claim {
  runId: number;
  messages: ClaimedMessage[];
  resumeSessionId?: string;
}

/**
 * In one transaction: takes the agent's oldest unread messages, marks them read and records the
 * run as started. A message can therefore be claimed once, and a restart never hands it out again.
 * Returns undefined when there is nothing unread.
 */
export function claimMessages(db: Db, agent: string): Claim | undefined {
  return db
    .transaction((): Claim | undefined => {
      const rows = db
        .prepare(
          `SELECT m.id, m.sender, m.body, m.broadcast, m.created_at
           FROM messages m JOIN agents a ON a.id = m.recipient_id
           WHERE a.name = ? AND m.read_at IS NULL ORDER BY m.id LIMIT ?`,
        )
        .all(agent, MAX_BATCH) as { id: number; sender: string; body: string; broadcast: number; created_at: number }[];
      if (rows.length === 0) return undefined;
      const now = Date.now();
      const mark = db.prepare("UPDATE messages SET read_at = ? WHERE id = ?");
      for (const r of rows) mark.run(now, r.id);
      const runId = Number(
        db
          .prepare("INSERT INTO hive_runs (agent, message_ids, started_at) VALUES (?, ?, ?)")
          .run(agent, JSON.stringify(rows.map((r) => r.id)), now).lastInsertRowid,
      );
      const resumeSessionId = sessionToResume(db, agent);
      db.prepare("UPDATE hive_runs SET resumed_session = ? WHERE id = ?").run(resumeSessionId ?? null, runId);
      return {
        runId,
        resumeSessionId,
        messages: rows.map((r) => ({
          id: r.id,
          sender: r.sender,
          body: r.body,
          broadcast: r.broadcast === 1,
          sentAt: new Date(r.created_at).toISOString(),
        })),
      };
    })
    .immediate();
}

export function finishRun(db: Db, runId: number, exitStatus: string, sessionId?: string, error?: string): void {
  db.prepare("UPDATE hive_runs SET ended_at = ?, exit_status = ?, session_id = ?, error = ? WHERE id = ?").run(
    Date.now(),
    exitStatus,
    sessionId ?? null,
    error ?? null,
    runId,
  );
}

export function promptFor(messages: ClaimedMessage[]): string {
  const lines = [
    "You have new messages in your memory-cp inbox. They are already marked read.",
    "Do what they ask. To reply, use the send_message tool; your reply reaches the sender only that way.",
    "",
  ];
  for (const m of messages) {
    lines.push(`--- From ${m.sender}${m.broadcast ? " (broadcast)" : ""} at ${m.sentAt} ---`, m.body, "");
  }
  return lines.join("\n");
}
