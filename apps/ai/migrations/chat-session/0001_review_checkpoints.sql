-- A review turn's progress by its kickoff message (`review/checkpoint.ts`), which every restart of
-- the turn shares: what an attempt found survives the object's reset.
CREATE TABLE IF NOT EXISTS review_checkpoints (
	kickoff_id TEXT PRIMARY KEY,
	payload TEXT NOT NULL,
	updated_at INTEGER NOT NULL
);
