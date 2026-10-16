-- The ChatSession Durable Object's SQLite schema. Idempotent: objects that predate these
-- migration files already have the tables and adopt this as their first applied file.
-- `payload` is the encoded `ChatEvent` minus its `seq`, which is the key.
CREATE TABLE IF NOT EXISTS events (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	created_at INTEGER NOT NULL,
	payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS session (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	running INTEGER NOT NULL DEFAULT 0,
	running_since INTEGER,
	running_message_id TEXT,
	running_input TEXT,
	running_resumes INTEGER
);
INSERT OR IGNORE INTO session (id, running) VALUES (1, 0);
