import { ToolError } from "./agents.js";
import type { Db } from "./db.js";

export interface Memory {
  id: number;
  author: string;
  text: string;
  tags: string[];
  storedAt: string;
}

interface Row {
  id: number;
  author: string;
  text: string;
  created_at: number;
}

export const MAX_TEXT_LENGTH = 4000;
export const MAX_TAGS = 20;
export const MAX_TAG_LENGTH = 50;
export const DEFAULT_RECALL_LIMIT = 20;
export const MAX_RECALL_LIMIT = 100;
export const MAX_QUERY_LENGTH = 500;

function countCodePoints(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

function cleanTags(tags: string[]): string[] {
  const clean = [...new Set(tags.map((t) => t.trim()))];
  if (clean.some((t) => t.length === 0 || countCodePoints(t) > MAX_TAG_LENGTH)) {
    throw new ToolError(`Each tag must be 1-${MAX_TAG_LENGTH} characters.`);
  }
  return clean;
}

/** Quotes every word so FTS5 sees plain words, never operators: `foo-bar` becomes the phrase "foo-bar". */
function toMatch(query: string): string | undefined {
  const words = query.split(/\s+/).filter(Boolean);
  return words.length ? words.map((w) => `"${w.replaceAll('"', '""')}"`).join(" ") : undefined;
}

export function remember(db: Db, author: string, text: string, tags: string[] = []): Memory {
  if (text.trim().length === 0) throw new ToolError("Memory text is empty.");
  // A code point is at most 2 code units, so anything over twice the limit is too long without iterating.
  if (text.length > 2 * MAX_TEXT_LENGTH || countCodePoints(text) > MAX_TEXT_LENGTH) {
    throw new ToolError(`Memory is too long: at most ${MAX_TEXT_LENGTH} characters.`);
  }
  const clean = cleanTags(tags);
  if (clean.length > MAX_TAGS) throw new ToolError(`At most ${MAX_TAGS} tags per memory.`);
  const now = Date.now();
  const id = db
    .transaction(() => {
      const { lastInsertRowid } = db
        .prepare("INSERT INTO memories (author, text, created_at) VALUES (?, ?, ?)")
        .run(author, text, now);
      const insertTag = db.prepare("INSERT INTO memory_tags (memory_id, tag) VALUES (?, ?)");
      for (const t of clean) insertTag.run(lastInsertRowid, t);
      return Number(lastInsertRowid);
    })
    .immediate();
  return { id, author, text, tags: clean.sort(), storedAt: new Date(now).toISOString() };
}

/** Newest first by stored time, ties broken by id; page with `offset`. Query, tags and author all narrow the same result. */
export function recall(
  db: Db,
  query?: string,
  tags: string[] = [],
  author?: string,
  limit = DEFAULT_RECALL_LIMIT,
  offset = 0,
): Memory[] {
  if (query !== undefined && query.length > MAX_QUERY_LENGTH) {
    throw new ToolError(`Query is too long: at most ${MAX_QUERY_LENGTH} characters.`);
  }
  const where: string[] = [];
  const params: (string | number)[] = [];
  const match = query === undefined ? undefined : toMatch(query);
  if (match) {
    where.push("m.id IN (SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?)");
    params.push(match);
  }
  const wanted = cleanTags(tags);
  if (wanted.length) {
    where.push(
      `m.id IN (SELECT memory_id FROM memory_tags WHERE tag IN (${wanted.map(() => "?").join(",")})
                GROUP BY memory_id HAVING COUNT(*) = ?)`,
    );
    params.push(...wanted, wanted.length);
  }
  if (author !== undefined) {
    where.push("m.author = ?");
    params.push(author);
  }
  const rows = db
    .prepare(
      `SELECT m.id, m.author, m.text, m.created_at FROM memories m
       ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY m.created_at DESC, m.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, Math.max(1, Math.min(limit, MAX_RECALL_LIMIT)), Math.max(0, offset)) as Row[];
  return toMemories(db, rows);
}

function toMemories(db: Db, rows: Row[]): Memory[] {
  const tagsOf = db.prepare("SELECT tag FROM memory_tags WHERE memory_id = ? ORDER BY tag");
  return rows.map((r) => ({
    id: r.id,
    author: r.author,
    text: r.text,
    tags: (tagsOf.all(r.id) as { tag: string }[]).map((t) => t.tag),
    storedAt: new Date(r.created_at).toISOString(),
  }));
}

export function getMemory(db: Db, id: number): Memory {
  // One read transaction, so the row and its tags come from the same snapshot.
  return db.transaction(() => {
    const row = db.prepare("SELECT id, author, text, created_at FROM memories WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new ToolError(`No memory with id ${id}.`);
    return toMemories(db, [row])[0];
  })();
}

export function forget(db: Db, id: number): { forgotten: number } {
  const { changes } = db.prepare("DELETE FROM memories WHERE id = ?").run(id);
  if (changes === 0) throw new ToolError(`No memory with id ${id}.`);
  return { forgotten: id };
}
