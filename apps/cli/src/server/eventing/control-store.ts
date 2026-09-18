import CREATE_SCHEMA from "../schema/control-schema.sql" with { type: "text" }
import { LOCAL_CONTROL_SCHEMA_VERSION as CONTROL_SCHEMA_VERSION } from "../local-schema-version"
import { constants as sqliteConstants, Database } from "bun:sqlite"
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import {
	canonicalJson,
	isJsonValue,
	decodeSignalProjectionSpec,
	validateMapleCloudEvent,
	type MapleCloudEvent,
	type JsonValue,
	type ProjectionFailure,
	type SignalProjectionSpec,
} from "@maple/eventing-core"
import { Context, Effect, Layer, Result, Schema, type Scope } from "effect"
import { durableWrite, ensurePrivateDirectory } from "../durable-files"
import { observeEventing } from "./telemetry"

const CONTROL_DIRECTORY = "control"
const CONTROL_DATABASE = "eventing.sqlite"
const MAX_FAILURES_PER_TENANT = 10_000
export const DEFAULT_MAX_OUTBOX_EVENTS = 10_000
export const DEFAULT_MAX_OUTBOX_BYTES = 256 * 1024 * 1024
export const DEFAULT_RETAIN_ACKNOWLEDGED_READY_EVENTS = 1_000

export const eventingControlDirectory = (dataDir: string): string => join(resolve(dataDir), CONTROL_DIRECTORY)
export const eventingControlPath = (dataDir: string): string =>
	join(eventingControlDirectory(dataDir), CONTROL_DATABASE)
export const eventingControlSnapshotPath = (dataDir: string, checkpointId: string): string =>
	join(resolve(dataDir), "backups", "snapshots", checkpointId, "control.sqlite")

interface UserVersionRow {
	readonly user_version: number | bigint
}

interface RevisionRow {
	readonly revision: number | bigint | null
}

interface ProjectionJsonRow {
	readonly spec_json: string
}

interface EventRow {
	readonly event_id: string
	readonly event_json: string
	readonly state: "staged" | "ready"
	readonly source_fingerprint: string | null
}

interface EventJsonRow {
	readonly sequence: number | bigint
	readonly event_json: string
	readonly staged_at: string
	readonly ready_at: string | null
}

interface CountRow {
	readonly count: number | bigint
}

interface QuickCheckRow {
	readonly quick_check: string
}

interface WalCheckpointRow {
	readonly busy: number | bigint
	readonly log: number | bigint
	readonly checkpointed: number | bigint
}

interface OutboxUsageRow {
	readonly count: number | bigint
	readonly bytes: number | bigint
}

interface SequenceRow {
	readonly sequence: number | bigint | null
}

interface ConsumerRow {
	readonly consumer_id: string
	readonly tenant_id: string
	readonly active: number | bigint
	readonly last_acked_sequence: number | bigint
	readonly accepted_gap_generation: number | bigint
	readonly lease_token_hash: string | null
	readonly lease_expires_at: string | null
	readonly claimed_through_sequence: number | bigint | null
	readonly registered_at: string
	readonly disabled_at: string | null
}

interface EventIdRow {
	readonly event_id: string
}

interface StagedOccurrenceRow extends EventIdRow {
	readonly source_fingerprint: string | null
}

interface ActiveRevisionRow {
	readonly revision: number | bigint
}

export interface StageEventsResult {
	readonly dropped: number
	readonly inserted: number
	readonly deduplicated: number
	readonly eventIds: readonly string[]
}

export interface EventingControlSnapshotValidation {
	readonly schemaVersion: number
	readonly projectionRevisions: number
	readonly projectionFailures: number
	readonly stagedEvents: number
	readonly readyEvents: number
}

export interface LocalEventingControlLimits {
	readonly maxOutboxEvents: number
	readonly maxOutboxBytes: number
	readonly retainAcknowledgedReadyEvents?: number
}

interface ResolvedLocalEventingControlLimits {
	readonly maxOutboxEvents: number
	readonly maxOutboxBytes: number
	readonly retainAcknowledgedReadyEvents: number
}

export interface EventingOutboxRecord {
	readonly sequence: number
	readonly event: MapleCloudEvent
	readonly stagedAt: string
	readonly readyAt: string | null
}

export interface EventingOutboxPage {
	readonly events: readonly EventingOutboxRecord[]
	readonly nextCursor: number | null
}

export type EventConsumerStart = "beginning" | "latest"

export interface EventConsumer {
	readonly consumerId: string
	readonly tenantId: string
	readonly active: boolean
	readonly lastAcknowledgedSequence: number
	readonly leaseExpiresAt: string | null
	readonly claimedThroughSequence: number | null
	readonly registeredAt: string
	readonly disabledAt: string | null
}

export interface EventConsumerClaim {
	readonly consumerId: string
	readonly leaseToken: string | null
	readonly leaseExpiresAt: string | null
	readonly throughSequence: number | null
	readonly events: readonly EventingOutboxRecord[]
}

export interface EventConsumerAcknowledgement {
	readonly consumerId: string
	readonly acknowledgedThrough: number
	readonly prunedEvents: number
}

export class EventConsumerInputError extends Schema.TaggedError<EventConsumerInputError>()(
	"@maple/cli/eventing/EventConsumerInputInvalid",
	{ message: Schema.String },
) {
	static create(message: string) {
		return new EventConsumerInputError({ message })
	}
}
export class EventConsumerNotFoundError extends Schema.TaggedError<EventConsumerNotFoundError>()(
	"@maple/cli/eventing/EventConsumerNotFound",
	{ message: Schema.String, consumerId: Schema.String },
) {
	static create(message: string, consumerId: string) {
		return new EventConsumerNotFoundError({ message, consumerId })
	}
}
export class EventConsumerConflictError extends Schema.TaggedError<EventConsumerConflictError>()(
	"@maple/cli/eventing/EventConsumerConflict",
	{
		message: Schema.String,
		consumerId: Schema.String,
	},
) {
	static create(message: string, consumerId: string) {
		return new EventConsumerConflictError({ message, consumerId })
	}
}

export class EventConsumerLeaseError extends Schema.TaggedError<EventConsumerLeaseError>()(
	"@maple/cli/eventing/EventConsumerLeaseConflict",
	{
		message: Schema.String,
		consumerId: Schema.String,
		expiresAtMs: Schema.NullOr(Schema.Number),
	},
) {
	static create(message: string, consumerId: string, expiresAt: string | null) {
		return new EventConsumerLeaseError({
			message,
			consumerId,
			expiresAtMs: expiresAt === null ? null : Date.parse(expiresAt),
		})
	}
}

export class EventConsumerDeliveryGapError extends Schema.TaggedError<EventConsumerDeliveryGapError>()(
	"@maple/cli/eventing/EventConsumerDeliveryGap",
	{
		message: Schema.String,
		consumerId: Schema.String,
		generation: Schema.Number,
		droppedEvents: Schema.Number,
	},
) {}
export class OutboxAdministrationInvalid extends Schema.TaggedError<OutboxAdministrationInvalid>()(
	"@maple/cli/eventing/OutboxAdministrationInvalid",
	{ message: Schema.String },
) {}
export interface DeliveryGap {
	readonly generation: number
	readonly droppedEvents: number
	readonly lastDroppedAt: string | null
}
interface DeliveryGapRow {
	readonly generation: number | bigint
	readonly dropped_events: number | bigint
	readonly last_dropped_at: string
}

/** Any other control-store failure: SQLite, an invariant, or a corrupt row. */
export class EventingControlStoreError extends Schema.TaggedError<EventingControlStoreError>()(
	"@maple/cli/eventing/ControlStoreFailed",
	{ message: Schema.String, cause: Schema.optionalKey(Schema.Defect()) },
) {}

export type EventConsumerFailure =
	| EventConsumerInputError
	| EventConsumerNotFoundError
	| EventConsumerConflictError
	| EventConsumerLeaseError
	| EventConsumerDeliveryGapError
	| EventingControlStoreError

const storeError = (message: string): EventingControlStoreError => new EventingControlStoreError({ message })

const isStoreError = Schema.is(EventingControlStoreError)
const isConsumerFailure = Schema.is(
	Schema.Union([
		EventConsumerInputError,
		EventConsumerNotFoundError,
		EventConsumerConflictError,
		EventConsumerLeaseError,
		EventConsumerDeliveryGapError,
		EventingControlStoreError,
	]),
)
const isOutboxAdministrationInvalid = Schema.is(OutboxAdministrationInvalid)

/** Maps a failure thrown inside one synchronous SQLite step onto the typed channel. */
const storeFailure = (error: unknown): EventingControlStoreError =>
	isStoreError(error)
		? error
		: new EventingControlStoreError({
				message: error instanceof Error ? error.message : String(error),
				cause: error,
			})
const consumerFailure = (error: unknown): EventConsumerFailure =>
	isConsumerFailure(error) ? error : storeFailure(error)
const administrationFailure = (error: unknown): OutboxAdministrationInvalid | EventingControlStoreError =>
	isOutboxAdministrationInvalid(error) ? error : storeFailure(error)

const asNumber = (value: number | bigint): number => {
	const number = Number(value)
	if (!Number.isSafeInteger(number) || number < 0) throw storeError(`invalid SQLite integer: ${value}`)
	return number
}

const decodeProjection = (json: string): SignalProjectionSpec =>
	decodeSignalProjectionSpec(Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(json))

const decodeEvent = (json: string): MapleCloudEvent => {
	const validated = validateMapleCloudEvent(
		Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(json),
	)
	if (Result.isFailure(validated)) throw validated.failure
	return validated.success.event
}

const assertRealDatabaseFile = (path: string): void => {
	const info = Result.try(() => lstatSync(path))
	if (Result.isFailure(info)) {
		if (Schema.is(Schema.Struct({ code: Schema.Literal("ENOENT") }))(info.failure)) return
		throw info.failure
	}
	if (info.success.isSymbolicLink() || !info.success.isFile())
		throw storeError(`eventing control database is not a real file: ${path}`)
}

const configure = (db: Database): void => {
	db.exec("PRAGMA foreign_keys = ON")
	db.exec("PRAGMA trusted_schema = OFF")
	db.exec("PRAGMA busy_timeout = 5000")
}

const checkpointWal = (db: Database): void => {
	const result = db.query<WalCheckpointRow, []>("PRAGMA wal_checkpoint(TRUNCATE)").get()
	if (!result) throw storeError("eventing control WAL checkpoint returned no result")
	const busy = asNumber(result.busy)
	const log = asNumber(result.log)
	const checkpointed = asNumber(result.checkpointed)
	if (busy !== 0 || log !== 0)
		throw storeError(
			`eventing control WAL checkpoint incomplete (busy=${busy}, log=${log}, checkpointed=${checkpointed})`,
		)
}

const validateLimits = (limits: LocalEventingControlLimits): ResolvedLocalEventingControlLimits => {
	if (!Number.isSafeInteger(limits.maxOutboxEvents) || limits.maxOutboxEvents < 1)
		throw storeError("maxOutboxEvents must be a positive safe integer")
	if (!Number.isSafeInteger(limits.maxOutboxBytes) || limits.maxOutboxBytes < 1)
		throw storeError("maxOutboxBytes must be a positive safe integer")
	const retainAcknowledgedReadyEvents =
		limits.retainAcknowledgedReadyEvents ?? DEFAULT_RETAIN_ACKNOWLEDGED_READY_EVENTS
	if (!Number.isSafeInteger(retainAcknowledgedReadyEvents) || retainAcknowledgedReadyEvents < 0)
		throw storeError("retainAcknowledgedReadyEvents must be a non-negative safe integer")
	return { ...limits, retainAcknowledgedReadyEvents }
}

const validateOpenDatabase = (
	db: Database,
	acceptedSchemaVersions: readonly number[] = [CONTROL_SCHEMA_VERSION],
): EventingControlSnapshotValidation => {
	const quick = db.query<QuickCheckRow, []>("PRAGMA quick_check").get()
	if (quick?.quick_check !== "ok") throw storeError(`eventing control database quick_check failed`)
	const version = db.query<UserVersionRow, []>("PRAGMA user_version").get()
	if (!version) throw storeError("eventing control database has no schema version")
	const schemaVersion = asNumber(version.user_version)
	if (!acceptedSchemaVersions.includes(schemaVersion))
		throw storeError(
			`unsupported eventing control schema ${schemaVersion}; expected ${acceptedSchemaVersions.join(" or ")}`,
		)
	// Full accounting verification belongs at open/restore, never on the ingest hot path.
	const accounting = db.prepare<CountRow, []>(`
		SELECT count(*) AS count FROM outbox_usage
		WHERE singleton = 1
		AND count = (SELECT count(*) FROM outbox_events)
		AND bytes = (SELECT coalesce(sum(length(CAST(event_json AS BLOB))), 0) FROM outbox_events)
	`)
	try {
		const row = accounting.get()
		if (row === null || asNumber(row.count) !== 1)
			throw storeError("eventing control outbox accounting is inconsistent")
	} finally {
		accounting.finalize()
	}
	const count = (where: string): number => {
		const row = db.query<CountRow, []>(`SELECT count(*) AS count FROM outbox_events ${where}`).get()
		if (!row) throw storeError("eventing control count query returned no row")
		return asNumber(row.count)
	}
	const revisions = db.query<CountRow, []>("SELECT count(*) AS count FROM projection_revisions").get()
	if (!revisions) throw storeError("eventing projection count query returned no row")
	const failures = db.query<CountRow, []>("SELECT count(*) AS count FROM projection_failures").get()
	if (!failures) throw storeError("eventing projection-failure count query returned no row")
	const invalidReadiness = db
		.query<CountRow, []>(
			`SELECT count(*) AS count
			 FROM outbox_events AS event
			 LEFT JOIN outbox_ready_events AS readiness ON readiness.event_id = event.event_id
			 WHERE (event.state = 'ready' AND (
			     readiness.event_id IS NULL OR event.ready_at IS NULL OR event.ready_at <> readiness.ready_at
			 )) OR (event.state = 'staged' AND (
			     readiness.event_id IS NOT NULL OR event.ready_at IS NOT NULL
			 ))`,
		)
		.get()
	if (!invalidReadiness) throw storeError("eventing readiness validation query returned no row")
	if (asNumber(invalidReadiness.count) !== 0)
		throw storeError("eventing control database has inconsistent outbox readiness state")
	{
		const consumers = db
			.query<Pick<ConsumerRow, "lease_expires_at" | "registered_at" | "disabled_at">, []>(
				"SELECT lease_expires_at, registered_at, disabled_at FROM event_consumers",
			)
			.all()
		for (const consumer of consumers) {
			canonicalInstant(consumer.registered_at, "event consumer registeredAt")
			if (consumer.lease_expires_at !== null)
				canonicalInstant(consumer.lease_expires_at, "event consumer leaseExpiresAt")
			if (consumer.disabled_at !== null)
				canonicalInstant(consumer.disabled_at, "event consumer disabledAt")
		}
	}
	{
		const statement = db.prepare<CountRow, []>(
			`SELECT count(*) AS count
				 FROM outbox_events
				 WHERE state = 'staged'
				   AND source_occurrence_id IS NOT NULL
				   AND (
				       source_fingerprint IS NULL
				       OR length(source_fingerprint) <> 71
				       OR substr(source_fingerprint, 1, 7) <> 'sha256:'
				       OR substr(source_fingerprint, 8) GLOB '*[^0-9a-f]*'
				   )`,
		)
		let invalidFingerprints: CountRow | null
		try {
			invalidFingerprints = statement.get()
		} finally {
			statement.finalize()
		}
		if (invalidFingerprints === null)
			throw storeError("eventing staged source-fingerprint validation returned no row")
		if (asNumber(invalidFingerprints.count) > 0)
			throw storeError("eventing control database has an invalid staged source fingerprint")
	}
	return {
		schemaVersion,
		projectionRevisions: asNumber(revisions.count),
		projectionFailures: asNumber(failures.count),
		stagedEvents: count("WHERE state = 'staged'"),
		readyEvents: count("WHERE state = 'ready'"),
	}
}

const CONSUMER_ID = /^[a-z][a-z0-9._-]{0,63}$/
const LEASE_TOKEN = /^[0-9a-f]{64}$/

const validateConsumerId = (consumerId: string): string => {
	if (!CONSUMER_ID.test(consumerId))
		throw EventConsumerInputError.create(
			"consumerId must start with a lowercase letter and contain at most 64 lowercase letters, digits, dots, underscores, or hyphens",
		)
	return consumerId
}

const canonicalInstant = (value: string, label: string): number => {
	const milliseconds = Date.parse(value)
	if (Number.isNaN(milliseconds) || new Date(milliseconds).toISOString() !== value)
		throw EventConsumerInputError.create(`${label} must be canonical ISO-8601`)
	return milliseconds
}

const tokenHash = (token: string): string => createHash("sha256").update(token).digest("hex")

const tokenHashMatches = (expected: string, token: string): boolean => {
	if (!LEASE_TOKEN.test(token)) return false
	const left = Buffer.from(expected, "hex")
	const right = Buffer.from(tokenHash(token), "hex")
	return left.length === right.length && timingSafeEqual(left, right)
}

const decodeConsumer = (row: ConsumerRow): EventConsumer => ({
	consumerId: row.consumer_id,
	tenantId: row.tenant_id,
	active: asNumber(row.active) === 1,
	lastAcknowledgedSequence: asNumber(row.last_acked_sequence),
	leaseExpiresAt: row.lease_expires_at,
	claimedThroughSequence:
		row.claimed_through_sequence === null ? null : asNumber(row.claimed_through_sequence),
	registeredAt: row.registered_at,
	disabledAt: row.disabled_at,
})

const DEFAULT_LIMITS: LocalEventingControlLimits = {
	maxOutboxEvents: DEFAULT_MAX_OUTBOX_EVENTS,
	maxOutboxBytes: DEFAULT_MAX_OUTBOX_BYTES,
	retainAcknowledgedReadyEvents: DEFAULT_RETAIN_ACKNOWLEDGED_READY_EVENTS,
}

/** Where the control store lives; supplied by the application root. */
export class LocalEventingControlConfig extends Context.Service<
	LocalEventingControlConfig,
	{ readonly dataDir: string; readonly limits?: LocalEventingControlLimits }
>()("@maple/cli/eventing/LocalEventingControlConfig") {}

export type OutboxCapacity = LocalEventingControlLimits & {
	readonly currentEvents: number
	readonly currentBytes: number
}

export interface LocalEventingControlStoreApi {
	readonly path: string
	readonly saveProjection: (
		spec: SignalProjectionSpec,
		createdAt?: string,
	) => Effect.Effect<void, EventingControlStoreError>
	readonly loadEnabledProjections: (
		tenantId: string,
	) => Effect.Effect<readonly SignalProjectionSpec[], EventingControlStoreError>
	readonly stageEvents: (
		events: readonly MapleCloudEvent[],
		sourceFingerprints?: ReadonlyMap<string, string>,
		stagedAt?: string,
	) => Effect.Effect<StageEventsResult, EventingControlStoreError>
	readonly deliveryGap: (tenantId: string) => Effect.Effect<DeliveryGap, EventingControlStoreError>
	readonly acceptDeliveryGap: (
		tenantId: string,
		consumerId: string,
		generation: number,
	) => Effect.Effect<DeliveryGap, EventConsumerFailure>
	/** Operator-authorized loss; the HTTP caller drains admission before invoking this transaction. */
	readonly abandonEvents: (
		tenantId: string,
		eventIds: readonly string[],
	) => Effect.Effect<
		{ readonly abandoned: number; readonly gap: DeliveryGap },
		OutboxAdministrationInvalid | EventingControlStoreError
	>
	readonly hasStagedSourceKind: (tenantId: string, sourceKind: string) => Effect.Effect<boolean>
	readonly hasStagedSourceOccurrence: (
		tenantId: string,
		sourceKind: string,
		source: string,
		sourceOccurrenceId: string,
	) => Effect.Effect<boolean, EventingControlStoreError>
	readonly stagedEventIdsForOccurrence: (
		tenantId: string,
		sourceKind: string,
		source: string,
		sourceOccurrenceId: string,
		sourceFingerprint: string,
	) => Effect.Effect<readonly string[], EventingControlStoreError>
	readonly markReady: (
		eventIds: readonly string[],
		readyAt?: string,
	) => Effect.Effect<void, EventingControlStoreError>
	readonly listReady: (
		limit?: number,
		after?: number,
	) => Effect.Effect<EventingOutboxPage, EventingControlStoreError>
	readonly listStaged: (
		limit?: number,
		after?: number,
	) => Effect.Effect<EventingOutboxPage, EventingControlStoreError>
	readonly listConsumers: (
		tenantId: string,
	) => Effect.Effect<readonly EventConsumer[], EventingControlStoreError>
	readonly registerConsumer: (
		tenantId: string,
		consumerId: string,
		startAt: EventConsumerStart,
		registeredAt?: string,
	) => Effect.Effect<EventConsumer, EventConsumerFailure>
	readonly disableConsumer: (
		tenantId: string,
		consumerId: string,
		disabledAt?: string,
	) => Effect.Effect<EventConsumer, EventConsumerFailure>
	readonly claimReady: (
		tenantId: string,
		consumerId: string,
		limit: number,
		leaseSeconds: number,
		now?: string,
	) => Effect.Effect<EventConsumerClaim, EventConsumerFailure>
	readonly acknowledgeClaim: (
		tenantId: string,
		consumerId: string,
		leaseToken: string,
		throughSequence: number,
		now?: string,
	) => Effect.Effect<EventConsumerAcknowledgement, EventConsumerFailure>
	readonly outboxCapacity: Effect.Effect<OutboxCapacity, EventingControlStoreError>
	readonly recordProjectionFailures: (
		tenantId: string,
		failures: readonly ProjectionFailure[],
		createdAt?: string,
	) => Effect.Effect<void, EventingControlStoreError>
	readonly validate: Effect.Effect<EventingControlSnapshotValidation, EventingControlStoreError>
	/** Synchronous so a caller can pair it with another synchronous capture. */
	readonly captureSnapshot: Effect.Effect<Uint8Array, EventingControlStoreError>
	readonly backupTo: (
		path: string,
	) => Effect.Effect<EventingControlSnapshotValidation, EventingControlStoreError>
}

const now = (): string => new Date().toISOString()

/** Opens, migrates, and validates the database; a failure here closes the handle it opened. */
const openDatabase = (path: string): Effect.Effect<Database, EventingControlStoreError> =>
	Effect.try({
		try: () => {
			assertRealDatabaseFile(path)
			return new Database(path, { create: true, readwrite: true, strict: true, safeIntegers: true })
		},
		catch: storeFailure,
	}).pipe(
		Effect.flatMap((db) =>
			Effect.try({
				try: () => {
					configure(db)
					db.exec("PRAGMA journal_mode = WAL")
					db.exec("PRAGMA synchronous = FULL")
					const version = db.query<UserVersionRow, []>("PRAGMA user_version").get()
					if (!version) throw storeError("eventing control database has no schema version")
					let schemaVersion = asNumber(version.user_version)
					if (schemaVersion === 0) {
						db.transaction(() => db.exec(CREATE_SCHEMA)).exclusive()
						schemaVersion = CONTROL_SCHEMA_VERSION
					}
					if (schemaVersion !== CONTROL_SCHEMA_VERSION)
						throw storeError(
							`unsupported eventing control schema ${schemaVersion}; expected ${CONTROL_SCHEMA_VERSION}`,
						)
					chmodSync(path, 0o600)
					validateOpenDatabase(db)
					return db
				},
				catch: storeFailure,
			}).pipe(Effect.onError(() => Effect.sync(() => db.close()))),
		),
	)

/** A clean close truncates the WAL so the next open and any file-level copy see one file. */
const closeDatabase = (db: Database): Effect.Effect<void> =>
	Effect.try({
		try: () => {
			checkpointWal(db)
			db.close(true)
		},
		catch: (cause) =>
			new EventingControlStoreError({ message: "failed to close eventing control store", cause }),
	}).pipe(Effect.catchTag("@maple/cli/eventing/ControlStoreFailed", (error) => Effect.logError(error)))

export class LocalEventingControlStore extends Context.Service<
	LocalEventingControlStore,
	LocalEventingControlStoreApi
>()("@maple/cli/eventing/LocalEventingControlStore") {
	static readonly make: Effect.Effect<
		LocalEventingControlStoreApi,
		EventingControlStoreError,
		LocalEventingControlConfig | Scope.Scope
	> = Effect.gen(function* () {
		const config = yield* LocalEventingControlConfig
		const limits = yield* Effect.try({
			try: () => validateLimits(config.limits ?? DEFAULT_LIMITS),
			catch: storeFailure,
		})
		yield* Effect.tryPromise({
			try: () => ensurePrivateDirectory(eventingControlDirectory(config.dataDir)),
			catch: storeFailure,
		})
		const path = eventingControlPath(config.dataDir)
		const db = yield* Effect.acquireRelease(openDatabase(path), closeDatabase)

		const readStagedSourceKinds = (): Set<string> => {
			const statement = db.prepare<{ tenant_id: string; source_kind: string }, []>(
				"SELECT DISTINCT tenant_id, source_kind FROM outbox_events WHERE state = 'staged' AND source_kind IS NOT NULL",
			)
			try {
				return new Set(statement.all().map((row) => JSON.stringify([row.tenant_id, row.source_kind])))
			} finally {
				statement.finalize()
			}
		}
		// Read on every ingest request, so it is cached and refreshed after each committed write.
		let stagedSourceKinds = yield* Effect.try({ try: readStagedSourceKinds, catch: storeFailure })
		const refreshStagedSourceKinds = Effect.try({
			try: () => {
				stagedSourceKinds = readStagedSourceKinds()
			},
			catch: storeFailure,
		})

		const readDeliveryGap = (tenantId: string): DeliveryGap => {
			const statement = db.prepare<DeliveryGapRow, [string]>(
				"SELECT generation, dropped_events, last_dropped_at FROM delivery_gaps WHERE tenant_id = ?",
			)
			try {
				const row = statement.get(tenantId)
				return row === null
					? { generation: 0, droppedEvents: 0, lastDroppedAt: null }
					: {
							generation: asNumber(row.generation),
							droppedEvents: asNumber(row.dropped_events),
							lastDroppedAt: row.last_dropped_at,
						}
			} finally {
				statement.finalize()
			}
		}
		const recordDeliveryGap = (tenantId: string, count: number, at: string): void => {
			if (count === 0) return
			db.run(
				`INSERT INTO delivery_gaps (tenant_id, generation, dropped_events, last_dropped_at) VALUES (?, 1, ?, ?)
   ON CONFLICT (tenant_id) DO UPDATE SET generation = generation + 1, dropped_events = dropped_events + excluded.dropped_events, last_dropped_at = excluded.last_dropped_at`,
				[tenantId, count, at],
			)
		}
		const outboxUsage = (): OutboxUsageRow => {
			const statement = db.prepare<OutboxUsageRow, []>(
				"SELECT count, bytes FROM outbox_usage WHERE singleton = 1",
			)
			try {
				const usage = statement.get()
				if (usage === null) throw storeError("event outbox usage query returned no row")
				return usage
			} finally {
				statement.finalize()
			}
		}
		const consumerRow = (tenantId: string, consumerId: string): ConsumerRow | null =>
			db
				.query<ConsumerRow, [string, string]>(
					`SELECT consumer_id, tenant_id, active, last_acked_sequence, accepted_gap_generation, lease_token_hash,
				        lease_expires_at, claimed_through_sequence, registered_at, disabled_at
				 FROM event_consumers
				 WHERE tenant_id = ? AND consumer_id = ?`,
				)
				.get(tenantId, consumerId)
		const consumerLag = (tenantId: string, lastAcknowledgedSequence: number): number => {
			const latest = db
				.query<SequenceRow, [string]>(
					`SELECT max(readiness.sequence) AS sequence
				 FROM outbox_ready_events AS readiness
				 INNER JOIN outbox_events AS event ON event.event_id = readiness.event_id
				 WHERE event.tenant_id = ? AND event.state = 'ready'`,
				)
				.get(tenantId)
			return Math.max(
				0,
				(latest?.sequence == null ? 0 : asNumber(latest.sequence)) - lastAcknowledgedSequence,
			)
		}
		const pruneAcknowledgedReady = (tenantId: string): number => {
			const boundary = db
				.query<SequenceRow, [string]>(
					"SELECT min(last_acked_sequence) AS sequence FROM event_consumers WHERE tenant_id = ? AND active = 1",
				)
				.get(tenantId)
			if (boundary?.sequence == null) return 0
			const rows = db
				.query<EventIdRow, [string, number]>(
					`SELECT readiness.event_id
				 FROM outbox_ready_events AS readiness
				 INNER JOIN outbox_events AS event ON event.event_id = readiness.event_id
				 WHERE event.tenant_id = ? AND readiness.sequence <= ?
				 ORDER BY readiness.sequence`,
				)
				.all(tenantId, asNumber(boundary.sequence))
			const pruneCount = Math.max(0, rows.length - limits.retainAcknowledgedReadyEvents)
			for (const { event_id } of rows.slice(0, pruneCount)) {
				db.run("DELETE FROM outbox_ready_events WHERE event_id = ?", [event_id])
				db.run("DELETE FROM outbox_events WHERE event_id = ? AND state = 'ready'", [event_id])
			}
			return pruneCount
		}
		const listOutbox = (
			state: "ready" | "staged",
			limit = 100,
			after = 0,
		): Effect.Effect<EventingOutboxPage, EventingControlStoreError> =>
			Effect.try({
				try: () => {
					if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000)
						throw storeError("outbox-event limit must be between 1 and 1000")
					if (!Number.isSafeInteger(after) || after < 0)
						throw storeError("outbox cursor must be a non-negative safe integer")
					const rows =
						state === "ready"
							? db
									.query<EventJsonRow, [number, number]>(
										`SELECT readiness.sequence, event.event_json, event.staged_at, readiness.ready_at
							 FROM outbox_ready_events AS readiness
							 INNER JOIN outbox_events AS event ON event.event_id = readiness.event_id
							 WHERE event.state = 'ready' AND readiness.sequence > ?
							 ORDER BY readiness.sequence
							 LIMIT ?`,
									)
									.all(after, limit + 1)
							: db
									.query<EventJsonRow, [number, number]>(
										`SELECT sequence, event_json, staged_at, ready_at
							 FROM outbox_events
							 WHERE state = 'staged' AND sequence > ?
							 ORDER BY sequence
							 LIMIT ?`,
									)
									.all(after, limit + 1)
					const hasMore = rows.length > limit
					const pageRows = hasMore ? rows.slice(0, limit) : rows
					const page = pageRows.map(({ sequence, event_json, staged_at, ready_at }) => ({
						sequence: asNumber(sequence),
						event: decodeEvent(event_json),
						stagedAt: staged_at,
						readyAt: ready_at,
					}))
					return {
						events: page,
						nextCursor: hasMore ? (page.at(-1)?.sequence ?? null) : null,
					}
				},
				catch: storeFailure,
			})
		const captureSnapshot = Effect.try({
			try: () => {
				checkpointWal(db)
				return db.serialize()
			},
			catch: storeFailure,
		})

		const saveProjection: LocalEventingControlStoreApi["saveProjection"] = (spec, createdAt = now()) =>
			Effect.try({
				try: () => {
					const decoded = decodeSignalProjectionSpec(spec)
					if (!isJsonValue(decoded)) throw storeError("projection spec must be finite JSON")
					const specJson = canonicalJson(decoded)
					db.transaction(() => {
						const latest = db
							.query<RevisionRow, [string, string]>(
								"SELECT max(revision) AS revision FROM projection_revisions WHERE tenant_id = ? AND projection_id = ?",
							)
							.get(decoded.tenantId, decoded.id)
						const latestRevision = latest?.revision == null ? null : asNumber(latest.revision)
						const existing = db
							.query<ProjectionJsonRow, [string, string, number]>(
								"SELECT spec_json FROM projection_revisions WHERE tenant_id = ? AND projection_id = ? AND revision = ?",
							)
							.get(decoded.tenantId, decoded.id, decoded.revision)
						if (existing) {
							if (existing.spec_json !== specJson)
								throw storeError(
									`projection revision is immutable: ${decoded.tenantId}:${decoded.id}@${decoded.revision}`,
								)
							if (latestRevision !== decoded.revision)
								throw storeError(
									`stale projection revision: ${decoded.tenantId}:${decoded.id}@${decoded.revision}; latest is ${latestRevision}`,
								)
							const active = db
								.query<ActiveRevisionRow, [string, string]>(
									"SELECT revision FROM active_projections WHERE tenant_id = ? AND projection_id = ?",
								)
								.get(decoded.tenantId, decoded.id)
							const activeRevision = active === null ? null : asNumber(active.revision)
							const expectedActiveRevision = decoded.enabled ? decoded.revision : null
							if (activeRevision !== expectedActiveRevision)
								throw storeError(
									`projection active state conflicts with exact revision replay: ${decoded.tenantId}:${decoded.id}@${decoded.revision}`,
								)
							return
						} else {
							const expected = latestRevision === null ? 1 : latestRevision + 1
							if (decoded.revision !== expected)
								throw storeError(
									`projection revision must be ${expected}: ${decoded.tenantId}:${decoded.id}@${decoded.revision}`,
								)
							db.run(
								"INSERT INTO projection_revisions (tenant_id, projection_id, revision, enabled, spec_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
								[
									decoded.tenantId,
									decoded.id,
									decoded.revision,
									decoded.enabled ? 1 : 0,
									specJson,
									createdAt,
								],
							)
						}

						if (decoded.enabled)
							db.run(
								"INSERT INTO active_projections (tenant_id, projection_id, revision) VALUES (?, ?, ?) ON CONFLICT (tenant_id, projection_id) DO UPDATE SET revision = excluded.revision",
								[decoded.tenantId, decoded.id, decoded.revision],
							)
						else
							db.run(
								"DELETE FROM active_projections WHERE tenant_id = ? AND projection_id = ?",
								[decoded.tenantId, decoded.id],
							)
					}).immediate()
				},
				catch: storeFailure,
			})

		const loadEnabledProjections: LocalEventingControlStoreApi["loadEnabledProjections"] = (tenantId) =>
			Effect.try({
				try: () =>
					db
						.query<ProjectionJsonRow, [string]>(
							`SELECT r.spec_json
                 FROM active_projections a
                 JOIN projection_revisions r
                   ON r.tenant_id = a.tenant_id
                  AND r.projection_id = a.projection_id
                  AND r.revision = a.revision
                WHERE a.tenant_id = ?
                ORDER BY a.projection_id`,
						)
						.all(tenantId)
						.map(({ spec_json }) => decodeProjection(spec_json)),
				catch: storeFailure,
			})

		const stageEvents: LocalEventingControlStoreApi["stageEvents"] = (
			events,
			sourceFingerprints = new Map(),
			stagedAt = now(),
		) =>
			Effect.try({
				try: () =>
					db
						.transaction(() => {
							let inserted = 0
							let deduplicated = 0
							const droppedByTenant = new Map<string, number>()
							let dropped = 0
							const eventIds: string[] = []
							const usage = outboxUsage()
							let outboxEvents = asNumber(usage.count)
							let outboxBytes = asNumber(usage.bytes)
							for (const candidate of events) {
								const validation = validateMapleCloudEvent(candidate)
								if (Result.isFailure(validation)) throw validation.failure
								const {
									event,
									canonicalJson: eventJson,
									byteLength: eventBytes,
								} = validation.success
								const sourceFingerprint = sourceFingerprints.get(event.id) ?? null
								if (
									sourceFingerprint !== null &&
									!/^sha256:[0-9a-f]{64}$/.test(sourceFingerprint)
								)
									throw storeError(`event has invalid source fingerprint: ${event.id}`)
								if (event.sourceoccurrenceid !== undefined && sourceFingerprint === null)
									throw storeError(
										`event with source occurrence ID requires a source fingerprint: ${event.id}`,
									)
								let sourceKind: string | null = null
								if (event.sourceoccurrenceid !== undefined) {
									const projection = db
										.query<ProjectionJsonRow, [string, string, number]>(
											"SELECT spec_json FROM projection_revisions WHERE tenant_id = ? AND projection_id = ? AND revision = ?",
										)
										.get(event.tenantid, event.projectionid, event.projectionrevision)
									if (projection === null)
										throw storeError(
											`event references unknown projection revision: ${event.tenantid}:${event.projectionid}@${event.projectionrevision}`,
										)
									sourceKind = decodeProjection(projection.spec_json).sourceKind
								}
								const existing = db
									.query<EventRow, [string]>(
										"SELECT event_id, event_json, state, source_fingerprint FROM outbox_events WHERE event_id = ?",
									)
									.get(event.id)
								if (existing) {
									if (existing.event_json !== eventJson)
										throw storeError(
											`event ID collision with different payload: ${event.id}`,
										)
									if (
										sourceFingerprint !== null &&
										existing.source_fingerprint !== null &&
										existing.source_fingerprint !== sourceFingerprint
									)
										throw storeError(
											`event ID collision with different source occurrence: ${event.id}`,
										)
									if (
										existing.state === "staged" &&
										sourceFingerprint !== null &&
										existing.source_fingerprint === null
									)
										throw storeError(
											`staged event has no recovery fingerprint: ${event.id}`,
										)
									deduplicated += 1
								} else {
									if (
										outboxEvents + 1 > limits.maxOutboxEvents ||
										outboxBytes + eventBytes > limits.maxOutboxBytes
									) {
										dropped += 1
										droppedByTenant.set(
											event.tenantid,
											(droppedByTenant.get(event.tenantid) ?? 0) + 1,
										)
										continue
									}
									db.run(
										"INSERT INTO outbox_events (event_id, tenant_id, projection_id, projection_revision, source_kind, source, source_occurrence_id, source_fingerprint, state, event_json, staged_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'staged', ?, ?)",
										[
											event.id,
											event.tenantid,
											event.projectionid,
											event.projectionrevision,
											sourceKind,
											event.sourceoccurrenceid === undefined ? null : event.source,
											event.sourceoccurrenceid ?? null,
											sourceFingerprint,
											eventJson,
											stagedAt,
										],
									)
									inserted += 1
									outboxEvents += 1
									outboxBytes += eventBytes
								}
								eventIds.push(event.id)
							}
							for (const [tenantId, count] of droppedByTenant)
								recordDeliveryGap(tenantId, count, stagedAt)
							return { inserted, deduplicated, dropped, eventIds }
						})
						.immediate(),
				catch: storeFailure,
			}).pipe(
				Effect.tapError(() => observeEventing({ operation: "outbox_stage", outcome: "failure" })),
				Effect.tap(() => refreshStagedSourceKinds),
				Effect.tap((result) =>
					Effect.all(
						[
							observeEventing({
								operation: "outbox_stage",
								outcome: "success",
								count: result.inserted,
							}),
							observeEventing({
								operation: "outbox_dedup",
								outcome: "success",
								count: result.deduplicated,
							}),
							observeEventing({
								operation: "outbox_stage",
								outcome: "dropped",
								count: result.dropped,
							}),
						],
						{ discard: true },
					),
				),
			)

		const deliveryGap: LocalEventingControlStoreApi["deliveryGap"] = (tenantId) =>
			Effect.try({ try: () => readDeliveryGap(tenantId), catch: storeFailure })

		const acceptDeliveryGap: LocalEventingControlStoreApi["acceptDeliveryGap"] = (
			tenantId,
			consumerId,
			generation,
		) =>
			Effect.try({
				try: () => {
					validateConsumerId(consumerId)
					return db
						.transaction(() => {
							const consumer = consumerRow(tenantId, consumerId)
							if (consumer === null)
								throw EventConsumerNotFoundError.create(
									`event consumer not found: ${consumerId}`,
									consumerId,
								)
							const gap = readDeliveryGap(tenantId)
							if (
								!Number.isSafeInteger(generation) ||
								generation < 1 ||
								generation !== gap.generation
							)
								throw EventConsumerConflictError.create(
									"delivery gap generation changed; inspect current health before accepting",
									consumerId,
								)
							db.run(
								"UPDATE event_consumers SET accepted_gap_generation = ? WHERE tenant_id = ? AND consumer_id = ?",
								[generation, tenantId, consumerId],
							)
							return gap
						})
						.immediate()
				},
				catch: consumerFailure,
			})

		const abandonEvents: LocalEventingControlStoreApi["abandonEvents"] = (tenantId, eventIds) =>
			Effect.try({
				try: () => {
					if (
						eventIds.length < 1 ||
						eventIds.length > 1000 ||
						new Set(eventIds).size !== eventIds.length
					)
						throw new OutboxAdministrationInvalid({
							message: "abandon requires 1–1000 distinct event IDs",
						})
					return db
						.transaction(() => {
							const lookup = db.prepare<EventIdRow, [string, string]>(
								"SELECT event_id FROM outbox_events WHERE tenant_id = ? AND event_id = ?",
							)
							try {
								for (const eventId of eventIds)
									if (lookup.get(tenantId, eventId) === null)
										throw new OutboxAdministrationInvalid({
											message: `unknown event ID for abandonment: ${eventId}`,
										})
							} finally {
								lookup.finalize()
							}
							for (const eventId of eventIds) {
								db.run("DELETE FROM outbox_ready_events WHERE event_id = ?", [eventId])
								db.run("DELETE FROM outbox_events WHERE tenant_id = ? AND event_id = ?", [
									tenantId,
									eventId,
								])
							}
							recordDeliveryGap(tenantId, eventIds.length, now())
							db.run(
								"UPDATE event_consumers SET lease_token_hash = NULL, lease_expires_at = NULL, claimed_through_sequence = NULL WHERE tenant_id = ?",
								[tenantId],
							)
							return { abandoned: eventIds.length, gap: readDeliveryGap(tenantId) }
						})
						.immediate()
				},
				catch: administrationFailure,
			}).pipe(
				Effect.tap(() => refreshStagedSourceKinds),
				Effect.tap((result) =>
					observeEventing({
						operation: "outbox_abandon",
						outcome: "success",
						count: result.abandoned,
					}),
				),
			)

		const hasStagedSourceKind: LocalEventingControlStoreApi["hasStagedSourceKind"] = (
			tenantId,
			sourceKind,
		) => Effect.sync(() => stagedSourceKinds.has(JSON.stringify([tenantId, sourceKind])))

		const hasStagedSourceOccurrence: LocalEventingControlStoreApi["hasStagedSourceOccurrence"] = (
			tenantId,
			sourceKind,
			source,
			sourceOccurrenceId,
		) =>
			Effect.try({
				try: () => {
					const row = db
						.query<CountRow, [string, string, string, string]>(
							"SELECT count(*) AS count FROM outbox_events WHERE tenant_id = ? AND source_kind = ? AND source = ? AND source_occurrence_id = ? AND state = 'staged'",
						)
						.get(tenantId, sourceKind, source, sourceOccurrenceId)
					if (row === null) throw storeError("staged source-occurrence query returned no row")
					return asNumber(row.count) > 0
				},
				catch: storeFailure,
			})

		const stagedEventIdsForOccurrence: LocalEventingControlStoreApi["stagedEventIdsForOccurrence"] = (
			tenantId,
			sourceKind,
			source,
			sourceOccurrenceId,
			sourceFingerprint,
		) =>
			Effect.try({
				try: () => {
					const rows = db
						.query<StagedOccurrenceRow, [string, string, string, string]>(
							"SELECT event_id, source_fingerprint FROM outbox_events WHERE tenant_id = ? AND source_kind = ? AND source = ? AND source_occurrence_id = ? AND state = 'staged' ORDER BY sequence",
						)
						.all(tenantId, sourceKind, source, sourceOccurrenceId)
					for (const row of rows) {
						if (row.source_fingerprint === null)
							throw storeError(
								`staged source occurrence has no recovery fingerprint: ${row.event_id}`,
							)
						if (row.source_fingerprint !== sourceFingerprint)
							throw storeError(`staged source occurrence collision: ${sourceOccurrenceId}`)
					}
					return rows.map(({ event_id }) => event_id)
				},
				catch: storeFailure,
			})

		const markReady: LocalEventingControlStoreApi["markReady"] = (eventIds, readyAt = now()) =>
			Effect.try({
				try: () =>
					db
						.transaction(() => {
							let markedReady = 0
							for (const eventId of eventIds) {
								const row = db
									.query<Pick<EventRow, "state">, [string]>(
										"SELECT state FROM outbox_events WHERE event_id = ?",
									)
									.get(eventId)
								if (!row) throw storeError(`cannot mark unknown event ready: ${eventId}`)
								if (row.state === "ready") continue
								db.run("INSERT INTO outbox_ready_events (event_id, ready_at) VALUES (?, ?)", [
									eventId,
									readyAt,
								])
								db.run(
									"UPDATE outbox_events SET state = 'ready', ready_at = ? WHERE event_id = ? AND state = 'staged'",
									[readyAt, eventId],
								)
								markedReady += 1
							}
							return markedReady
						})
						.immediate(),
				catch: storeFailure,
			}).pipe(
				Effect.tapError(() => observeEventing({ operation: "outbox_ready", outcome: "failure" })),
				Effect.tap(() => refreshStagedSourceKinds),
				Effect.flatMap((markedReady) =>
					observeEventing({ operation: "outbox_ready", outcome: "success", count: markedReady }),
				),
			)

		const listConsumers: LocalEventingControlStoreApi["listConsumers"] = (tenantId) =>
			Effect.try({
				try: () =>
					db
						.query<ConsumerRow, [string]>(
							`SELECT consumer_id, tenant_id, active, last_acked_sequence, accepted_gap_generation, lease_token_hash,
				        lease_expires_at, claimed_through_sequence, registered_at, disabled_at
				 FROM event_consumers
				 WHERE tenant_id = ?
				 ORDER BY consumer_id`,
						)
						.all(tenantId)
						.map(decodeConsumer),
				catch: storeFailure,
			})

		const registerConsumer: LocalEventingControlStoreApi["registerConsumer"] = (
			tenantId,
			consumerId,
			startAt,
			registeredAt = now(),
		) =>
			Effect.try({
				try: () => {
					validateConsumerId(consumerId)
					if (startAt !== "beginning" && startAt !== "latest")
						throw EventConsumerInputError.create("startAt must be beginning or latest")
					canonicalInstant(registeredAt, "event consumer registeredAt")
					return db
						.transaction(() => {
							const existing = consumerRow(tenantId, consumerId)
							if (existing)
								throw EventConsumerConflictError.create(
									`event consumer already exists: ${consumerId}`,
									consumerId,
								)
							const boundary = db
								.query<SequenceRow, [string]>(
									startAt === "latest"
										? `SELECT max(readiness.sequence) AS sequence
							   FROM outbox_ready_events AS readiness
							   INNER JOIN outbox_events AS event ON event.event_id = readiness.event_id
							   WHERE event.tenant_id = ?`
										: `SELECT min(readiness.sequence) AS sequence
							   FROM outbox_ready_events AS readiness
							   INNER JOIN outbox_events AS event ON event.event_id = readiness.event_id
							   WHERE event.tenant_id = ?`,
								)
								.get(tenantId)
							const sequence = boundary?.sequence == null ? 0 : asNumber(boundary.sequence)
							const lastAcknowledged =
								startAt === "beginning" ? Math.max(0, sequence - 1) : sequence
							db.run(
								"INSERT INTO event_consumers (consumer_id, tenant_id, active, last_acked_sequence, registered_at) VALUES (?, ?, 1, ?, ?)",
								[consumerId, tenantId, lastAcknowledged, registeredAt],
							)
							if (startAt === "latest")
								db.run(
									"UPDATE event_consumers SET accepted_gap_generation = ? WHERE tenant_id = ? AND consumer_id = ?",
									[readDeliveryGap(tenantId).generation, tenantId, consumerId],
								)
							const updated = consumerRow(tenantId, consumerId)
							if (updated === null)
								throw EventConsumerNotFoundError.create(
									`event consumer not found: ${consumerId}`,
									consumerId,
								)
							return decodeConsumer(updated)
						})
						.immediate()
				},
				catch: consumerFailure,
			})

		const disableConsumer: LocalEventingControlStoreApi["disableConsumer"] = (
			tenantId,
			consumerId,
			disabledAt = now(),
		) =>
			Effect.try({
				try: () => {
					validateConsumerId(consumerId)
					canonicalInstant(disabledAt, "event consumer disabledAt")
					return db
						.transaction(() => {
							const existing = consumerRow(tenantId, consumerId)
							if (!existing)
								throw EventConsumerNotFoundError.create(
									`unknown event consumer: ${consumerId}`,
									consumerId,
								)
							if (asNumber(existing.active) === 0) return decodeConsumer(existing)
							db.run(
								`UPDATE event_consumers
					 SET active = 0, lease_token_hash = NULL, lease_expires_at = NULL,
					     claimed_through_sequence = NULL, disabled_at = ?
					 WHERE tenant_id = ? AND consumer_id = ?`,
								[disabledAt, tenantId, consumerId],
							)
							pruneAcknowledgedReady(tenantId)
							const updated = consumerRow(tenantId, consumerId)
							if (updated === null)
								throw EventConsumerNotFoundError.create(
									`event consumer not found: ${consumerId}`,
									consumerId,
								)
							return decodeConsumer(updated)
						})
						.immediate()
				},
				catch: consumerFailure,
			})

		const observeConsumerFailure = (
			operation: "consumer_claim" | "consumer_ack",
			error: EventConsumerFailure,
		) =>
			Effect.all(
				[
					observeEventing({ operation, outcome: "failure" }),
					error._tag === "@maple/cli/eventing/EventConsumerLeaseConflict"
						? observeEventing({ operation: "consumer_lease", outcome: "failure" })
						: Effect.void,
				],
				{ discard: true },
			)

		const claimReady: LocalEventingControlStoreApi["claimReady"] = (
			tenantId,
			consumerId,
			limit,
			leaseSeconds,
			claimedAt = now(),
		) =>
			Effect.try({
				try: () => {
					validateConsumerId(consumerId)
					if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000)
						throw EventConsumerInputError.create("claim limit must be between 1 and 1000")
					if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 5 || leaseSeconds > 300)
						throw EventConsumerInputError.create("leaseSeconds must be between 5 and 300")
					const nowMilliseconds = canonicalInstant(claimedAt, "claim time")
					return db
						.transaction(() => {
							const consumer = consumerRow(tenantId, consumerId)
							if (!consumer)
								throw EventConsumerNotFoundError.create(
									`unknown event consumer: ${consumerId}`,
									consumerId,
								)
							const gap = readDeliveryGap(tenantId)
							if (gap.generation > asNumber(consumer.accepted_gap_generation))
								throw new EventConsumerDeliveryGapError({
									message:
										"Event delivery has a gap; an operator must acknowledge the reported generation before claiming more events",
									consumerId,
									generation: gap.generation,
									droppedEvents: gap.droppedEvents,
								})
							if (asNumber(consumer.active) === 0)
								throw EventConsumerConflictError.create(
									`event consumer is disabled: ${consumerId}`,
									consumerId,
								)
							if (
								consumer.lease_expires_at !== null &&
								canonicalInstant(consumer.lease_expires_at, "event consumer leaseExpiresAt") >
									nowMilliseconds
							)
								throw EventConsumerLeaseError.create(
									`event consumer already has an active lease: ${consumerId}`,
									consumerId,
									consumer.lease_expires_at,
								)
							const reclaimedExpiredLease = consumer.lease_expires_at !== null
							const lag = consumerLag(tenantId, asNumber(consumer.last_acked_sequence))

							const rows = db
								.query<EventJsonRow, [string, number, number]>(
									`SELECT readiness.sequence, event.event_json, event.staged_at, readiness.ready_at
						 FROM outbox_ready_events AS readiness
						 INNER JOIN outbox_events AS event ON event.event_id = readiness.event_id
						 WHERE event.tenant_id = ? AND event.state = 'ready' AND readiness.sequence > ?
						 ORDER BY readiness.sequence
						 LIMIT ?`,
								)
								.all(tenantId, asNumber(consumer.last_acked_sequence), limit)
							if (rows.length === 0) {
								db.run(
									"UPDATE event_consumers SET lease_token_hash = NULL, lease_expires_at = NULL, claimed_through_sequence = NULL WHERE tenant_id = ? AND consumer_id = ?",
									[tenantId, consumerId],
								)
								const claim: EventConsumerClaim = {
									consumerId,
									leaseToken: null,
									leaseExpiresAt: null,
									throughSequence: null,
									events: [],
								}
								return { claim, lag, reclaimedExpiredLease }
							}

							const leaseToken = randomBytes(32).toString("hex")
							const leaseExpiresAt = new Date(
								nowMilliseconds + leaseSeconds * 1_000,
							).toISOString()
							const last = rows.at(-1)
							if (last === undefined)
								throw EventConsumerConflictError.create("empty claim", consumerId)
							const throughSequence = asNumber(last.sequence)
							db.run(
								`UPDATE event_consumers
					 SET lease_token_hash = ?, lease_expires_at = ?, claimed_through_sequence = ?
					 WHERE tenant_id = ? AND consumer_id = ?`,
								[
									tokenHash(leaseToken),
									leaseExpiresAt,
									throughSequence,
									tenantId,
									consumerId,
								],
							)
							const claim: EventConsumerClaim = {
								consumerId,
								leaseToken,
								leaseExpiresAt,
								throughSequence,
								events: rows.map(({ sequence, event_json, staged_at, ready_at }) => ({
									sequence: asNumber(sequence),
									event: decodeEvent(event_json),
									stagedAt: staged_at,
									readyAt: ready_at,
								})),
							}
							return { claim, lag, reclaimedExpiredLease }
						})
						.immediate()
				},
				catch: consumerFailure,
			}).pipe(
				Effect.tapError((error) => observeConsumerFailure("consumer_claim", error)),
				Effect.tap(({ claim, lag, reclaimedExpiredLease }) =>
					Effect.all(
						[
							observeEventing({
								operation: "consumer_claim",
								outcome: claim.events.length === 0 ? "empty" : "success",
								count: Math.max(1, claim.events.length),
							}),
							observeEventing({ operation: "consumer_lag", outcome: "observed", lag }),
							reclaimedExpiredLease
								? observeEventing({ operation: "consumer_lease", outcome: "reclaimed" })
								: Effect.void,
						],
						{ discard: true },
					),
				),
				Effect.map(({ claim }) => claim),
			)

		const acknowledgeClaim: LocalEventingControlStoreApi["acknowledgeClaim"] = (
			tenantId,
			consumerId,
			leaseToken,
			throughSequence,
			acknowledgedAt = now(),
		) =>
			Effect.try({
				try: () => {
					validateConsumerId(consumerId)
					if (!Number.isSafeInteger(throughSequence) || throughSequence < 1)
						throw EventConsumerInputError.create(
							"throughSequence must be a positive safe integer",
						)
					const nowMilliseconds = canonicalInstant(acknowledgedAt, "acknowledgement time")
					return db
						.transaction((): EventConsumerAcknowledgement => {
							const consumer = consumerRow(tenantId, consumerId)
							if (!consumer)
								throw EventConsumerNotFoundError.create(
									`unknown event consumer: ${consumerId}`,
									consumerId,
								)
							if (asNumber(consumer.active) === 0)
								throw EventConsumerConflictError.create(
									`event consumer is disabled: ${consumerId}`,
									consumerId,
								)
							if (
								consumer.lease_token_hash === null ||
								consumer.lease_expires_at === null ||
								consumer.claimed_through_sequence === null
							)
								throw EventConsumerLeaseError.create(
									`event consumer has no active lease: ${consumerId}`,
									consumerId,
									consumer.lease_expires_at,
								)
							if (
								canonicalInstant(
									consumer.lease_expires_at,
									"event consumer leaseExpiresAt",
								) <= nowMilliseconds
							)
								throw EventConsumerLeaseError.create(
									`event consumer lease has expired: ${consumerId}`,
									consumerId,
									consumer.lease_expires_at,
								)
							if (!tokenHashMatches(consumer.lease_token_hash, leaseToken))
								throw EventConsumerLeaseError.create(
									"event consumer lease token does not match",
									consumerId,
									consumer.lease_expires_at,
								)
							const claimedThrough = asNumber(consumer.claimed_through_sequence)
							if (throughSequence !== claimedThrough)
								throw EventConsumerLeaseError.create(
									`acknowledgement must cover the complete claimed batch through sequence ${claimedThrough}`,
									consumerId,
									consumer.lease_expires_at,
								)
							db.run(
								`UPDATE event_consumers
					 SET last_acked_sequence = ?, lease_token_hash = NULL, lease_expires_at = NULL,
					     claimed_through_sequence = NULL
					 WHERE tenant_id = ? AND consumer_id = ?`,
								[throughSequence, tenantId, consumerId],
							)
							return {
								consumerId,
								acknowledgedThrough: throughSequence,
								prunedEvents: pruneAcknowledgedReady(tenantId),
							}
						})
						.immediate()
				},
				catch: consumerFailure,
			}).pipe(
				Effect.flatMap((acknowledgement) =>
					Effect.try({
						try: () => consumerLag(tenantId, acknowledgement.acknowledgedThrough),
						catch: storeFailure,
					}).pipe(
						Effect.tap((lag) =>
							Effect.all(
								[
									observeEventing({ operation: "consumer_ack", outcome: "success" }),
									observeEventing({ operation: "consumer_lag", outcome: "observed", lag }),
								],
								{ discard: true },
							),
						),
						Effect.as(acknowledgement),
					),
				),
				Effect.tapError((error) => observeConsumerFailure("consumer_ack", error)),
			)

		const outboxCapacity: LocalEventingControlStoreApi["outboxCapacity"] = Effect.try({
			try: () => {
				const usage = outboxUsage()
				return {
					...limits,
					currentEvents: asNumber(usage.count),
					currentBytes: asNumber(usage.bytes),
				}
			},
			catch: storeFailure,
		})

		const recordProjectionFailures: LocalEventingControlStoreApi["recordProjectionFailures"] = (
			tenantId,
			failures,
			createdAt = now(),
		) =>
			Effect.try({
				try: () =>
					db
						.transaction(() => {
							for (const failure of failures)
								db.run(
									"INSERT OR IGNORE INTO projection_failures (tenant_id, projection_id, projection_revision, occurrence_id, message, created_at) VALUES (?, ?, ?, ?, ?, ?)",
									[
										tenantId,
										failure.projectionId,
										failure.projectionRevision,
										failure.occurrenceId,
										failure.message.slice(0, 4_096),
										createdAt,
									],
								)
							db.run(
								"DELETE FROM projection_failures WHERE tenant_id = ? AND sequence NOT IN (SELECT sequence FROM projection_failures WHERE tenant_id = ? ORDER BY sequence DESC LIMIT ?)",
								[tenantId, tenantId, MAX_FAILURES_PER_TENANT],
							)
						})
						.immediate(),
				catch: storeFailure,
			})

		return {
			path,
			saveProjection,
			loadEnabledProjections,
			stageEvents,
			deliveryGap,
			acceptDeliveryGap,
			abandonEvents,
			hasStagedSourceKind,
			hasStagedSourceOccurrence,
			stagedEventIdsForOccurrence,
			markReady,
			listReady: (limit, after) => listOutbox("ready", limit, after),
			listStaged: (limit, after) => listOutbox("staged", limit, after),
			listConsumers,
			registerConsumer,
			disableConsumer,
			claimReady,
			acknowledgeClaim,
			outboxCapacity,
			recordProjectionFailures,
			validate: Effect.try({ try: () => validateOpenDatabase(db), catch: storeFailure }),
			captureSnapshot,
			backupTo: (target) =>
				Effect.flatMap(captureSnapshot, (bytes) => writeControlSnapshot(target, bytes)),
		} satisfies LocalEventingControlStoreApi
	})

	static readonly layer = Layer.effect(this, this.make)
}

/** Opens a store outside a layer graph (checkpoint restore, tests); it closes with the scope. */
export const openControlStore = (
	dataDir: string,
	limits?: LocalEventingControlLimits,
): Effect.Effect<LocalEventingControlStoreApi, EventingControlStoreError, Scope.Scope> =>
	LocalEventingControlStore.make.pipe(
		Effect.provideService(
			LocalEventingControlConfig,
			limits === undefined ? { dataDir } : { dataDir, limits },
		),
	)

export const validateControlSnapshot = (
	path: string,
): Effect.Effect<EventingControlSnapshotValidation, EventingControlStoreError> =>
	Effect.try({
		try: () => {
			assertRealDatabaseFile(path)
			if (!existsSync(path)) throw storeError(`eventing control snapshot is missing: ${path}`)
			const uri = `${pathToFileURL(path).href}?immutable=1`
			const db = new Database(
				uri,
				sqliteConstants.SQLITE_OPEN_READONLY | sqliteConstants.SQLITE_OPEN_URI,
			)
			try {
				configure(db)
				return validateOpenDatabase(db)
			} finally {
				db.close(true)
			}
		},
		catch: storeFailure,
	})

export const writeControlSnapshot = (
	path: string,
	bytes: Uint8Array,
): Effect.Effect<EventingControlSnapshotValidation, EventingControlStoreError> =>
	Effect.tryPromise({ try: () => durableWrite(path, bytes), catch: storeFailure }).pipe(
		Effect.andThen(validateControlSnapshot(path)),
	)

/** Round-trips the snapshot through a staging store so the target is written by a clean close. */
export const restoreControlSnapshot = (
	snapshotPath: string,
	dataDir: string,
): Effect.Effect<void, EventingControlStoreError> =>
	Effect.gen(function* () {
		yield* validateControlSnapshot(snapshotPath)
		const stagingDataDir = yield* Effect.acquireRelease(
			Effect.try({
				try: () => mkdtempSync(join(dirname(resolve(dataDir)), ".maple-eventing-control-restore-")),
				catch: storeFailure,
			}),
			(directory) => Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
		)
		yield* Effect.tryPromise({
			try: () => durableWrite(eventingControlPath(stagingDataDir), readFileSync(snapshotPath)),
			catch: storeFailure,
		})
		const restored = yield* openControlStore(stagingDataDir)
		yield* restored.backupTo(eventingControlPath(dataDir))
	}).pipe(Effect.scoped)
