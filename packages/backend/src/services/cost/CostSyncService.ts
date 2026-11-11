// Cost sync: each tick brings `cost_sources` in step with the provider connections that grant cost,
// then claims due sources and runs a few plan steps each: HEAD (the trailing days), SETTLE (the open
// months) or BACKFILL (a month toward the floor). A step pulls its window through the provider's
// adapter and writes it whole under one `IngestedAt`; a failure backs the source off.
import { randomUUID } from "node:crypto"
import type { CostProvider } from "@maple/domain/cost"
import { IntegrationsPersistenceError, OrgId } from "@maple/domain/http"
import type { CostDailyRow } from "@maple/domain/tinybird"
import { CostSourceId } from "@maple/primitives"
import * as PG from "@maple-dev/effect-orm/postgres"
import { AwsConnections, CostSources, type CostSourceRow } from "@maple/db/tables"
import { Clock, Context, Effect, Layer, Result, Schedule, Schema, Array as Arr, String as Str } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute, makePersistenceErrorMapper } from "@maple/backend/platform/db-execute"
import { ALERTING_SYSTEM_USER_ID, systemTenant } from "@maple/backend/services/auth/system-tenant"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { leaseClaimable, leaseStillOurs } from "../integrations/lease"
import { pollFleet } from "../integrations/poll-fleet"
import type { CostProviderAdapter, CostProviderError } from "./CostProvider"
import { AwsCostProvider } from "./providers/aws/AwsCostProvider"
import {
	advanceCostSync,
	batchWholeDays,
	COST_DATASOURCE,
	type CostSyncPlan,
	type CostSyncStep,
	HEAD_INTERVAL_MS,
	historyFloor,
	planCostSync,
	toCostDailyRows,
	toWarehouseDateTime64,
	utcMonth,
	utcToday,
} from "./sync-plan"

/** Longer than the lane deadline, so a live tick never loses its claim. */
const LEASE_MS = 15 * 60_000
/** Backoff after a claim: doubles per consecutive failure, up to a day. */
const BACKOFF_BASE_MS = 15 * 60_000
const BACKOFF_MAX_MS = 24 * 60 * 60_000
/** `not_ready` and `auth` need the customer to change something: the source sits out at least this long. */
const SETUP_HOLD_MS = 6 * 60 * 60_000
/** A throttled provider sits the source out at least this long. */
const RATE_LIMIT_HOLD_MS = 60 * 60_000
/** A tick that starts a little early still picks up a backoff that ends on its schedule. */
const TICK_SLACK_MS = 60_000
const MAX_SOURCES_PER_TICK = 20
const SOURCE_CONCURRENCY = 2
/** Plan steps one claim runs, so a new source gets its open months and two months of history at once. */
const MAX_STEPS_PER_CLAIM = 3
/** Sources one tick creates, and removes, per provider. */
const RECONCILE_LIMIT = 200
/** Rows per `ingest` request, so a large window splits into bounded Events API bodies. */
const INGEST_BATCH_ROWS = 10_000
/** 3 attempts per batch, 500ms then 1s apart. Rows are idempotent under the sorting key. */
const INGEST_RETRY_SCHEDULE = Schedule.max([Schedule.exponential("500 millis", 2.0), Schedule.recurs(2)])
const LAST_ERROR_MAX_CHARS = 500

export class CostSyncWriteError extends Schema.TaggedError<CostSyncWriteError>()(
	"@maple/backend/cost/CostSyncWriteError",
	{ message: Schema.String },
) {}

/** Internal only: failing with it inside the failure span records the exception event error views read. */
class CostSyncFailedError extends Schema.TaggedError<CostSyncFailedError>()(
	"@maple/backend/cost/CostSyncFailedError",
	{ message: Schema.String, orgId: OrgId, sourceId: CostSourceId, reason: Schema.String },
) {}

export interface CostSyncSummary {
	/** Due sources this tick looked at. */
	readonly due: number
	readonly synced: number
	/** Claimed by another tick, or nothing to do. */
	readonly skipped: number
	readonly failures: number
	readonly rowsWritten: number
	/** Billable provider API requests the tick made. */
	readonly requests: number
}

export interface CostSyncServiceApi {
	readonly pollAllSources: Effect.Effect<CostSyncSummary, IntegrationsPersistenceError>
}

interface SourceOutcome {
	readonly status: "synced" | "skipped" | "failed"
	readonly rowsWritten: number
	readonly requests: number
}

/** `CostProviderError["reason"]`, or `write` when the warehouse did not take the rows. */
type FailureReason = CostProviderError["reason"] | "write"

interface StepFailure {
	readonly reason: FailureReason
	readonly message: string
}

/** A claim's run so far. `source` mirrors what the steps wrote, so the next plan reads it. */
interface SyncProgress {
	readonly source: CostSourceRow
	readonly plan: CostSyncPlan
	readonly steps: number
	readonly rowsWritten: number
	readonly requests: number
	readonly failure: StepFailure | null
	/** Another tick holds the row now (or it is gone): nothing more is written. */
	readonly leaseLost: boolean
}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

/** The backoff a claim sets: 15 minutes doubled per consecutive failure, capped at a day. */
const nextBackoffMs = (consecutiveFailures: number): number =>
	Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(consecutiveFailures, 16))

/** How long a failure holds the source at least; the claim's backoff stands when it is longer. */
const holdMs = (reason: FailureReason): number =>
	reason === "not_ready" || reason === "auth"
		? SETUP_HOLD_MS
		: reason === "rate_limited"
			? RATE_LIMIT_HOLD_MS
			: 0

const SKIPPED: SourceOutcome = { status: "skipped", rowsWritten: 0, requests: 0 }
const FAILED: SourceOutcome = { status: "failed", rowsWritten: 0, requests: 0 }

export class CostSyncService extends Context.Service<CostSyncService, CostSyncServiceApi>()(
	"@maple/backend/services/cost/CostSyncService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const warehouse = yield* WarehouseQueryService
			// One adapter per provider literal: a new provider does not compile until it has one.
			const adapters = {
				aws: yield* AwsCostProvider,
			} satisfies Record<CostProvider, CostProviderAdapter>
			const dbExecute = makeDbExecute(
				database,
				"CostSyncService",
				makePersistenceErrorMapper(IntegrationsPersistenceError, "Cost sync database error"),
			)

			const leaseFree = ($: PG.ColumnAccessor<typeof CostSources.columns>, now: number) =>
				// A live lease never reaches past now + LEASE_MS; anything further is a corrupt value.
				leaseClaimable($.leaseUntil, now, 2 * LEASE_MS)

			/**
			 * AWS: a source for every verified connection whose role grants `cost`, and none for a
			 * connection that is gone or lost the grant. Joined by org, so a ref never crosses orgs.
			 */
			const reconcileAws = Effect.fn("CostSyncService.reconcileAws")(function* (now: number) {
				const grantsCost = encodeJson(["cost"])
				const missing = yield* dbExecute((db) =>
					db.run(
						PG.from(AwsConnections, "c")
							.leftJoin(CostSources, "s", (connection, source) =>
								source.orgId
									.eq(connection.orgId)
									.and(source.provider.eq("aws"))
									.and(source.connectionRef.eq(connection.id)),
							)
							.select(($) => ({ id: $.id, orgId: $.orgId, accountId: $.accountId }))
							.where(($) => [
								$.verifiedAt.isNotNull(),
								PG.sql.cond`${$.grantedModules} @> ${grantsCost}::jsonb`,
								$.s.id.isNull(),
							])
							.orderBy(["id", "asc"])
							.limit(RECONCILE_LIMIT),
					),
				)
				const created = yield* Effect.forEach(missing, (connection) =>
					Effect.sync(() => CostSourceId.make(randomUUID())).pipe(
						Effect.flatMap((id) =>
							dbExecute((db) =>
								db.run(
									PG.insertInto(CostSources)
										.values({
											id,
											orgId: connection.orgId,
											provider: "aws",
											connectionRef: connection.id,
											accountId: connection.accountId,
											createdAt: now,
											updatedAt: now,
										})
										// Another tick made it first.
										.onConflictDoNothing()
										.returning(($) => ({ id: $.id })),
								),
							),
						),
					),
				)
				const stale = yield* dbExecute((db) =>
					db.run(
						PG.from(CostSources, "s")
							.leftJoin(AwsConnections, "c", (source, connection) =>
								source.orgId.eq(connection.orgId).and(source.connectionRef.eq(connection.id)),
							)
							.select(($) => ({ id: $.id }))
							.where(($) => [
								$.provider.eq("aws"),
								// Also true for a connection that was never checked: its grant is null.
								PG.or(
									$.c.id.isNull(),
									PG.sql
										.cond`NOT coalesce(${$.c.grantedModules} @> ${grantsCost}::jsonb, false)`,
								),
							])
							.orderBy(["id", "asc"])
							.limit(RECONCILE_LIMIT),
					),
				)
				const removed = Arr.isReadonlyArrayNonEmpty(stale)
					? yield* dbExecute((db) =>
							db.run(
								PG.deleteFrom(CostSources)
									.where(($) => [
										$.provider.eq("aws"),
										PG.inList(
											$.id,
											Arr.map(stale, (source) => source.id),
										),
									])
									.returning(($) => ({ id: $.id })),
							),
						)
					: []
				yield* Effect.annotateCurrentSpan({
					"maple.cost.provider": "aws",
					"maple.cost.sources_created": Arr.flatten(created).length,
					"maple.cost.sources_removed": removed.length,
				})
			})

			/** One function per provider; each owns the sources of its own connection table. */
			const reconcile = (now: number) => Effect.all([reconcileAws(now)], { discard: true })

			/** Sources with a pull due and no backoff, healthy ones first. */
			const loadDue = (now: number) => {
				const floor = historyFloor(utcToday(now))
				return dbExecute((db) =>
					db.run(
						PG.from(CostSources)
							.select(($) => ({
								id: $.id,
								orgId: $.orgId,
								consecutiveFailures: $.consecutiveFailures,
							}))
							.where(($) => [
								leaseFree($, now),
								PG.or($.nextAttemptAt.isNull(), $.nextAttemptAt.lte(now + TICK_SLACK_MS)),
								PG.or(
									$.watermarkDate.isNull(),
									$.lastSyncedAt.isNull(),
									$.lastSyncedAt.lte(now - HEAD_INTERVAL_MS),
									$.backfillDate.gt(floor),
								),
							])
							.orderBy(($) => [
								// Failing sources go last, so a pile of them cannot take every slot.
								[PG.asBoolean($.lastError.isNull()), "desc"],
								[PG.asBoolean($.lastSyncedAt.isNull()), "desc"],
								[$.lastSyncedAt, "asc"],
								[$.updatedAt, "asc"],
							])
							.limit(MAX_SOURCES_PER_TICK),
					),
				)
			}

			/**
			 * Leases the row and backs it off up front, counting the attempt as a failure until it
			 * succeeds, so a sync killed mid-way also waits, longer each time. Success resets the count.
			 */
			const claim = (candidate: Pick<CostSourceRow, "id" | "consecutiveFailures">, now: number) =>
				dbExecute((db) =>
					db.run(
						PG.update(CostSources)
							.set({
								leaseUntil: now + LEASE_MS,
								nextAttemptAt: now + nextBackoffMs(candidate.consecutiveFailures),
								consecutiveFailures: candidate.consecutiveFailures + 1,
								updatedAt: now,
							})
							.where(($) => [$.id.eq(candidate.id), leaseFree($, now)])
							.returning(),
					),
				).pipe(Effect.map((rows) => rows[0] ?? null))

			/**
			 * Compare-and-set on the claimed lease, so a tick that outlived it never touches a
			 * successor's row. False when the row was not ours any more.
			 */
			const updateLeased = (
				source: CostSourceRow,
				set: PG.UpdateSetOf<typeof CostSources>,
				now: number,
			) =>
				dbExecute((db) =>
					db.run(
						PG.update(CostSources)
							.set({ updatedAt: now, ...set })
							.where(($) => [
								$.id.eq(source.id),
								leaseStillOurs($.leaseUntil, source.leaseUntil),
							])
							.returning(($) => ({ id: $.id })),
					),
				).pipe(Effect.map(Arr.isReadonlyArrayNonEmpty))

			const finish = (source: CostSourceRow, set: PG.UpdateSetOf<typeof CostSources>, now: number) =>
				updateLeased(source, { leaseUntil: null, ...set }, now)

			/** Logs the failure and fails a child span with it, so it reaches error views; never fails the caller. */
			const observeFailure = (source: CostSourceRow, failure: StepFailure) =>
				Effect.gen(function* () {
					yield* Effect.logWarning("cost sync failed").pipe(
						Effect.annotateLogs({
							orgId: source.orgId,
							sourceId: source.id,
							provider: source.provider,
							reason: failure.reason,
							error: failure.message,
						}),
					)
					return yield* new CostSyncFailedError({
						message: failure.message,
						orgId: source.orgId,
						sourceId: source.id,
						reason: failure.reason,
					})
				}).pipe(
					Effect.withSpan("CostSyncService.syncFailed", {
						attributes: {
							orgId: source.orgId,
							"maple.cost.source_id": source.id,
							"maple.cost.provider": source.provider,
							"maple.cost.error_reason": failure.reason,
							"maple.cost.error": failure.message,
						},
					}),
					Effect.ignore,
				)

			// A batch that still fails after its retries leaves the earlier batches newest until a re-pull.
			// Batches hold whole days, so those are complete days; only a day above the batch size can split.
			const write = (orgId: OrgId, rows: ReadonlyArray<CostDailyRow>) =>
				Effect.forEach(
					batchWholeDays(rows, INGEST_BATCH_ROWS),
					(batch) =>
						warehouse
							.ingest(systemTenant(orgId, ALERTING_SYSTEM_USER_ID), COST_DATASOURCE, batch)
							.pipe(Effect.retry(INGEST_RETRY_SCHEDULE)),
					{ discard: true },
				).pipe(
					Effect.mapError(
						(error) =>
							new CostSyncWriteError({
								message: `Maple could not store the cost rows: ${error.message}`,
							}),
					),
				)

			/** The month's billable request count with `requests` more; a new UTC month starts it over. */
			const countRequests = (source: CostSourceRow, requests: number, now: number) => {
				const month = utcMonth(now)
				return {
					requestsMonth: month,
					requestsCount:
						source.requestsMonth === month ? source.requestsCount + requests : requests,
				}
			}

			/**
			 * One plan step: pull the window, count its requests, write it whole under one `IngestedAt`,
			 * then move the frontier. A failure or a lost lease leaves the frontier where it was.
			 */
			const syncStep = Effect.fn("CostSyncService.syncStep")(function* (
				progress: SyncProgress,
				step: CostSyncStep,
			) {
				const { source } = progress
				const now = yield* Clock.currentTimeMillis
				yield* Effect.annotateCurrentSpan({
					orgId: source.orgId,
					"maple.cost.provider": source.provider,
					"maple.cost.mode": step.mode,
					"maple.cost.start_day": step.startDay,
					"maple.cost.end_day": step.endDay,
				})
				const pulled = yield* adapters[source.provider]
					.pull(
						{ orgId: source.orgId, connectionRef: source.connectionRef },
						{ startDay: step.startDay, endDay: step.endDay },
					)
					.pipe(Effect.result)
				// A failed pull was billed for what it asked before it failed.
				const requests = Result.isFailure(pulled) ? pulled.failure.requests : pulled.success.requests
				yield* Effect.annotateCurrentSpan("maple.cost.requests", requests)
				const counted = countRequests(source, requests, now)
				const done = (set: Partial<SyncProgress>): SyncProgress => ({
					...progress,
					source: { ...source, ...counted },
					steps: progress.steps + 1,
					requests: progress.requests + requests,
					...set,
				})
				// Doubles as the lease check before anything reaches the warehouse.
				if (!(yield* updateLeased(source, counted, now))) return done({ leaseLost: true })
				if (Result.isFailure(pulled)) {
					const { reason, message } = pulled.failure
					return done({ failure: { reason, message } })
				}
				// Readers keep only the newest `IngestedAt` per source and day, so each must be a whole pull.
				const rows = toCostDailyRows(
					{
						orgId: source.orgId,
						sourceId: source.id,
						provider: source.provider,
						ingestedAt: toWarehouseDateTime64(now),
					},
					pulled.success.rows,
					step,
				)
				const written = yield* write(source.orgId, rows).pipe(Effect.result)
				if (Result.isFailure(written)) {
					return done({ failure: { reason: "write", message: written.failure.message } })
				}
				yield* Effect.annotateCurrentSpan("maple.cost.rows_written", rows.length)
				const advanced = advanceCostSync(source, step, now)
				const rowsWritten = progress.rowsWritten + rows.length
				if (!(yield* updateLeased(source, advanced, now)))
					return done({ rowsWritten, leaseLost: true })
				const next = { ...source, ...counted, ...advanced }
				return done({ source: next, rowsWritten, plan: planCostSync(next, now) })
			})

			/** Step after step, re-planning from what the last one wrote, until idle, a failure or the cap. */
			const runSteps = (
				state: SyncProgress,
			): Effect.Effect<SyncProgress, IntegrationsPersistenceError> =>
				state.failure !== null ||
				state.leaseLost ||
				state.plan.mode === "idle" ||
				state.steps >= MAX_STEPS_PER_CLAIM
					? Effect.succeed(state)
					: syncStep(state, state.plan).pipe(Effect.flatMap(runSteps))

			const syncSource = Effect.fn("CostSyncService.syncSource")(function* (
				claimed: CostSourceRow,
				claimedAt: number,
			) {
				const first = planCostSync(claimed, claimedAt)
				yield* Effect.annotateCurrentSpan({
					orgId: claimed.orgId,
					"maple.cost.source_id": claimed.id,
					"maple.cost.provider": claimed.provider,
					"maple.cost.mode": first.mode,
				})
				const progress = yield* runSteps({
					source: claimed,
					plan: first,
					steps: 0,
					rowsWritten: 0,
					requests: 0,
					failure: null,
					leaseLost: false,
				})
				const { source, failure, rowsWritten, requests } = progress
				const now = yield* Clock.currentTimeMillis
				const outcome = (status: SourceOutcome["status"]) =>
					Effect.annotateCurrentSpan({
						"maple.cost.steps": progress.steps,
						"maple.cost.rows_written": rowsWritten,
						"maple.cost.requests": requests,
						"maple.cost.outcome": status,
					}).pipe(Effect.as({ status, rowsWritten, requests } satisfies SourceOutcome))
				if (progress.leaseLost) return yield* outcome("skipped")
				if (failure !== null) {
					yield* observeFailure(source, failure)
					// The claim already counted this failure and set its backoff; some reasons wait longer.
					const backoffUntil = source.nextAttemptAt ?? now + BACKOFF_BASE_MS
					yield* finish(
						source,
						{
							lastError: Str.slice(0, LAST_ERROR_MAX_CHARS)(failure.message),
							lastErrorReason: failure.reason,
							nextAttemptAt: Math.max(backoffUntil, now + holdMs(failure.reason)),
						},
						now,
					)
					return yield* outcome("failed")
				}
				if (progress.steps === 0) {
					yield* finish(source, { nextAttemptAt: null, consecutiveFailures: 0 }, now)
					return yield* outcome("skipped")
				}
				yield* finish(
					source,
					{ lastError: null, lastErrorReason: null, nextAttemptAt: null, consecutiveFailures: 0 },
					now,
				)
				return yield* outcome("synced")
			})

			/** Claim and sync each due source; a lost claim is a skip. */
			const syncDue = (
				due: ReadonlyArray<Pick<CostSourceRow, "id" | "orgId" | "consecutiveFailures">>,
			) =>
				Effect.gen(function* () {
					yield* Effect.annotateCurrentSpan("maple.cost.due_sources", due.length)
					// One source's database failure must not fail the tick.
					const outcomes = yield* pollFleet(
						due,
						(candidate) =>
							Effect.gen(function* () {
								// Each claim reads its own clock: a late claim in a long tick still gets a full lease.
								const claimedAt = yield* Clock.currentTimeMillis
								const source = yield* claim(candidate, claimedAt)
								return source === null ? SKIPPED : yield* syncSource(source, claimedAt)
							}),
						{
							message: "cost sync failed",
							annotations: (candidate) => ({ orgId: candidate.orgId, sourceId: candidate.id }),
							fallback: () => FAILED,
						},
						SOURCE_CONCURRENCY,
					)
					const count = (status: SourceOutcome["status"]) =>
						Arr.filter(outcomes, (outcome) => outcome.status === status).length
					const summary = {
						due: due.length,
						synced: count("synced"),
						skipped: count("skipped"),
						failures: count("failed"),
						rowsWritten: Arr.reduce(outcomes, 0, (sum, outcome) => sum + outcome.rowsWritten),
						requests: Arr.reduce(outcomes, 0, (sum, outcome) => sum + outcome.requests),
					} satisfies CostSyncSummary
					yield* Effect.annotateCurrentSpan({
						"maple.cost.synced_sources": summary.synced,
						"maple.cost.failed_sources": summary.failures,
						"maple.cost.rows_written": summary.rowsWritten,
						"maple.cost.requests": summary.requests,
					})
					return summary
				})

			const pollAllSources = Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis
				yield* reconcile(now)
				const due = yield* loadDue(now)
				return yield* syncDue(due)
			}).pipe(Effect.withSpan("CostSyncService.pollAllSources"))

			return { pollAllSources } satisfies CostSyncServiceApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(Layer.mergeAll(AwsCostProvider.layer, WarehouseQueryService.layer)),
	)
}
