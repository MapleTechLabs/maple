import * as PG from "@maple-dev/effect-orm/postgres"
import { OrgRetentionPolicies, Sources } from "@maple/db/tables"
import { RetentionPersistenceError, SourceNotFoundError } from "@maple/domain/http"
import {
	DEFAULT_RETENTION_DAYS,
	hasRetentionOverrides,
	organizationRetentionDays,
	readHorizonDays,
	RETENTION_SIGNALS,
	type RetentionDaysBySignal,
	type RetentionOverrides,
	type RetentionSignal,
	sourceRetentionDays,
} from "@maple/domain/retention"
import type { OrgId, SourceId, UserId } from "@maple/primitives"
import { Array as Arr, Clock, Context, Effect, Layer } from "effect"
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
export const readHorizonOf = (policy: RetentionPolicy): RetentionReadHorizon => ({
	days: policy.readHorizonDays,
	configured: Arr.filter(
		RETENTION_SIGNALS,
		(signal) =>
			policy.overrides[signal] !== undefined ||
			Arr.some(policy.sources, (source) => source.overrides[signal] !== undefined),
	),
})

/** How long a read horizon is served before the policy is read again. */
export const READ_HORIZON_TTL_MS = 60_000
/** After a failed policy read, how long the fallback is served before the next attempt. */
export const READ_HORIZON_RETRY_MS = 10_000
/** A refresh marker older than this is from a fiber that never cleared it. */
const READ_HORIZON_REFRESH_STALE_MS = 10_000
/** Entries are a few numbers each; eviction only costs the evicted org one policy read. */
export const READ_HORIZON_CACHE_MAX_ENTRIES = 2_048

export interface RetentionServiceApi {
	readonly get: (orgId: OrgId) => Effect.Effect<RetentionPolicy, RetentionPersistenceError>
	/**
	 * The organization's read horizon from a per-isolate cache, for the read path. It never
	 * fails: a failed policy read serves the last known horizon, else the defaults.
	 */
	readonly readHorizon: (orgId: OrgId) => Effect.Effect<RetentionReadHorizon>
	/** Replaces what the organization set. It applies to data ingested from now on. */
	readonly setOrganization: (
		orgId: OrgId,
		userId: UserId,
		overrides: RetentionOverrides,
	) => Effect.Effect<RetentionPolicy, RetentionPersistenceError>
	/** Replaces one source's overrides; an empty set makes it inherit again. */
	readonly setSource: (
		orgId: OrgId,
		userId: UserId,
		sourceId: SourceId,
		overrides: RetentionOverrides,
	) => Effect.Effect<RetentionPolicy, RetentionPersistenceError | SourceNotFoundError>
}

const toPersistenceError = makePersistenceErrorMapper(
	RetentionPersistenceError,
	"Retention persistence failed",
)

const NO_OVERRIDES: RetentionOverrides = {}

export class RetentionService extends Context.Service<RetentionService, RetentionServiceApi>()(
	"@maple/backend/services/retention/RetentionService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const dbExecute = makeDbExecute(database, "RetentionService", toPersistenceError)

			const get = Effect.fn("RetentionService.get")(function* (orgId: OrgId) {
				yield* Effect.annotateCurrentSpan({ orgId })
				const policies = yield* dbExecute((db) =>
					db.run(
						PG.from(OrgRetentionPolicies)
							.select(($) => ({ retentionDays: $.retentionDays }))
							.where(($) => [$.orgId.eq(orgId)])
							.limit(1),
					),
				)
				const sourceRows = yield* dbExecute((db) =>
					db.run(
						PG.from(Sources)
							.select(($) => ({ id: $.id, retentionDays: $.retentionDays }))
							.where(($) => [$.orgId.eq(orgId)])
							.orderBy(["id", "asc"]),
					),
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

			// Per-instance (per-isolate) cache. An entry past `freshUntil` stays as the last
			// known horizon, so only the size bound evicts. Map order is least recently used first.
			const horizons = new Map<
				OrgId,
				{ readonly horizon: RetentionReadHorizon; readonly freshUntil: number }
			>()
			const refreshing = new Map<OrgId, number>()
			const remember = (orgId: OrgId, horizon: RetentionReadHorizon, freshUntil: number) => {
				horizons.delete(orgId)
				if (horizons.size >= READ_HORIZON_CACHE_MAX_ENTRIES) {
					const oldest = horizons.keys().next().value
					if (oldest !== undefined) horizons.delete(oldest)
				}
				horizons.set(orgId, { horizon, freshUntil })
				return horizon
			}

			const loadReadHorizon = Effect.fn("RetentionService.loadReadHorizon")(function* (
				orgId: OrgId,
				nowMs: number,
			) {
				yield* Effect.annotateCurrentSpan({ orgId })
				refreshing.set(orgId, nowMs)
				return yield* get(orgId).pipe(
					Effect.tap(() =>
						Effect.annotateCurrentSpan("maple.retention.read_horizon.source", "postgres"),
					),
					Effect.map((policy) =>
						remember(orgId, readHorizonOf(policy), nowMs + READ_HORIZON_TTL_MS),
					),
					// A telemetry read must not fail on the policy read: the last known horizon, else
					// the defaults, held for a short while so a down database is not asked per read.
					Effect.catchTag("@maple/http/retention/RetentionPersistenceError", (error) => {
						const known = horizons.get(orgId)
						return Effect.as(
							Effect.annotateCurrentSpan({
								"maple.retention.read_horizon.source":
									known === undefined ? "defaults" : "last_known",
								"maple.retention.read_horizon.error": error.message,
							}),
							remember(
								orgId,
								known?.horizon ?? DEFAULT_READ_HORIZON,
								nowMs + READ_HORIZON_RETRY_MS,
							),
						)
					}),
					Effect.ensuring(Effect.sync(() => refreshing.delete(orgId))),
				)
			})

			// No span of its own: a hit is a clock read and a map lookup on every warehouse read.
			const readHorizon = (orgId: OrgId) =>
				Effect.flatMap(Clock.currentTimeMillis, (nowMs) => {
					const cached = horizons.get(orgId)
					if (cached === undefined) return loadReadHorizon(orgId, nowMs)
					// While another fiber reads the policy, the rest keep the last known horizon
					// instead of each asking Postgres. They never wait on it: that fiber may
					// belong to another request, and its connection with it.
					const startedAt = refreshing.get(orgId)
					const fresh =
						nowMs < cached.freshUntil ||
						(startedAt !== undefined && nowMs - startedAt < READ_HORIZON_REFRESH_STALE_MS)
					if (!fresh) return loadReadHorizon(orgId, nowMs)
					horizons.delete(orgId)
					horizons.set(orgId, cached)
					return Effect.succeed(cached.horizon)
				})

			/** A write is read back by its own isolate at once; the others follow within the TTL. */
			const rememberPolicy = (orgId: OrgId, policy: RetentionPolicy) =>
				Effect.map(Clock.currentTimeMillis, (nowMs) => {
					remember(orgId, readHorizonOf(policy), nowMs + READ_HORIZON_TTL_MS)
					return policy
				})

			const setOrganization = Effect.fn("RetentionService.setOrganization")(function* (
				orgId: OrgId,
				userId: UserId,
				overrides: RetentionOverrides,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "tenant.userId": userId })
				const now = yield* Clock.currentTimeMillis
				yield* dbExecute((db) =>
					db.run(
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
								set: () => ({ retentionDays: overrides, updatedAt: now, updatedBy: userId }),
							}),
					),
				)
				return yield* Effect.flatMap(get(orgId), (policy) => rememberPolicy(orgId, policy))
			})

			const setSource = Effect.fn("RetentionService.setSource")(function* (
				orgId: OrgId,
				userId: UserId,
				sourceId: SourceId,
				overrides: RetentionOverrides,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "tenant.userId": userId, sourceId })
				const now = yield* Clock.currentTimeMillis
				const updated = yield* dbExecute((db) =>
					db.run(
						PG.update(Sources)
							.set({ retentionDays: overrides, updatedAt: now, updatedBy: userId })
							.where(($) => [$.orgId.eq(orgId), $.id.eq(sourceId)])
							.returning(($) => ({ id: $.id })),
					),
				)
				if (updated.length === 0) {
					return yield* new SourceNotFoundError({ sourceId, message: "Source not found" })
				}
				return yield* Effect.flatMap(get(orgId), (policy) => rememberPolicy(orgId, policy))
			})

			return { get, readHorizon, setOrganization, setSource } satisfies RetentionServiceApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
