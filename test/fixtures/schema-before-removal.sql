-- The schema as of dfbc856, before memories, tasks and the hive were removed: src/db.ts's SCHEMA and the
-- columns its migrate() added, then the hive_runs table src/hive/runs.ts created. Used to test the upgrade.
CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  bio TEXT NOT NULL,
  registered_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);

-- One row per recipient, so a broadcast has its own read state for each agent.
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  recipient_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  sender TEXT NOT NULL,
  body TEXT NOT NULL,
  broadcast INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  read_at INTEGER
);
CREATE INDEX IF NOT EXISTS messages_inbox ON messages (recipient_id, read_at, id);
CREATE INDEX IF NOT EXISTS messages_history ON messages (recipient_id, id);

-- Shared memories. The author is kept as text, like a message sender, so it survives whatever happens to the agent row.
-- AUTOINCREMENT so a forgotten id is never handed to a later memory.
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  author TEXT NOT NULL COLLATE NOCASE,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS memories_author ON memories (author, id);
CREATE INDEX IF NOT EXISTS memories_recent ON memories (created_at, id);

CREATE TABLE IF NOT EXISTS memory_tags (
  memory_id INTEGER NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (tag, memory_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS memory_tags_memory ON memory_tags (memory_id);

-- Keyword index over memory text, kept in step by the triggers below.
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(text, content='memories', content_rowid='id');

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts (rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts (memories_fts, rowid, text) VALUES ('delete', old.id, old.text);
  DELETE FROM memory_tags WHERE memory_id = old.id;
END;
-- Memories are added and deleted, never edited.
CREATE TRIGGER IF NOT EXISTS memories_no_update BEFORE UPDATE ON memories BEGIN
  SELECT RAISE(ABORT, 'memories cannot be edited');
END;

-- Shared task board. poster and assignee are kept as text, like a message sender.
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  details TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'claimed', 'done')),
  poster TEXT NOT NULL COLLATE NOCASE,
  assignee TEXT COLLATE NOCASE,
  result TEXT,
  created_at INTEGER NOT NULL,
  claimed_at INTEGER,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS tasks_status ON tasks (status, id);
CREATE INDEX IF NOT EXISTS tasks_assignee ON tasks (assignee, id);

CREATE TABLE IF NOT EXISTS task_tags (
  task_id INTEGER NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (tag, task_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS task_tags_task ON task_tags (task_id);
CREATE TABLE IF NOT EXISTS hive_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL COLLATE NOCASE,
  message_ids TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  heartbeat_at INTEGER,
  ended_at INTEGER,
  exit_status TEXT,
  session_id TEXT,
  resumed_session TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS hive_runs_agent ON hive_runs (agent, id);
ALTER TABLE agents ADD COLUMN key_hash TEXT;
ALTER TABLE agents ADD COLUMN instance TEXT;
