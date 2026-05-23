/**
 * @since 4.0.0
 */

// @barrel: Auto-generated exports. Do not edit manually.

/**
 * Defines typed event-log events for use with `EventLog` and event groups.
 *
 * An event definition names a durable domain event with a tag, derives the
 * aggregate or entity primary key from the payload, and records the schemas used
 * to encode the payload and decode handler success or failure values. These
 * definitions are the shared contract between clients that write events and
 * servers that register handlers, so they are useful for command-style writes,
 * replicated logs, audit trails, and workflows that need replayable domain
 * facts.
 *
 * Payloads are serialized with MessagePack, while success and error values are
 * described separately for the handler result. Keep payload schemas stable once
 * events have been persisted or replicated, prefer explicit versioned event tags
 * or backward-compatible schemas for changes, and make primary keys deterministic
 * so related entries are grouped consistently across stores and remotes.
 *
 * @since 4.0.0
 */
export * as Event from "./Event.ts"

/**
 * Defines typed groups of event-log event definitions.
 *
 * Event groups describe the events that belong to one event-log domain, such as
 * commands for an aggregate, application workflow, or synced local store. Start
 * from `empty`, add event tags with their payload, success, and error schemas,
 * then use the group with `EventLog.group` to provide the handlers that execute
 * and commit those events.
 *
 * Each event tag becomes the key in the group's events record, so tags should be
 * unique within a group. The `primaryKey` function is part of the event
 * definition and should derive the stable partition key from the decoded
 * payload. Omitted schemas default to `Schema.Void` for payload and success, and
 * `Schema.Never` for errors; use `addError` when every event in the group shares
 * an additional error schema.
 *
 * @since 4.0.0
 */
export * as EventGroup from "./EventGroup.ts"

/**
 * Low-level storage and replay primitives for the unstable event-log system.
 *
 * An `EventJournal` records committed event entries, exposes them for replay,
 * and tracks the replication state needed to exchange entries with remote
 * journals. It is the persistence boundary used by higher-level event-log
 * schemas and handlers for workflows such as rebuilding projections, syncing
 * offline clients, importing remote changes, and coordinating per-store writes.
 *
 * Journal entries are ordered by their UUID v7 entry ids, so persistence and
 * replay code should account for clock-derived ordering when detecting
 * conflicts. Payloads are stored as encoded bytes and must remain compatible
 * with the event schemas that will decode them later. Remote writes may include
 * duplicate entries, compaction can rewrite the set of imported entries before
 * effects run, and replay handlers should be prepared for entries that arrive
 * after local changes for the same event and primary key.
 *
 * @since 4.0.0
 */
export * as EventJournal from "./EventJournal.ts"

/**
 * Typed event-log runtime for appending domain events to an `EventJournal` and
 * replaying entries from remote replicas.
 *
 * This module is used to define event-log schemas, register handlers for event
 * groups, build clients that write typed payloads, and connect local journals to
 * authenticated remote sessions. It is useful for event-sourced state,
 * offline-first synchronization, audit trails, and replicated stores where each
 * event must run its handler before the entry is committed.
 *
 * Local appends encode payloads with the event schema and commit only after the
 * registered handler succeeds. Remote replay decodes entries with the same
 * schema, passes duplicate or conflicting entries to handlers, may run
 * compaction before committing, and invalidates registered reactivity keys.
 * Remote sessions depend on the current `Identity` and `CurrentStoreId`, so use
 * stable values when multiple replicas or stores must share the same log.
 *
 * @since 4.0.0
 */
export * as EventLog from "./EventLog.ts"

/**
 * Event-log encryption primitives for encrypted remote replication.
 *
 * This module defines the `EventLogEncryption` service used by encrypted
 * `EventLogRemote` clients to turn local journal entries into encrypted remote
 * payloads, decrypt encrypted changes received from a server, hash byte data,
 * and create event-log identities. It is useful when events need to be
 * replicated through infrastructure that stores or transports only ciphertext,
 * such as an encrypted event-log server, offline-first synchronization backend,
 * or multi-device replicated store.
 *
 * Encryption keys are deterministically derived from the identity private key
 * material, so the same stable identity is required to decrypt entries across
 * sessions and devices. The public key identifies the replicated log, while the
 * private key material must remain secret and must not be rotated without a
 * migration plan for existing encrypted entries. The default implementation
 * uses Web Crypto AES-GCM with generated initialization vectors that are stored
 * alongside encrypted entries; persisted ciphertext, IVs, entry schemas, and
 * identity key derivation labels are part of the compatibility surface for
 * future event-log encryption versions.
 *
 * @since 4.0.0
 */
export * as EventLogEncryption from "./EventLogEncryption.ts"

/**
 * Defines the wire messages used by event-log remotes to authenticate clients,
 * write event batches, and stream changes back to replicas.
 *
 * This module is the protocol boundary between `EventLogRemote` clients and
 * event-log servers: it provides schemas for store identifiers, protocol
 * errors, session handshake payloads, authenticated RPCs, and the msgpack
 * payloads used to carry encrypted or plaintext journal entries.
 *
 * Event batches are serialized as binary payloads before transport. Small
 * payloads can be sent as a single frame, while larger payloads are split into
 * `ChunkedMessage` parts and must be reassembled by message id after every part
 * has arrived. Transports should preserve `Uint8Array` bytes exactly and avoid
 * treating msgpack data as text.
 *
 * @since 4.0.0
 */
export * as EventLogMessage from "./EventLogMessage.ts"

/**
 * Client-side remote replica support for writing event-log entries and
 * receiving change streams over the event-log RPC protocol.
 *
 * This module builds `EventLogRemote` services backed by `EventLogRemoteRpcs`.
 * It is used by local event logs that need to replicate entries to another
 * journal, subscribe to remote changes from a sequence number, or run effects
 * only after the current event-log identity has completed the remote
 * authentication handshake. The encrypted constructor is the default choice for
 * synchronizing browser, edge, or service replicas across an untrusted network,
 * while the unencrypted constructor is intended for trusted transports or tests.
 *
 * Remote sessions begin with `Hello` and `Authenticate`, cache authentication by
 * identity public key, and retry forbidden responses by refreshing the handshake.
 * The RPC transport must preserve a stable client session across hello,
 * authentication, writes, and change streams. Entries and change batches may be
 * split into protocol chunks, so callers should treat `changes` as a scoped
 * streaming queue and rely on the remote `Registry` registration instead of
 * manually sharing partially assembled payloads between sessions.
 *
 * @since 4.0.0
 */
export * as EventLogRemote from "./EventLogRemote.ts"

/**
 * Server-side RPC handlers for accepting remote event-log writes and streaming
 * changes back to authenticated clients.
 *
 * This module is the protocol glue used by concrete event-log servers: it
 * performs the hello / authenticate challenge flow, attaches the authenticated
 * `EventLog.Identity` to subsequent RPC requests, reassembles chunked writes,
 * and chunks large change payloads before they are sent to clients. It is useful
 * when exposing an event-log replica over HTTP-backed RPC, for example to sync
 * browser, edge, or service replicas with a central journal.
 *
 * The authentication state is tied to the RPC client session annotations, so the
 * transport must preserve a stable client session between `Hello`,
 * `Authenticate`, writes, and change streams. Deployments should run the endpoint
 * over TLS, avoid exposing unauthenticated write or changes routes, and persist
 * session-auth key bindings with the same trust boundary as the event-log data.
 *
 * @since 4.0.0
 */
export * as EventLogServer from "./EventLogServer.ts"

/**
 * Server-side RPC layers and storage contracts for encrypted event-log
 * replication.
 *
 * This module is used by encrypted `EventLogRemote` clients that need a remote
 * synchronization endpoint without exposing plaintext events to the server. The
 * server stores ciphertext, initialization vectors, entry ids, and remote
 * sequence numbers keyed by the client's public key and store id, then streams
 * encrypted changes back to clients so they can decrypt locally with their
 * identity private key material. This makes it suitable for offline-first
 * synchronization, multi-device replication, and hosted backends where the
 * transport or storage layer should not inspect event payloads.
 *
 * The server does not derive or hold encryption keys. It treats public keys as
 * log identities, persists one session authentication binding per public key,
 * and reuses the initialization vector supplied with each encrypted write
 * request for the entries in that batch. Persisted remote ids, session signing
 * key bindings, ciphertext, IVs, and sequence numbers are therefore part of the
 * encrypted replication protocol and should be kept stable by durable storage
 * implementations.
 *
 * @since 4.0.0
 */
export * as EventLogServerEncrypted from "./EventLogServerEncrypted.ts"

/**
 * Server implementation for event logs whose entries are persisted and streamed
 * in plaintext.
 *
 * This module is useful for trusted deployments, local development, tests, and
 * server-side event sources that need typed event handlers, conflict detection,
 * compaction, and RPC change streams without an encryption layer. It includes
 * services for mapping client store ids to server stores, authorizing reads and
 * writes, storing remote entries, and binding session authentication keys.
 *
 * Because payloads and journals are unencrypted, storage must be protected by
 * the surrounding infrastructure. Session authentication bindings are part of
 * the storage contract and must be persisted by durable implementations so a
 * public key cannot silently bind to a different signing key after a restart.
 * The provided memory storage is process-local and intended for ephemeral
 * servers, tests, or examples rather than durable multi-process use.
 *
 * @since 4.0.0
 */
export * as EventLogServerUnencrypted from "./EventLogServerUnencrypted.ts"

/**
 * Utilities for authenticating event log sessions with short-lived challenges
 * and Ed25519 signatures.
 *
 * This module builds and verifies the canonical payload that a remote peer signs
 * when proving control of a session signing key. It is used by event log
 * transports that need to bind a connection attempt to a remote identifier,
 * session challenge, advertised event log public key, and signing public key
 * before accepting session traffic.
 *
 * Callers are responsible for issuing fresh challenges, enforcing the challenge
 * time-to-live, and tracking whether a challenge has already been consumed. The
 * helpers here provide deterministic payload encoding, algorithm checks,
 * signature validation, and Web Crypto integration; they do not establish peer
 * trust by themselves. Trust decisions still need to compare the supplied keys
 * and remote identity against the application's authorization policy, and
 * signed payloads should be treated as bearer authentication material until the
 * challenge expires.
 *
 * @since 4.0.0
 */
export * as EventLogSessionAuth from "./EventLogSessionAuth.ts"

/**
 * SQL-backed persistence for the unstable event-log journal.
 *
 * This module provides an `EventJournal` implementation that stores local
 * entries and remote replication metadata in a `SqlClient` database. It is
 * useful when event-log data needs to survive process restarts, be replayed to
 * rebuild projections, or be synchronized with other journals such as remote
 * servers, peer replicas, or offline clients that later reconnect.
 *
 * The adapter creates the entry and remotes tables with dialect-specific UUID,
 * binary payload, and timestamp column types, but it only performs the minimal
 * `CREATE TABLE IF NOT EXISTS` setup needed by the journal. Applications that
 * customize table names, add indexes, or evolve storage should manage those
 * migrations explicitly and keep encoded payloads compatible with the schemas
 * that will decode historical entries. Remote sequence rows are persisted
 * separately from entries, duplicate imports are ignored by primary key, and
 * conflict checks rely on event name, primary key, and the timestamp derived
 * from the entry id.
 *
 * @since 4.0.0
 */
export * as SqlEventJournal from "./SqlEventJournal.ts"

/**
 * SQL-backed storage for encrypted event-log servers.
 *
 * This module provides the encrypted server-side storage implementation used
 * when event-log entries should be durable in a SQL database without exposing
 * plaintext event data to that database. It is intended for remote event-log
 * servers, sync services, and multi-client deployments where the server assigns
 * stable sequence numbers and broadcasts changes while clients retain control of
 * event encryption and decryption.
 *
 * The storage creates dialect-specific tables for the server remote id and
 * session authentication bindings, then creates per-identity/store entry tables
 * using a SHA-256-derived table suffix. Those entry tables store IVs, entry ids,
 * encrypted entry bytes, and the SQL sequence used for ordering. Operators
 * should account for these dynamically created tables in migrations, backups,
 * retention policies, and table-prefix changes. Encryption key material is not
 * stored here, so rotating encryption schemes or moving data between databases
 * requires compatibility with the clients that produced the encrypted entries.
 *
 * @since 4.0.0
 */
export * as SqlEventLogServerEncrypted from "./SqlEventLogServerEncrypted.ts"

/**
 * SQL-backed storage for an unencrypted event-log server.
 *
 * This module provides the persistence layer used by
 * `EventLogServerUnencrypted` when remote entries should be stored in a SQL
 * database and streamed back to clients by store sequence. It creates and uses
 * dialect-specific tables for the server remote id, per-store sequence state,
 * plaintext entries, and session authentication bindings, which makes it useful
 * for durable local or service-side event-log deployments where database
 * backup, replication, and transactional ordering are desired.
 *
 * Entry payloads are intentionally written as plaintext bytes. Use this storage
 * only when the database, transport, backups, logs, and operators are trusted,
 * or when encryption is handled outside this module. Table names are derived
 * from the provided prefixes, and writes rely on SQL transactions plus
 * store-level sequence rows, so deployments should provision compatible
 * isolation/locking behavior and account for dialect-specific binary and text
 * column limits.
 *
 * @since 4.0.0
 */
export * as SqlEventLogServerUnencrypted from "./SqlEventLogServerUnencrypted.ts"
