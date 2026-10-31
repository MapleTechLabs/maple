CREATE TABLE projection_revisions (
    tenant_id TEXT NOT NULL,
    projection_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    spec_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (tenant_id, projection_id, revision)
) STRICT;

CREATE TABLE active_projections (
    tenant_id TEXT NOT NULL,
    projection_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, projection_id),
    FOREIGN KEY (tenant_id, projection_id, revision)
        REFERENCES projection_revisions (tenant_id, projection_id, revision)
        ON DELETE RESTRICT
) STRICT;

CREATE TABLE outbox_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    tenant_id TEXT NOT NULL,
    projection_id TEXT NOT NULL,
    projection_revision INTEGER NOT NULL CHECK (projection_revision > 0),
    source_kind TEXT,
    source TEXT,
    source_occurrence_id TEXT,
    source_fingerprint TEXT,
    state TEXT NOT NULL CHECK (state IN ('staged', 'ready')),
    event_json TEXT NOT NULL,
    staged_at TEXT NOT NULL,
    ready_at TEXT
) STRICT;

CREATE INDEX outbox_events_staged_sequence
    ON outbox_events (state, sequence);

CREATE INDEX outbox_events_staged_occurrence
    ON outbox_events (tenant_id, source_kind, source, source_occurrence_id, state);

CREATE TABLE outbox_ready_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    ready_at TEXT NOT NULL,
    FOREIGN KEY (event_id)
        REFERENCES outbox_events (event_id)
        ON DELETE RESTRICT
) STRICT;

CREATE TABLE projection_failures (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    projection_id TEXT NOT NULL,
    projection_revision INTEGER NOT NULL CHECK (projection_revision > 0),
    occurrence_id TEXT,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX projection_failures_occurrence
    ON projection_failures (tenant_id, projection_id, projection_revision, occurrence_id)
    WHERE occurrence_id IS NOT NULL;

CREATE TABLE event_consumers (
    consumer_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    active INTEGER NOT NULL CHECK (active IN (0, 1)),
    last_acked_sequence INTEGER NOT NULL CHECK (last_acked_sequence >= 0),
    accepted_gap_generation INTEGER NOT NULL DEFAULT 0 CHECK (accepted_gap_generation >= 0),
    lease_token_hash TEXT,
    lease_expires_at TEXT,
    claimed_through_sequence INTEGER CHECK (claimed_through_sequence > 0),
    registered_at TEXT NOT NULL,
    disabled_at TEXT,
    CHECK (
        (active = 1 AND disabled_at IS NULL) OR
        (active = 0 AND disabled_at IS NOT NULL)
    ),
    CHECK (
        (lease_token_hash IS NULL AND lease_expires_at IS NULL AND claimed_through_sequence IS NULL) OR
        (lease_token_hash IS NOT NULL AND lease_expires_at IS NOT NULL AND claimed_through_sequence IS NOT NULL)
    ),
    CHECK (claimed_through_sequence IS NULL OR claimed_through_sequence > last_acked_sequence)
) STRICT;

CREATE INDEX event_consumers_tenant_active_ack
    ON event_consumers (tenant_id, active, last_acked_sequence);

CREATE TABLE outbox_usage (
 singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
 count INTEGER NOT NULL CHECK (count >= 0),
 bytes INTEGER NOT NULL CHECK (bytes >= 0)
) STRICT;
INSERT INTO outbox_usage VALUES (1, 0, 0);
CREATE TRIGGER outbox_usage_insert AFTER INSERT ON outbox_events BEGIN
 UPDATE outbox_usage SET count = count + 1, bytes = bytes + length(CAST(NEW.event_json AS BLOB)) WHERE singleton = 1;
END;
CREATE TRIGGER outbox_usage_delete AFTER DELETE ON outbox_events BEGIN
 UPDATE outbox_usage SET count = count - 1, bytes = bytes - length(CAST(OLD.event_json AS BLOB)) WHERE singleton = 1;
END;
CREATE TRIGGER outbox_usage_update AFTER UPDATE OF event_json ON outbox_events BEGIN
 UPDATE outbox_usage SET bytes = bytes - length(CAST(OLD.event_json AS BLOB)) + length(CAST(NEW.event_json AS BLOB)) WHERE singleton = 1;
END;
CREATE TABLE delivery_gaps (
 tenant_id TEXT PRIMARY KEY,
 generation INTEGER NOT NULL CHECK (generation > 0),
 dropped_events INTEGER NOT NULL CHECK (dropped_events > 0),
 last_dropped_at TEXT NOT NULL
) STRICT;
PRAGMA user_version = 1;
