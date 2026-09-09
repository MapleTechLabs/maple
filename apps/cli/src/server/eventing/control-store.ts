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
import { Result, Schema } from "effect"
import { durableWrite, ensurePrivateDirectory } from "../durable-files"
import { NOOP_EVENTING_TELEMETRY, type EventingTelemetry } from "./telemetry"

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

const asNumber = (value: number | bigint): number => {
	const number = Number(value)
	if (!Number.isSafeInteger(number) || number < 0) throw new Error(`invalid SQLite integer: ${value}`)
	return number
}

const decodeProjection = (json: string): SignalProjectionSpec =>
	decodeSignalProjectionSpec(Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(json))

const decodeEvent = (json: string): MapleCloudEvent => {
	return Result.getOrThrow(
		validateMapleCloudEvent(Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(json)),
	).event
}

const assertRealDatabaseFile = (path: string): void => {
	let info
	try {
		info = lstatSync(path)
	} catch (error) {
		if (Schema.is(Schema.Struct({ code: Schema.Literal("ENOENT") }))(error)) return
		throw error
	}
	if (info.isSymbolicLink() || !info.isFile())
		throw new Error(`eventing control database is not a real file: ${path}`)
}

const configure = (db: Database): void => {
	db.exec("PRAGMA foreign_keys = ON")
	db.exec("PRAGMA trusted_schema = OFF")
	db.exec("PRAGMA busy_timeout = 5000")
}

const checkpointWal = (db: Database): void => {
	const result = db.query<WalCheckpointRow, []>("PRAGMA wal_checkpoint(TRUNCATE)").get()
	if (!result) throw new Error("eventing control WAL checkpoint returned no result")
	const busy = asNumber(result.busy)
	const log = asNumber(result.log)
	const checkpointed = asNumber(result.checkpointed)
	if (busy !== 0 || log !== 0)
		throw new Error(
			`eventing control WAL checkpoint incomplete (busy=${busy}, log=${log}, checkpointed=${checkpointed})`,
		)
}

const validateLimits = (limits: LocalEventingControlLimits): ResolvedLocalEventingControlLimits => {
	if (!Number.isSafeInteger(limits.maxOutboxEvents) || limits.maxOutboxEvents < 1)
		throw new Error("maxOutboxEvents must be a positive safe integer")
	if (!Number.isSafeInteger(limits.maxOutboxBytes) || limits.maxOutboxBytes < 1)
		throw new Error("maxOutboxBytes must be a positive safe integer")
	const retainAcknowledgedReadyEvents =
		limits.retainAcknowledgedReadyEvents ?? DEFAULT_RETAIN_ACKNOWLEDGED_READY_EVENTS
	if (!Number.isSafeInteger(retainAcknowledgedReadyEvents) || retainAcknowledgedReadyEvents < 0)
		throw new Error("retainAcknowledgedReadyEvents must be a non-negative safe integer")
	return { ...limits, retainAcknowledgedReadyEvents }
}

const validateOpenDatabase = (
	db: Database,
	acceptedSchemaVersions: readonly number[] = [CONTROL_SCHEMA_VERSION],
): EventingControlSnapshotValidation => {
	const quick = db.query<QuickCheckRow, []>("PRAGMA quick_check").get()
	if (quick?.quick_check !== "ok") throw new Error(`eventing control database quick_check failed`)
	const version = db.query<UserVersionRow, []>("PRAGMA user_version").get()
	if (!version) throw new Error("eventing control database has no schema version")
	const schemaVersion = asNumber(version.user_version)
	if (!acceptedSchemaVersions.includes(schemaVersion))
		throw new Error(
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
			throw new Error("eventing control outbox accounting is inconsistent")
	} finally {
		accounting.finalize()
	}
	const count = (where: string): number => {
		const row = db.query<CountRow, []>(`SELECT count(*) AS count FROM outbox_events ${where}`).get()
		if (!row) throw new Error("eventing control count query returned no row")
		return asNumber(row.count)
	}
	const revisions = db.query<CountRow, []>("SELECT count(*) AS count FROM projection_revisions").get()
	if (!revisions) throw new Error("eventing projection count query returned no row")
	const failures = db.query<CountRow, []>("SELECT count(*) AS count FROM projection_failures").get()
	if (!failures) throw new Error("eventing projection-failure count query returned no row")
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
	if (!invalidReadiness) throw new Error("eventing readiness validation query returned no row")
	if (asNumber(invalidReadiness.count) !== 0)
		throw new Error("eventing control database has inconsistent outbox readiness state")
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
			throw new Error("eventing staged source-fingerprint validation returned no row")
		if (asNumber(invalidFingerprints.count) > 0)
			throw new Error("eventing control database has an invalid staged source fingerprint")
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

export class LocalEventingControlStore {
	readonly #db: Database
	#stagedSourceKinds = new Set<string>()
	readonly #limits: ResolvedLocalEventingControlLimits
	readonly #telemetry: EventingTelemetry
	readonly path: string

	private constructor(
		path: string,
		db: Database,
		limits: ResolvedLocalEventingControlLimits,
		telemetry: EventingTelemetry,
	) {
		this.path = path
		this.#db = db
		this.#limits = limits
		this.#telemetry = telemetry
		this.#refreshStagedSourceKinds()
	}

	static async open(
		dataDir: string,
		limits: LocalEventingControlLimits = {
			maxOutboxEvents: DEFAULT_MAX_OUTBOX_EVENTS,
			maxOutboxBytes: DEFAULT_MAX_OUTBOX_BYTES,
			retainAcknowledgedReadyEvents: DEFAULT_RETAIN_ACKNOWLEDGED_READY_EVENTS,
		},
		telemetry: EventingTelemetry = NOOP_EVENTING_TELEMETRY,
	): Promise<LocalEventingControlStore> {
		const validatedLimits = validateLimits(limits)
		const directory = eventingControlDirectory(dataDir)
		await ensurePrivateDirectory(directory)
		const path = eventingControlPath(dataDir)
		assertRealDatabaseFile(path)
		const db = new Database(path, { create: true, readwrite: true, strict: true, safeIntegers: true })
		try {
			configure(db)
			db.exec("PRAGMA journal_mode = WAL")
			db.exec("PRAGMA synchronous = FULL")
			const version = db.query<UserVersionRow, []>("PRAGMA user_version").get()
			if (!version) throw new Error("eventing control database has no schema version")
			let schemaVersion = asNumber(version.user_version)
			if (schemaVersion === 0) {
				db.transaction(() => db.exec(CREATE_SCHEMA)).exclusive()
				schemaVersion = CONTROL_SCHEMA_VERSION
			}
			if (schemaVersion !== CONTROL_SCHEMA_VERSION)
				throw new Error(
					`unsupported eventing control schema ${schemaVersion}; expected ${CONTROL_SCHEMA_VERSION}`,
				)
			chmodSync(path, 0o600)
			validateOpenDatabase(db)
			return new LocalEventingControlStore(path, db, validatedLimits, telemetry)
		} catch (error) {
			db.close()
			throw error
		}
	}

	close(): void {
		checkpointWal(this.#db)
		this.#db.close(true)
	}

	saveProjection(spec: SignalProjectionSpec, createdAt = new Date().toISOString()): void {
		const decoded = decodeSignalProjectionSpec(spec)
		if (!isJsonValue(decoded)) throw new Error("projection spec must be finite JSON")
		const specJson = canonicalJson(decoded)
		this.#db
			.transaction(() => {
				const latest = this.#db
					.query<RevisionRow, [string, string]>(
						"SELECT max(revision) AS revision FROM projection_revisions WHERE tenant_id = ? AND projection_id = ?",
					)
					.get(decoded.tenantId, decoded.id)
				const latestRevision = latest?.revision == null ? null : asNumber(latest.revision)
				const existing = this.#db
					.query<ProjectionJsonRow, [string, string, number]>(
						"SELECT spec_json FROM projection_revisions WHERE tenant_id = ? AND projection_id = ? AND revision = ?",
					)
					.get(decoded.tenantId, decoded.id, decoded.revision)
				if (existing) {
					if (existing.spec_json !== specJson)
						throw new Error(
							`projection revision is immutable: ${decoded.tenantId}:${decoded.id}@${decoded.revision}`,
						)
					if (latestRevision !== decoded.revision)
						throw new Error(
							`stale projection revision: ${decoded.tenantId}:${decoded.id}@${decoded.revision}; latest is ${latestRevision}`,
						)
					const active = this.#db
						.query<ActiveRevisionRow, [string, string]>(
							"SELECT revision FROM active_projections WHERE tenant_id = ? AND projection_id = ?",
						)
						.get(decoded.tenantId, decoded.id)
					const activeRevision = active === null ? null : asNumber(active.revision)
					const expectedActiveRevision = decoded.enabled ? decoded.revision : null
					if (activeRevision !== expectedActiveRevision)
						throw new Error(
							`projection active state conflicts with exact revision replay: ${decoded.tenantId}:${decoded.id}@${decoded.revision}`,
						)
					return
				} else {
					const expected = latestRevision === null ? 1 : latestRevision + 1
					if (decoded.revision !== expected)
						throw new Error(
							`projection revision must be ${expected}: ${decoded.tenantId}:${decoded.id}@${decoded.revision}`,
						)
					this.#db.run(
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
					this.#db.run(
						"INSERT INTO active_projections (tenant_id, projection_id, revision) VALUES (?, ?, ?) ON CONFLICT (tenant_id, projection_id) DO UPDATE SET revision = excluded.revision",
						[decoded.tenantId, decoded.id, decoded.revision],
					)
				else
					this.#db.run("DELETE FROM active_projections WHERE tenant_id = ? AND projection_id = ?", [
						decoded.tenantId,
						decoded.id,
					])
			})
			.immediate()
	}

	loadEnabledProjections(tenantId: string): readonly SignalProjectionSpec[] {
		return this.#db
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
			.map(({ spec_json }) => decodeProjection(spec_json))
	}

	stageEvents(
		events: readonly MapleCloudEvent[],
		sourceFingerprints: ReadonlyMap<string, string> = new Map(),
		stagedAt = new Date().toISOString(),
	): StageEventsResult {
		let inserted = 0
		let deduplicated = 0
		const droppedByTenant = new Map<string, number>()
		let dropped = 0
		const eventIds: string[] = []
		try {
			this.#db
				.transaction(() => {
					const usage = this.#outboxUsage()
					if (!usage) throw new Error("event outbox usage query returned no row")
					let outboxEvents = asNumber(usage.count)
					let outboxBytes = asNumber(usage.bytes)
					for (const candidate of events) {
						const validated = Result.getOrThrow(validateMapleCloudEvent(candidate))
						const { event, canonicalJson: eventJson, byteLength: eventBytes } = validated
						const sourceFingerprint = sourceFingerprints.get(event.id) ?? null
						if (sourceFingerprint !== null && !/^sha256:[0-9a-f]{64}$/.test(sourceFingerprint))
							throw new Error(`event has invalid source fingerprint: ${event.id}`)
						if (event.sourceoccurrenceid !== undefined && sourceFingerprint === null)
							throw new Error(
								`event with source occurrence ID requires a source fingerprint: ${event.id}`,
							)
						let sourceKind: string | null = null
						if (event.sourceoccurrenceid !== undefined) {
							const projection = this.#db
								.query<ProjectionJsonRow, [string, string, number]>(
									"SELECT spec_json FROM projection_revisions WHERE tenant_id = ? AND projection_id = ? AND revision = ?",
								)
								.get(event.tenantid, event.projectionid, event.projectionrevision)
							if (projection === null)
								throw new Error(
									`event references unknown projection revision: ${event.tenantid}:${event.projectionid}@${event.projectionrevision}`,
								)
							sourceKind = decodeProjection(projection.spec_json).sourceKind
						}
						const existing = this.#db
							.query<EventRow, [string]>(
								"SELECT event_id, event_json, state, source_fingerprint FROM outbox_events WHERE event_id = ?",
							)
							.get(event.id)
						if (existing) {
							if (existing.event_json !== eventJson)
								throw new Error(`event ID collision with different payload: ${event.id}`)
							if (
								sourceFingerprint !== null &&
								existing.source_fingerprint !== null &&
								existing.source_fingerprint !== sourceFingerprint
							)
								throw new Error(
									`event ID collision with different source occurrence: ${event.id}`,
								)
							if (
								existing.state === "staged" &&
								sourceFingerprint !== null &&
								existing.source_fingerprint === null
							)
								throw new Error(`staged event has no recovery fingerprint: ${event.id}`)
							deduplicated += 1
						} else {
							if (
								outboxEvents + 1 > this.#limits.maxOutboxEvents ||
								outboxBytes + eventBytes > this.#limits.maxOutboxBytes
							) {
								dropped += 1
								droppedByTenant.set(
									event.tenantid,
									(droppedByTenant.get(event.tenantid) ?? 0) + 1,
								)
								continue
							}
							this.#db.run(
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
						this.#recordDeliveryGap(tenantId, count, stagedAt)
				})
				.immediate()
		} catch (error) {
			this.#telemetry.record({ operation: "outbox_stage", outcome: "failure" })
			throw error
		}
		this.#refreshStagedSourceKinds()
		this.#telemetry.record({ operation: "outbox_stage", outcome: "success", count: inserted })
		this.#telemetry.record({ operation: "outbox_dedup", outcome: "success", count: deduplicated })
		this.#telemetry.record({ operation: "outbox_stage", outcome: "dropped", count: dropped })
		return { inserted, deduplicated, dropped, eventIds }
	}

	deliveryGap(tenantId: string): DeliveryGap {
		const statement = this.#db.prepare<DeliveryGapRow, [string]>(
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
	#recordDeliveryGap(tenantId: string, count: number, at: string): void {
		if (count === 0) return
		this.#db.run(
			`INSERT INTO delivery_gaps (tenant_id, generation, dropped_events, last_dropped_at) VALUES (?, 1, ?, ?)
   ON CONFLICT (tenant_id) DO UPDATE SET generation = generation + 1, dropped_events = dropped_events + excluded.dropped_events, last_dropped_at = excluded.last_dropped_at`,
			[tenantId, count, at],
		)
	}
	acceptDeliveryGap(tenantId: string, consumerId: string, generation: number): DeliveryGap {
		validateConsumerId(consumerId)
		return this.#db
			.transaction(() => {
				const consumer = this.#consumer(tenantId, consumerId)
				if (consumer === null)
					throw EventConsumerNotFoundError.create(
						`event consumer not found: ${consumerId}`,
						consumerId,
					)
				const gap = this.deliveryGap(tenantId)
				if (!Number.isSafeInteger(generation) || generation < 1 || generation !== gap.generation)
					throw EventConsumerConflictError.create(
						"delivery gap generation changed; inspect current health before accepting",
						consumerId,
					)
				this.#db.run(
					"UPDATE event_consumers SET accepted_gap_generation = ? WHERE tenant_id = ? AND consumer_id = ?",
					[generation, tenantId, consumerId],
				)
				return gap
			})
			.immediate()
	}
	/** Operator-authorized loss; the HTTP caller drains admission before invoking this transaction. */
	abandonEvents(
		tenantId: string,
		eventIds: readonly string[],
	): { readonly abandoned: number; readonly gap: DeliveryGap } {
		if (eventIds.length < 1 || eventIds.length > 1000 || new Set(eventIds).size !== eventIds.length)
			throw new OutboxAdministrationInvalid({ message: "abandon requires 1–1000 distinct event IDs" })
		const result = this.#db
			.transaction(() => {
				const lookup = this.#db.prepare<EventIdRow, [string, string]>(
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
					this.#db.run("DELETE FROM outbox_ready_events WHERE event_id = ?", [eventId])
					this.#db.run("DELETE FROM outbox_events WHERE tenant_id = ? AND event_id = ?", [
						tenantId,
						eventId,
					])
				}
				this.#recordDeliveryGap(tenantId, eventIds.length, new Date().toISOString())
				this.#db.run(
					"UPDATE event_consumers SET lease_token_hash = NULL, lease_expires_at = NULL, claimed_through_sequence = NULL WHERE tenant_id = ?",
					[tenantId],
				)
				return { abandoned: eventIds.length, gap: this.deliveryGap(tenantId) }
			})
			.immediate()
		this.#refreshStagedSourceKinds()
		this.#telemetry.record({ operation: "outbox_abandon", outcome: "success", count: result.abandoned })
		return result
	}

	#refreshStagedSourceKinds(): void {
		const statement = this.#db.prepare<{ tenant_id: string; source_kind: string }, []>(
			"SELECT DISTINCT tenant_id, source_kind FROM outbox_events WHERE state = 'staged' AND source_kind IS NOT NULL",
		)
		try {
			this.#stagedSourceKinds = new Set(
				statement.all().map((row) => JSON.stringify([row.tenant_id, row.source_kind])),
			)
		} finally {
			statement.finalize()
		}
	}
	#outboxUsage(): OutboxUsageRow {
		const statement = this.#db.prepare<OutboxUsageRow, []>(
			"SELECT count, bytes FROM outbox_usage WHERE singleton = 1",
		)
		try {
			const usage = statement.get()
			if (usage === null) throw new Error("event outbox usage query returned no row")
			return usage
		} finally {
			statement.finalize()
		}
	}
	hasStagedSourceKind(tenantId: string, sourceKind: string): boolean {
		return this.#stagedSourceKinds.has(JSON.stringify([tenantId, sourceKind]))
	}

	hasStagedSourceOccurrence(
		tenantId: string,
		sourceKind: string,
		source: string,
		sourceOccurrenceId: string,
	): boolean {
		const row = this.#db
			.query<CountRow, [string, string, string, string]>(
				"SELECT count(*) AS count FROM outbox_events WHERE tenant_id = ? AND source_kind = ? AND source = ? AND source_occurrence_id = ? AND state = 'staged'",
			)
			.get(tenantId, sourceKind, source, sourceOccurrenceId)
		if (row === null) throw new Error("staged source-occurrence query returned no row")
		return asNumber(row.count) > 0
	}

	stagedEventIdsForOccurrence(
		tenantId: string,
		sourceKind: string,
		source: string,
		sourceOccurrenceId: string,
		sourceFingerprint: string,
	): readonly string[] {
		const rows = this.#db
			.query<StagedOccurrenceRow, [string, string, string, string]>(
				"SELECT event_id, source_fingerprint FROM outbox_events WHERE tenant_id = ? AND source_kind = ? AND source = ? AND source_occurrence_id = ? AND state = 'staged' ORDER BY sequence",
			)
			.all(tenantId, sourceKind, source, sourceOccurrenceId)
		for (const row of rows) {
			if (row.source_fingerprint === null)
				throw new Error(`staged source occurrence has no recovery fingerprint: ${row.event_id}`)
			if (row.source_fingerprint !== sourceFingerprint)
				throw new Error(`staged source occurrence collision: ${sourceOccurrenceId}`)
		}
		return rows.map(({ event_id }) => event_id)
	}

	markReady(eventIds: readonly string[], readyAt = new Date().toISOString()): void {
		let markedReady = 0
		try {
			this.#db
				.transaction(() => {
					for (const eventId of eventIds) {
						const row = this.#db
							.query<Pick<EventRow, "state">, [string]>(
								"SELECT state FROM outbox_events WHERE event_id = ?",
							)
							.get(eventId)
						if (!row) throw new Error(`cannot mark unknown event ready: ${eventId}`)
						if (row.state === "ready") continue
						this.#db.run("INSERT INTO outbox_ready_events (event_id, ready_at) VALUES (?, ?)", [
							eventId,
							readyAt,
						])
						this.#db.run(
							"UPDATE outbox_events SET state = 'ready', ready_at = ? WHERE event_id = ? AND state = 'staged'",
							[readyAt, eventId],
						)
						markedReady += 1
					}
				})
				.immediate()
		} catch (error) {
			this.#telemetry.record({ operation: "outbox_ready", outcome: "failure" })
			throw error
		}
		this.#refreshStagedSourceKinds()
		this.#telemetry.record({ operation: "outbox_ready", outcome: "success", count: markedReady })
	}

	#listOutbox(state: "ready" | "staged", limit = 100, after = 0): EventingOutboxPage {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000)
			throw new Error("outbox-event limit must be between 1 and 1000")
		if (!Number.isSafeInteger(after) || after < 0)
			throw new Error("outbox cursor must be a non-negative safe integer")
		const rows =
			state === "ready"
				? this.#db
						.query<EventJsonRow, [number, number]>(
							`SELECT readiness.sequence, event.event_json, event.staged_at, readiness.ready_at
							 FROM outbox_ready_events AS readiness
							 INNER JOIN outbox_events AS event ON event.event_id = readiness.event_id
							 WHERE event.state = 'ready' AND readiness.sequence > ?
							 ORDER BY readiness.sequence
							 LIMIT ?`,
						)
						.all(after, limit + 1)
				: this.#db
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
	}

	listReady(limit = 100, after = 0): EventingOutboxPage {
		return this.#listOutbox("ready", limit, after)
	}

	listStaged(limit = 100, after = 0): EventingOutboxPage {
		return this.#listOutbox("staged", limit, after)
	}

	listConsumers(tenantId: string): readonly EventConsumer[] {
		return this.#db
			.query<ConsumerRow, [string]>(
				`SELECT consumer_id, tenant_id, active, last_acked_sequence, accepted_gap_generation, lease_token_hash,
				        lease_expires_at, claimed_through_sequence, registered_at, disabled_at
				 FROM event_consumers
				 WHERE tenant_id = ?
				 ORDER BY consumer_id`,
			)
			.all(tenantId)
			.map(decodeConsumer)
	}

	registerConsumer(
		tenantId: string,
		consumerId: string,
		startAt: EventConsumerStart,
		registeredAt = new Date().toISOString(),
	): EventConsumer {
		validateConsumerId(consumerId)
		if (startAt !== "beginning" && startAt !== "latest")
			throw EventConsumerInputError.create("startAt must be beginning or latest")
		canonicalInstant(registeredAt, "event consumer registeredAt")
		return this.#db
			.transaction(() => {
				const existing = this.#consumer(tenantId, consumerId)
				if (existing)
					throw EventConsumerConflictError.create(
						`event consumer already exists: ${consumerId}`,
						consumerId,
					)
				const boundary = this.#db
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
				const lastAcknowledged = startAt === "beginning" ? Math.max(0, sequence - 1) : sequence
				this.#db.run(
					"INSERT INTO event_consumers (consumer_id, tenant_id, active, last_acked_sequence, registered_at) VALUES (?, ?, 1, ?, ?)",
					[consumerId, tenantId, lastAcknowledged, registeredAt],
				)
				if (startAt === "latest")
					this.#db.run(
						"UPDATE event_consumers SET accepted_gap_generation = ? WHERE tenant_id = ? AND consumer_id = ?",
						[this.deliveryGap(tenantId).generation, tenantId, consumerId],
					)
				const updated = this.#consumer(tenantId, consumerId)
				if (updated === null)
					throw EventConsumerNotFoundError.create(
						`event consumer not found: ${consumerId}`,
						consumerId,
					)
				return decodeConsumer(updated)
			})
			.immediate()
	}

	disableConsumer(
		tenantId: string,
		consumerId: string,
		disabledAt = new Date().toISOString(),
	): EventConsumer {
		validateConsumerId(consumerId)
		canonicalInstant(disabledAt, "event consumer disabledAt")
		return this.#db
			.transaction(() => {
				const existing = this.#consumer(tenantId, consumerId)
				if (!existing)
					throw EventConsumerNotFoundError.create(
						`unknown event consumer: ${consumerId}`,
						consumerId,
					)
				if (asNumber(existing.active) === 0) return decodeConsumer(existing)
				this.#db.run(
					`UPDATE event_consumers
					 SET active = 0, lease_token_hash = NULL, lease_expires_at = NULL,
					     claimed_through_sequence = NULL, disabled_at = ?
					 WHERE tenant_id = ? AND consumer_id = ?`,
					[disabledAt, tenantId, consumerId],
				)
				this.#pruneAcknowledgedReady(tenantId)
				const updated = this.#consumer(tenantId, consumerId)
				if (updated === null)
					throw EventConsumerNotFoundError.create(
						`event consumer not found: ${consumerId}`,
						consumerId,
					)
				return decodeConsumer(updated)
			})
			.immediate()
	}

	claimReady(
		tenantId: string,
		consumerId: string,
		limit: number,
		leaseSeconds: number,
		now = new Date().toISOString(),
	): EventConsumerClaim {
		let reclaimedExpiredLease = false
		let lag = 0
		try {
			validateConsumerId(consumerId)
			if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000)
				throw EventConsumerInputError.create("claim limit must be between 1 and 1000")
			if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 5 || leaseSeconds > 300)
				throw EventConsumerInputError.create("leaseSeconds must be between 5 and 300")
			const nowMilliseconds = canonicalInstant(now, "claim time")
			const claim = this.#db
				.transaction(() => {
					const consumer = this.#consumer(tenantId, consumerId)
					if (!consumer)
						throw EventConsumerNotFoundError.create(
							`unknown event consumer: ${consumerId}`,
							consumerId,
						)
					const gap = this.deliveryGap(tenantId)
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
					if (consumer.lease_expires_at !== null) reclaimedExpiredLease = true
					lag = this.#consumerLag(tenantId, asNumber(consumer.last_acked_sequence))

					const rows = this.#db
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
						this.#db.run(
							"UPDATE event_consumers SET lease_token_hash = NULL, lease_expires_at = NULL, claimed_through_sequence = NULL WHERE tenant_id = ? AND consumer_id = ?",
							[tenantId, consumerId],
						)
						return {
							consumerId,
							leaseToken: null,
							leaseExpiresAt: null,
							throughSequence: null,
							events: [],
						}
					}

					const leaseToken = randomBytes(32).toString("hex")
					const leaseExpiresAt = new Date(nowMilliseconds + leaseSeconds * 1_000).toISOString()
					const last = rows.at(-1)
					if (last === undefined) throw EventConsumerConflictError.create("empty claim", consumerId)
					const throughSequence = asNumber(last.sequence)
					this.#db.run(
						`UPDATE event_consumers
					 SET lease_token_hash = ?, lease_expires_at = ?, claimed_through_sequence = ?
					 WHERE tenant_id = ? AND consumer_id = ?`,
						[tokenHash(leaseToken), leaseExpiresAt, throughSequence, tenantId, consumerId],
					)
					return {
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
				})
				.immediate()
			this.#telemetry.record({
				operation: "consumer_claim",
				outcome: claim.events.length === 0 ? "empty" : "success",
				count: Math.max(1, claim.events.length),
			})
			this.#telemetry.record({ operation: "consumer_lag", outcome: "observed", lag })
			if (reclaimedExpiredLease)
				this.#telemetry.record({ operation: "consumer_lease", outcome: "reclaimed" })
			return claim
		} catch (error) {
			this.#telemetry.record({ operation: "consumer_claim", outcome: "failure" })
			if (Schema.is(EventConsumerLeaseError)(error))
				this.#telemetry.record({ operation: "consumer_lease", outcome: "failure" })
			throw error
		}
	}

	acknowledgeClaim(
		tenantId: string,
		consumerId: string,
		leaseToken: string,
		throughSequence: number,
		now = new Date().toISOString(),
	): EventConsumerAcknowledgement {
		try {
			validateConsumerId(consumerId)
			if (!Number.isSafeInteger(throughSequence) || throughSequence < 1)
				throw EventConsumerInputError.create("throughSequence must be a positive safe integer")
			const nowMilliseconds = canonicalInstant(now, "acknowledgement time")
			const acknowledgement = this.#db
				.transaction(() => {
					const consumer = this.#consumer(tenantId, consumerId)
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
						canonicalInstant(consumer.lease_expires_at, "event consumer leaseExpiresAt") <=
						nowMilliseconds
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
					this.#db.run(
						`UPDATE event_consumers
					 SET last_acked_sequence = ?, lease_token_hash = NULL, lease_expires_at = NULL,
					     claimed_through_sequence = NULL
					 WHERE tenant_id = ? AND consumer_id = ?`,
						[throughSequence, tenantId, consumerId],
					)
					return {
						consumerId,
						acknowledgedThrough: throughSequence,
						prunedEvents: this.#pruneAcknowledgedReady(tenantId),
					}
				})
				.immediate()
			this.#telemetry.record({ operation: "consumer_ack", outcome: "success" })
			this.#telemetry.record({
				operation: "consumer_lag",
				outcome: "observed",
				lag: this.#consumerLag(tenantId, acknowledgement.acknowledgedThrough),
			})
			return acknowledgement
		} catch (error) {
			this.#telemetry.record({ operation: "consumer_ack", outcome: "failure" })
			if (Schema.is(EventConsumerLeaseError)(error))
				this.#telemetry.record({ operation: "consumer_lease", outcome: "failure" })
			throw error
		}
	}

	#consumerLag(tenantId: string, lastAcknowledgedSequence: number): number {
		const latest = this.#db
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

	#consumer(tenantId: string, consumerId: string): ConsumerRow | null {
		return this.#db
			.query<ConsumerRow, [string, string]>(
				`SELECT consumer_id, tenant_id, active, last_acked_sequence, accepted_gap_generation, lease_token_hash,
				        lease_expires_at, claimed_through_sequence, registered_at, disabled_at
				 FROM event_consumers
				 WHERE tenant_id = ? AND consumer_id = ?`,
			)
			.get(tenantId, consumerId)
	}

	#pruneAcknowledgedReady(tenantId: string): number {
		const boundary = this.#db
			.query<SequenceRow, [string]>(
				"SELECT min(last_acked_sequence) AS sequence FROM event_consumers WHERE tenant_id = ? AND active = 1",
			)
			.get(tenantId)
		if (boundary?.sequence == null) return 0
		const rows = this.#db
			.query<EventIdRow, [string, number]>(
				`SELECT readiness.event_id
				 FROM outbox_ready_events AS readiness
				 INNER JOIN outbox_events AS event ON event.event_id = readiness.event_id
				 WHERE event.tenant_id = ? AND readiness.sequence <= ?
				 ORDER BY readiness.sequence`,
			)
			.all(tenantId, asNumber(boundary.sequence))
		const pruneCount = Math.max(0, rows.length - this.#limits.retainAcknowledgedReadyEvents)
		for (const { event_id } of rows.slice(0, pruneCount)) {
			this.#db.run("DELETE FROM outbox_ready_events WHERE event_id = ?", [event_id])
			this.#db.run("DELETE FROM outbox_events WHERE event_id = ? AND state = 'ready'", [event_id])
		}
		return pruneCount
	}

	outboxCapacity(): LocalEventingControlLimits & {
		readonly currentEvents: number
		readonly currentBytes: number
	} {
		const usage = this.#outboxUsage()
		if (!usage) throw new Error("event outbox usage query returned no row")
		return {
			...this.#limits,
			currentEvents: asNumber(usage.count),
			currentBytes: asNumber(usage.bytes),
		}
	}

	recordProjectionFailures(
		tenantId: string,
		failures: readonly ProjectionFailure[],
		createdAt = new Date().toISOString(),
	): void {
		this.#db
			.transaction(() => {
				for (const failure of failures)
					this.#db.run(
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
				this.#db.run(
					"DELETE FROM projection_failures WHERE tenant_id = ? AND sequence NOT IN (SELECT sequence FROM projection_failures WHERE tenant_id = ? ORDER BY sequence DESC LIMIT ?)",
					[tenantId, tenantId, MAX_FAILURES_PER_TENANT],
				)
			})
			.immediate()
	}

	validate(): EventingControlSnapshotValidation {
		return validateOpenDatabase(this.#db)
	}

	captureSnapshot(): Uint8Array {
		checkpointWal(this.#db)
		return this.#db.serialize()
	}

	static async writeSnapshot(path: string, bytes: Uint8Array): Promise<EventingControlSnapshotValidation> {
		await durableWrite(path, bytes)
		return LocalEventingControlStore.validateSnapshot(path)
	}

	async backupTo(path: string): Promise<EventingControlSnapshotValidation> {
		return LocalEventingControlStore.writeSnapshot(path, this.captureSnapshot())
	}

	static validateSnapshot(path: string): EventingControlSnapshotValidation {
		assertRealDatabaseFile(path)
		if (!existsSync(path)) throw new Error(`eventing control snapshot is missing: ${path}`)
		const uri = `${pathToFileURL(path).href}?immutable=1`
		const db = new Database(uri, sqliteConstants.SQLITE_OPEN_READONLY | sqliteConstants.SQLITE_OPEN_URI)
		try {
			configure(db)
			return validateOpenDatabase(db)
		} finally {
			db.close(true)
		}
	}

	static async restoreSnapshot(snapshotPath: string, dataDir: string): Promise<void> {
		LocalEventingControlStore.validateSnapshot(snapshotPath)
		const stagingDataDir = mkdtempSync(
			join(dirname(resolve(dataDir)), ".maple-eventing-control-restore-"),
		)
		let restored: LocalEventingControlStore | undefined
		try {
			await durableWrite(eventingControlPath(stagingDataDir), readFileSync(snapshotPath))
			restored = await LocalEventingControlStore.open(stagingDataDir)
			await restored.backupTo(eventingControlPath(dataDir))
		} finally {
			restored?.close()
			rmSync(stagingDataDir, { recursive: true, force: true })
		}
	}
}
