import * as PG from "@maple-dev/effect-orm/postgres"
import * as Orm from "@maple-dev/effect-orm/database"
import { OrgRetentionPolicies, Sources } from "@maple/db/tables"
import { RetentionInvalidError, RetentionPersistenceError, SourceNotFoundError } from "@maple/domain/http"
import {
	DEFAULT_RETENTION_DAYS,
	hasRetentionOverrides,
	organizationRetentionDays,
	readHorizonDays,
	RETENTION_PERIODS,
	RETENTION_SIGNALS,
	type RetentionDaysBySignal,
	RetentionOverrides,
	type RetentionSignal,
	RetentionSignal as RetentionSignalSchema,
	sourceRetentionDays,
} from "@maple/domain/retention"
import type { OrgId, SourceId, UserId } from "@maple/primitives"
import { EdgeCacheService, sharedAcrossPartitions } from "@maple/cache"
import type { MapleDb } from "@maple/db/client"
import { Array as Arr, Clock, Context, Duration, Effect, Layer, Option, Schema } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute, makePersistenceErrorMapper } from "@maple/backend/platform/db-execute"

/** A source that keeps at least one signal for a period of its own. */
export interface SourceRetention {
	readonly sourceId: SourceId
	readonly overrides: RetentionOverrides
	readonly days: RetentionDaysBySignal
}

/** An organization's retention as stored and as it resolves. */
export interface RetentionPolicy {
	/** What the organization set; a signal left out uses the default. */
	readonly overrides: RetentionOverrides
	/** What a source with no override of its own keeps. */
	readonly days: RetentionDaysBySignal
	/** How far back a read of each signal may reach: the longest any source keeps it. */
	readonly readHorizonDays: RetentionDaysBySignal
	readonly sources: ReadonlyArray<SourceRetention>
}

/** How far back reads of an organization may reach, as the read path needs it. */
export interface RetentionReadHorizon {
	/** Days per signal: the longest any source keeps it. */
	readonly days: RetentionDaysBySignal
	/** The signals the organization or one of its sources set a period for, in `RETENTION_SIGNALS` order. */
	readonly configured: ReadonlyArray<RetentionSignal>
}

/** What an organization that set nothing reads: the defaults, with no signal bounded by policy. */
export const DEFAULT_READ_HORIZON: RetentionReadHorizon = { days: DEFAULT_RETENTION_DAYS, configured: [] }

/** The read horizon of a policy, with the signals it or one of its sources set. */
export const readHorizonOf = (policy: {
	readonly overrides: RetentionOverrides
	readonly readHorizonDays: RetentionDaysBySignal
	readonly sources: ReadonlyArray<{ readonly overrides: RetentionOverrides }>
}): RetentionReadHorizon => ({
	days: policy.readHorizonDays,
	configured: Arr.filter(
		RETENTION_SIGNALS,
		(signal) =>
			policy.overrides[signal] !== undefined ||
			Arr.some(policy.sources, (source) => source.overrides[signal] !== undefined),
	),
})

/** The shared cache bucket of read horizons: one entry, every organization with a policy. */
export const READ_HORIZON_CACHE_BUCKET = "retention-read-horizons"
export const READ_HORIZON_CACHE_KEY = "configured"

/** The read horizons of every organization that set a period, as the shared cache holds them. */
const CachedReadHorizons = Schema.Struct({
	/** When the policies were read from Postgres, by the clock of the isolate that read them. */
	readAtMs: Schema.Number,
	orgs: Schema.Array(
		Schema.Struct({
			orgId: Schema.String,
			days: Schema.Struct({
				traces: Schema.Number,
				logs: Schema.Number,
				metrics: Schema.Number,
				sessions: Schema.Number,
				events: Schema.Number,
				profiles: Schema.Number,
			}),
			configured: Schema.Array(RetentionSignalSchema),
		}),
	),
})

/** How long the read horizons are served before the policies are read again. */
export const READ_HORIZON_TTL_MS = 60_000
/** After a failed policy read, how long the fallback is served before the next attempt. */
export const READ_HORIZON_RETRY_MS = 10_000
/** A read waits this long for the policies, then carries on with the fallback. */
export const READ_HORIZON_LOAD_TIMEOUT_MS = 2_000
/** A write this much older than a snapshot is in it, whatever two isolates' clocks disagree by. */
export const READ_HORIZON_WRITE_SKEW_MS = 5_000
/** How often a read on an isolate that holds nothing yet looks for the load under way. */
const READ_HORIZON_COLD_POLL_MS = 5
/** A refresh marker older than this is from a fiber that never cleared it. */
const READ_HORIZON_REFRESH_STALE_MS = 10_000

/** The read horizons an isolate holds: every organization with a policy, as last read. */
export interface ReadHorizonMemoState {
	known: { readonly byOrg: Map<string, RetentionReadHorizon>; readonly freshUntil: number } | undefined
	refreshStartedAt: number | undefined
	/** This isolate's own policy writes, kept until a snapshot read after them is loaded. */
	readonly written: Map<string, { readonly horizon: RetentionReadHorizon; readonly atMs: number }>
	/** Read-backs after a write, numbered as they start, and the latest started per organization. */
	readBacks: number
	readonly latestReadBack: Map<string, number>
}
export const makeReadHorizonMemo = (): ReadHorizonMemoState => ({
	known: undefined,
	refreshStartedAt: undefined,
	written: new Map(),
	readBacks: 0,
	latestReadBack: new Map(),
})
const isolateReadHorizonMemo = makeReadHorizonMemo()

/**
 * One per isolate by default, so it outlives the service instance: cron lanes and many
 * requests build a new instance each time. Tests provide their own, one per simulated isolate.
 */
export class ReadHorizonMemo extends Context.Reference<ReadHorizonMemoState>(
	"@maple/backend/services/retention/ReadHorizonMemo",
	{ defaultValue: () => isolateReadHorizonMemo },
) {}

/** A retention write: what was set before and after it, from its own transaction, and the policy after. */
export interface RetentionWrite {
	readonly before: RetentionOverrides
	readonly after: RetentionOverrides
	readonly policy: RetentionPolicy
}

/** Serializes an org's retention writes within their transaction. */
const lockRetention = (db: MapleDb, orgId: OrgId) =>
	db.execute(Orm.sql`select pg_advisory_xact_lock(hashtext(${orgId}), hashtext('retention'))`)

export interface RetentionServiceApi {
	readonly get: (orgId: OrgId) => Effect.Effect<RetentionPolicy, RetentionPersistenceError>
	/**
	 * The organization's read horizon from a per-isolate cache, for the read path. It never
	 * fails or waits long: an unreadable policy serves the last known horizon, else the defaults.
	 */
	readonly readHorizon: (orgId: OrgId) => Effect.Effect<RetentionReadHorizon>
	/** Replaces what the organization set. It applies to data ingested from now on. */
	readonly setOrganization: (
		orgId: OrgId,
		userId: UserId,
		overrides: RetentionOverrides,
	) => Effect.Effect<RetentionPolicy, RetentionPersistenceError | RetentionInvalidError>
	/**
	 * Changes what the organization set from what is stored, under a per-org lock, so two
	 * concurrent edits of different signals both land. Returns what was set before.
	 */
	readonly updateOrganization: (
		orgId: OrgId,
		userId: UserId,
		update: (current: RetentionOverrides) => RetentionOverrides,
	) => Effect.Effect<RetentionWrite, RetentionPersistenceError | RetentionInvalidError>
	/** {@link updateOrganization} for one source. */
	readonly updateSource: (
		orgId: OrgId,
		userId: UserId,
		sourceId: SourceId,
		update: (current: RetentionOverrides) => RetentionOverrides,
	) => Effect.Effect<
		RetentionWrite,
		RetentionPersistenceError | RetentionInvalidError | SourceNotFoundError
	>
	/** Replaces one source's overrides; an empty set makes it inherit again. */
	readonly setSource: (
		orgId: OrgId,
		userId: UserId,
		sourceId: SourceId,
		overrides: RetentionOverrides,
	) => Effect.Effect<
		RetentionPolicy,
		RetentionPersistenceError | RetentionInvalidError | SourceNotFoundError
	>
}

const toPersistenceError = makePersistenceErrorMapper(
	RetentionPersistenceError,
	"Retention persistence failed",
)

const NO_OVERRIDES: RetentionOverrides = {}

const decodeOverrides = Schema.decodeUnknownEffect(RetentionOverrides)

/** Periods a caller may store: one of `RETENTION_PERIODS`, for known signals only. */
const validOverrides = (input: RetentionOverrides) =>
	decodeOverrides(input).pipe(
		Effect.mapError(
			() =>
				new RetentionInvalidError({
					message: `Retention must be one of ${Arr.join(Arr.map(RETENTION_PERIODS, String), ", ")} days`,
				}),
		),
	)

export class RetentionService extends Context.Service<RetentionService, RetentionServiceApi>()(
	"@maple/backend/services/retention/RetentionService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			// Shared by every caller of the org, so never filed under a caller's cache partition.
			const edgeCache = yield* Effect.map(EdgeCacheService, sharedAcrossPartitions)
			const dbExecute = makeDbExecute(database, "RetentionService", toPersistenceError)

			// The org's periods and its sources' are read from one snapshot, so the horizon
			// is never worked out from two different commits.
			const readPolicy = Effect.fnUntraced(function* (db: MapleDb, orgId: OrgId) {
				const policies = yield* db.run(
					PG.from(OrgRetentionPolicies)
						.select(($) => ({ retentionDays: $.retentionDays }))
						.where(($) => [$.orgId.eq(orgId)])
						.limit(1),
				)
				const sourceRows = yield* db.run(
					PG.from(Sources)
						.select(($) => ({ id: $.id, retentionDays: $.retentionDays }))
						.where(($) => [$.orgId.eq(orgId)])
						.orderBy(["id", "asc"]),
				)
				const overrides = policies[0]?.retentionDays ?? NO_OVERRIDES
				const overridden = Arr.filter(sourceRows, (row) => hasRetentionOverrides(row.retentionDays))
				yield* Effect.annotateCurrentSpan({
					"result.rowCount": sourceRows.length,
					"maple.retention.source_overrides": overridden.length,
				})
				return {
					overrides,
					days: organizationRetentionDays(overrides),
					readHorizonDays: readHorizonDays(
						overrides,
						Arr.map(overridden, (row) => row.retentionDays),
					),
					sources: Arr.map(overridden, (row) => ({
						sourceId: row.id,
						overrides: row.retentionDays,
						days: sourceRetentionDays(overrides, row.retentionDays),
					})),
				} satisfies RetentionPolicy
			})

			const get = Effect.fn("RetentionService.get")(function* (orgId: OrgId) {
				yield* Effect.annotateCurrentSpan({ orgId })
				return yield* dbExecute((db) =>
					db.transaction(readPolicy(db, orgId), {
						isolationLevel: "repeatable read",
						accessMode: "read only",
					}),
				)
			})

			// Every organization that set a period, in one snapshot. The read path asks for
			// this instead of one policy per org, so a fan-out over many orgs costs one read.
			const readConfigured = Effect.fn("RetentionService.readConfigured")(function* () {
				const readAtMs = yield* Clock.currentTimeMillis
				const { policies, sources } = yield* dbExecute((db) =>
					db.transaction(
						Effect.all({
							policies: db.run(
								PG.from(OrgRetentionPolicies).select(($) => ({
									orgId: $.orgId,
									retentionDays: $.retentionDays,
								})),
							),
							sources: db.run(
								PG.from(Sources)
									.select(($) => ({ orgId: $.orgId, retentionDays: $.retentionDays }))
									.where(($) => [$.retentionDays.neq(NO_OVERRIDES)]),
							),
						}),
						{ isolationLevel: "repeatable read", accessMode: "read only" },
					),
				)
				const sourcesByOrg = Arr.groupBy(sources, (row) => row.orgId)
				const overridesByOrg = new Map(Arr.map(policies, (row) => [row.orgId, row.retentionDays]))
				const orgIds = Arr.dedupe([
					...Arr.map(policies, (row) => row.orgId),
					...Arr.map(sources, (row) => row.orgId),
				])
				const orgs = Arr.filter(
					Arr.map(orgIds, (orgId) => {
						const overrides = overridesByOrg.get(orgId) ?? NO_OVERRIDES
						const sourceOverrides = Arr.map(sourcesByOrg[orgId] ?? [], (row) => row.retentionDays)
						const horizon = readHorizonOf({
							overrides,
							sources: Arr.map(sourceOverrides, (each) => ({ overrides: each })),
							readHorizonDays: readHorizonDays(overrides, sourceOverrides),
						})
						return { orgId, days: horizon.days, configured: horizon.configured }
					}),
					(org) => org.configured.length > 0,
				)
				yield* Effect.annotateCurrentSpan({ "result.rowCount": orgs.length })
				return { readAtMs, orgs }
			})

			// The isolate's copy of the whole set. A set past `freshUntil` stays as the last known.
			const state = yield* ReadHorizonMemo
			const horizonOf = (orgId: OrgId) => state.known?.byOrg.get(orgId) ?? DEFAULT_READ_HORIZON
			// A snapshot read before one of this isolate's writes must not undo it, whichever
			// isolate read it. A write the snapshot is sure to hold is forgotten.
			const withWrites = (byOrg: Map<string, RetentionReadHorizon>, readAtMs: number) => {
				state.written.forEach((write, orgId) => {
					if (write.atMs + READ_HORIZON_WRITE_SKEW_MS < readAtMs) {
						state.written.delete(orgId)
						return
					}
					if (write.horizon.configured.length > 0) byOrg.set(orgId, write.horizon)
					else byOrg.delete(orgId)
				})
				return byOrg
			}

			const loadReadHorizons = Effect.fn("RetentionService.loadReadHorizons")(function* (
				nowMs: number,
			) {
				// A new isolate asks the shared cache before Postgres, unless it is mid fan-out.
				yield* edgeCache
					.getOrCompute(
						{
							bucket: READ_HORIZON_CACHE_BUCKET,
							key: READ_HORIZON_CACHE_KEY,
							ttlSeconds: READ_HORIZON_TTL_MS / 1000,
							schema: CachedReadHorizons,
							skipReadWhenSlotsHeld: true,
						},
						readConfigured(),
					)
					.pipe(
						Effect.timeoutOrElse({
							duration: Duration.millis(READ_HORIZON_LOAD_TIMEOUT_MS),
							orElse: () =>
								Effect.fail(
									new RetentionPersistenceError({
										message: "Retention policies took too long to read",
									}),
								),
						}),
						Effect.tap((result) =>
							Effect.annotateCurrentSpan({
								"maple.retention.read_horizon.source": result.hit ? "edge_cache" : "postgres",
								"maple.retention.read_horizon.orgs": result.value.orgs.length,
							}),
						),
						Effect.map((result) => {
							state.known = {
								byOrg: withWrites(
									new Map(
										Arr.map(result.value.orgs, (org) => [
											org.orgId,
											{ days: org.days, configured: org.configured },
										]),
									),
									result.value.readAtMs,
								),
								freshUntil: nowMs + READ_HORIZON_TTL_MS,
							}
						}),
						// A telemetry read must not fail or stall on the policy read: the last known
						// horizons, else the defaults, held from now so a slow database is not asked per read.
						Effect.catchTag("@maple/http/retention/RetentionPersistenceError", (error) =>
							Effect.gen(function* () {
								const failedAtMs = yield* Clock.currentTimeMillis
								yield* Effect.annotateCurrentSpan({
									"maple.retention.read_horizon.source":
										state.known === undefined ? "defaults" : "last_known",
									"maple.retention.read_horizon.error": error.message,
								})
								state.known = {
									byOrg: withWrites(
										state.known?.byOrg ?? new Map<string, RetentionReadHorizon>(),
										0,
									),
									freshUntil: failedAtMs + READ_HORIZON_RETRY_MS,
								}
							}),
						),
						Effect.ensuring(
							Effect.sync(() => {
								state.refreshStartedAt = undefined
							}),
						),
					)
			})

			// No span of its own: a hit is a clock read and a map lookup on every warehouse read.
			const readHorizonAfter = (orgId: OrgId, polls: number): Effect.Effect<RetentionReadHorizon> =>
				Effect.flatMap(Clock.currentTimeMillis, (nowMs) => {
					// While another fiber reads the policies, the rest never start a read of their own
					// and never wait on that fiber: it may belong to another request, and its
					// connection with it. They keep the last known horizons, or with none yet they
					// look again shortly, since the defaults would let a bounded org read too far.
					const startedAt = state.refreshStartedAt
					const loading =
						startedAt !== undefined && nowMs - startedAt < READ_HORIZON_REFRESH_STALE_MS
					if (state.known !== undefined && (loading || nowMs < state.known.freshUntil)) {
						return Effect.succeed(horizonOf(orgId))
					}
					if (loading && polls * READ_HORIZON_COLD_POLL_MS < READ_HORIZON_LOAD_TIMEOUT_MS) {
						return Effect.flatMap(Effect.sleep(Duration.millis(READ_HORIZON_COLD_POLL_MS)), () =>
							readHorizonAfter(orgId, polls + 1),
						)
					}
					// Marked here, in the same step as the check, so the next reader sees it.
					state.refreshStartedAt = nowMs
					return Effect.map(loadReadHorizons(nowMs), () => horizonOf(orgId))
				})
			const readHorizon = (orgId: OrgId) => readHorizonAfter(orgId, 0)

			/**
			 * A write is read back by its own instance at once. The shared entry is dropped, so
			 * the others follow as their own copy expires, within the TTL.
			 *
			 * Two writes to one organization can commit side by side, each from a snapshot
			 * without the other, so the policy is read again after the commit and the
			 * read-back that started last is the one kept. A read-back that fails or runs
			 * out of time publishes nothing: the next read loads the policies afresh.
			 */
			const rememberPolicy = (orgId: OrgId, written: RetentionPolicy) =>
				Effect.gen(function* () {
					state.readBacks += 1
					const readBack = state.readBacks
					state.latestReadBack.set(orgId, readBack)
					const committed = yield* get(orgId).pipe(
						Effect.timeoutOption(Duration.millis(READ_HORIZON_LOAD_TIMEOUT_MS)),
						Effect.orElseSucceed(() => Option.none<RetentionPolicy>()),
					)
					if (state.latestReadBack.get(orgId) === readBack) {
						if (Option.isSome(committed)) {
							const horizon = readHorizonOf(committed.value)
							state.written.set(orgId, { horizon, atMs: yield* Clock.currentTimeMillis })
							if (horizon.configured.length > 0) state.known?.byOrg.set(orgId, horizon)
							else state.known?.byOrg.delete(orgId)
						} else {
							state.written.delete(orgId)
							if (state.known !== undefined)
								state.known = { byOrg: state.known.byOrg, freshUntil: 0 }
						}
					}
					yield* edgeCache.invalidate({
						bucket: READ_HORIZON_CACHE_BUCKET,
						key: READ_HORIZON_CACHE_KEY,
					})
					return Option.getOrElse(committed, () => written)
				})

			const updateOrganization = Effect.fn("RetentionService.updateOrganization")(function* (
				orgId: OrgId,
				userId: UserId,
				update: (current: RetentionOverrides) => RetentionOverrides,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "tenant.userId": userId })
				const now = yield* Clock.currentTimeMillis
				// The read, the write and the policy it returns commit together under the org's lock.
				const written = yield* dbExecute((db) =>
					db.transaction(
						Effect.gen(function* () {
							yield* lockRetention(db, orgId)
							const stored = yield* db.run(
								PG.from(OrgRetentionPolicies)
									.select(($) => ({ retentionDays: $.retentionDays }))
									.where(($) => [$.orgId.eq(orgId)])
									.limit(1),
							)
							const before = stored[0]?.retentionDays ?? NO_OVERRIDES
							const overrides = yield* validOverrides(update(before))
							yield* db.run(
								PG.insertInto(OrgRetentionPolicies)
									.values({
										orgId,
										retentionDays: overrides,
										createdAt: now,
										updatedAt: now,
										updatedBy: userId,
									})
									.onConflictDoUpdate({
										target: ["orgId"],
										set: () => ({
											retentionDays: overrides,
											updatedAt: now,
											updatedBy: userId,
										}),
									}),
							)
							return { before, after: overrides, policy: yield* readPolicy(db, orgId) }
						}),
					),
				)
				const policy = yield* rememberPolicy(orgId, written.policy)
				return { before: written.before, after: written.after, policy } satisfies RetentionWrite
			})

			const updateSource = Effect.fn("RetentionService.updateSource")(function* (
				orgId: OrgId,
				userId: UserId,
				sourceId: SourceId,
				update: (current: RetentionOverrides) => RetentionOverrides,
			) {
				yield* Effect.annotateCurrentSpan({
					orgId,
					"tenant.userId": userId,
					"maple.source.id": sourceId,
				})
				const now = yield* Clock.currentTimeMillis
				const written = yield* dbExecute((db) =>
					db.transaction(
						Effect.gen(function* () {
							yield* lockRetention(db, orgId)
							const stored = yield* db.run(
								PG.from(Sources)
									.select(($) => ({ retentionDays: $.retentionDays }))
									.where(($) => [$.orgId.eq(orgId), $.id.eq(sourceId)])
									.limit(1),
							)
							const row = stored[0]
							if (row === undefined) {
								return yield* new SourceNotFoundError({
									sourceId,
									message: "Source not found",
								})
							}
							const overrides = yield* validOverrides(update(row.retentionDays))
							yield* db.run(
								PG.update(Sources)
									.set({ retentionDays: overrides, updatedAt: now, updatedBy: userId })
									.where(($) => [$.orgId.eq(orgId), $.id.eq(sourceId)]),
							)
							return {
								before: row.retentionDays,
								after: overrides,
								policy: yield* readPolicy(db, orgId),
							}
						}),
					),
				)
				const policy = yield* rememberPolicy(orgId, written.policy)
				return { before: written.before, after: written.after, policy } satisfies RetentionWrite
			})

			/** Replaces what the organization set. */
			const setOrganization = (orgId: OrgId, userId: UserId, overrides: RetentionOverrides) =>
				Effect.map(
					updateOrganization(orgId, userId, () => overrides),
					(written) => written.policy,
				)

			/** Replaces one source's overrides; an empty set makes it inherit again. */
			const setSource = (
				orgId: OrgId,
				userId: UserId,
				sourceId: SourceId,
				overrides: RetentionOverrides,
			) =>
				Effect.map(
					updateSource(orgId, userId, sourceId, () => overrides),
					(written) => written.policy,
				)

			return {
				get,
				readHorizon,
				setOrganization,
				setSource,
				updateOrganization,
				updateSource,
			} satisfies RetentionServiceApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
