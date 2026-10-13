import { ToolError, getAgent } from "./agents.js";
import type { Db } from "./db.js";
import { MAX_TAGS, cleanTags, countCodePoints } from "./memories.js";
import { MAX_BODY_LENGTH, sendMessage } from "./messages.js";

export type TaskStatus = "open" | "claimed" | "done";

export interface Task {
  id: number;
  title: string;
  details: string;
  status: TaskStatus;
  poster: string;
  assignee: string | null;
  result: string | null;
  tags: string[];
  createdAt: string;
  claimedAt: string | null;
  completedAt: string | null;
}

interface Row {
  id: number;
  title: string;
  details: string;
  status: TaskStatus;
  poster: string;
  assignee: string | null;
  result: string | null;
  created_at: number;
  claimed_at: number | null;
  completed_at: number | null;
}

export const MAX_TITLE_LENGTH = 200;
export const MAX_TASK_TEXT_LENGTH = 4000;
export const DEFAULT_TASK_LIMIT = 50;
export const MAX_TASK_LIMIT = 200;

const COLUMNS = "id, title, details, status, poster, assignee, result, created_at, claimed_at, completed_at";
const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());

function checkLength(what: string, s: string, max: number): void {
  // A code point is at most 2 code units, so anything over twice the limit is too long without iterating.
  if (s.length > 2 * max || countCodePoints(s) > max) {
    throw new ToolError(`${what} is too long: at most ${max} characters.`);
  }
}

function toTasks(db: Db, rows: Row[]): Task[] {
  const tagsOf = db.prepare("SELECT tag FROM task_tags WHERE task_id = ? ORDER BY tag");
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    details: r.details,
    status: r.status,
    poster: r.poster,
    assignee: r.assignee,
    result: r.result,
    tags: (tagsOf.all(r.id) as { tag: string }[]).map((t) => t.tag),
    createdAt: iso(r.created_at)!,
    claimedAt: iso(r.claimed_at),
    completedAt: iso(r.completed_at),
  }));
}

function readRow(db: Db, id: number): Row {
  const row = db.prepare(`SELECT ${COLUMNS} FROM tasks WHERE id = ?`).get(id) as Row | undefined;
  if (!row) throw new ToolError(`No task with id ${id}.`);
  return row;
}

function describeState(r: Row): string {
  return r.status === "open" ? "open" : `${r.status} by ${r.assignee}`;
}

export function postTask(db: Db, poster: string, title: string, details: string, tags: string[] = []): Task {
  if (title.trim().length === 0) throw new ToolError("Task title is empty.");
  checkLength("Title", title, MAX_TITLE_LENGTH);
  checkLength("Details", details, MAX_TASK_TEXT_LENGTH);
  const clean = cleanTags(tags);
  if (clean.length > MAX_TAGS) throw new ToolError(`At most ${MAX_TAGS} tags per task.`);
  return db
    .transaction((): Task => {
      // Read the clock after the write lock is held, so id order is creation-time order.
      const now = Date.now();
      const { lastInsertRowid } = db
        .prepare("INSERT INTO tasks (title, details, status, poster, created_at) VALUES (?, ?, 'open', ?, ?)")
        .run(title, details, poster, now);
      const insertTag = db.prepare("INSERT INTO task_tags (task_id, tag) VALUES (?, ?)");
      for (const t of clean) insertTag.run(lastInsertRowid, t);
      return toTasks(db, [readRow(db, Number(lastInsertRowid))])[0];
    })
    .immediate();
}

/** Oldest first; status, tags (all of them) and assignee narrow the same result; page with `offset`. */
export function listTasks(
  db: Db,
  status?: TaskStatus,
  tags: string[] = [],
  assignee?: string,
  limit = DEFAULT_TASK_LIMIT,
  offset = 0,
): Task[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (status !== undefined) {
    where.push("status = ?");
    params.push(status);
  }
  const wanted = cleanTags(tags);
  if (wanted.length) {
    where.push(
      `id IN (SELECT task_id FROM task_tags WHERE tag IN (${wanted.map(() => "?").join(",")})
              GROUP BY task_id HAVING COUNT(*) = ?)`,
    );
    params.push(...wanted, wanted.length);
  }
  if (assignee !== undefined) {
    where.push("assignee = ?");
    params.push(assignee);
  }
  return db
    .transaction((): Task[] => {
      const rows = db
        .prepare(
          `SELECT ${COLUMNS} FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""}
           ORDER BY id LIMIT ? OFFSET ?`,
        )
        .all(...params, Math.max(1, Math.min(limit, MAX_TASK_LIMIT)), Math.max(0, offset)) as Row[];
      return toTasks(db, rows);
    })();
}

export function getTask(db: Db, id: number): Task {
  // One read transaction, so the row and its tags come from the same snapshot.
  return db.transaction(() => toTasks(db, [readRow(db, id)])[0])();
}

/** One conditional UPDATE decides the winner; a loser reads the holder in the same transaction. */
export function claimTask(db: Db, agent: string, id: number): Task {
  return db
    .transaction((): Task => {
      const { changes } = db
        .prepare("UPDATE tasks SET status = 'claimed', assignee = ?, claimed_at = ? WHERE id = ? AND status = 'open'")
        .run(agent, Date.now(), id);
      const row = readRow(db, id);
      if (changes === 0) throw new ToolError(`Task ${id} is ${describeState(row)}; only an open task can be claimed.`);
      return toTasks(db, [row])[0];
    })
    .immediate();
}

export function releaseTask(db: Db, agent: string, id: number): Task {
  return db
    .transaction((): Task => {
      const { changes } = db
        .prepare(
          `UPDATE tasks SET status = 'open', assignee = NULL, claimed_at = NULL
           WHERE id = ? AND status = 'claimed' AND assignee = ?`,
        )
        .run(id, agent);
      const row = readRow(db, id);
      if (changes === 0) throw notYours(row, id, "released");
      return toTasks(db, [row])[0];
    })
    .immediate();
}

function notYours(row: Row, id: number, verb: string): ToolError {
  return row.status === "claimed"
    ? new ToolError(`Task ${id} is claimed by ${row.assignee}; only the claimer can have it ${verb}.`)
    : new ToolError(`Task ${id} is ${describeState(row)}; only a claimed task can be ${verb}.`);
}

/** The body sent to the poster, shortened so that it never exceeds the message limit. */
function completionBody(id: number, title: string, result: string): string {
  const head = `Task ${id} done: ${title}\n\n`;
  const full = head + result;
  if (countCodePoints(full) <= MAX_BODY_LENGTH) return full;
  const tail = `… (full result: get_task(${id}))`;
  const room = MAX_BODY_LENGTH - countCodePoints(head) - countCodePoints(tail);
  return head + [...result].slice(0, Math.max(0, room)).join("") + tail;
}

/** Marks the task done and tells the poster, in one transaction: both happen or neither does. */
export function completeTask(db: Db, agent: string, id: number, result: string): Task {
  if (result.trim().length === 0) throw new ToolError("Task result is empty.");
  checkLength("Result", result, MAX_TASK_TEXT_LENGTH);
  return db
    .transaction((): Task => {
      const { changes } = db
        .prepare(
          `UPDATE tasks SET status = 'done', result = ?, completed_at = ?
           WHERE id = ? AND status = 'claimed' AND assignee = ?`,
        )
        .run(result, Date.now(), id, agent);
      const row = readRow(db, id);
      if (changes === 0) throw notYours(row, id, "completed");
      // No message to oneself; a poster that no longer exists as an agent cannot receive one.
      if (row.poster.toLowerCase() !== agent.toLowerCase() && getAgent(db, row.poster)) {
        sendMessage(db, agent, row.poster, completionBody(id, row.title, result));
      }
      return toTasks(db, [row])[0];
    })
    .immediate();
}
