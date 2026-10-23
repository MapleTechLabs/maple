import {
	CodeReviewCiAnalytics,
	CodeReviewCiBucket,
	CodeReviewCiFailedJob,
	CodeReviewCiJob,
	CodeReviewCiPipeline,
	type CodeReviewCiQuery,
	CodeReviewCiRedStreak,
	CodeReviewCiRun,
	type CodeReviewCiRunsQuery,
	CodeReviewCiRunsResponse,
	CodeReviewCiTotals,
	PrReviewPersistenceError,
	type VcsRepositoryId,
	type WarehouseReadError,
} from "@maple/domain/http"
import type { OrgId } from "@maple/domain/primitives"
import * as PG from "@maple-dev/effect-orm/postgres"
import { VcsRepositories } from "@maple/db/tables"
import { CH, formatWarehouseDateTime } from "@maple/query-engine"
import type { CompiledQueryInput } from "@maple/query-engine/execution"
import { Array as Arr, Clock, Context, DateTime, Effect, Layer } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import type { TenantContext } from "@maple/backend/services/auth/AuthService"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"

type CiError = PrReviewPersistenceError | WarehouseReadError

export interface CiAnalyticsServiceApi {
	readonly analytics: (
		tenant: TenantContext,
		query: CodeReviewCiQuery,
	) => Effect.Effect<CodeReviewCiAnalytics, CiError>
	readonly listRuns: (
		tenant: TenantContext,
		query: CodeReviewCiRunsQuery,
	) => Effect.Effect<CodeReviewCiRunsResponse, CiError>
}

const HOUR = 3_600
const DAY = 86_400
/** How far back `ci_runs` and `ci_jobs` keep runs. */
const CI_RETENTION_MS = 365 * DAY * 1000
/** The longest window read: the retention plus a day to absorb a DST change at either end. */
export const CI_MAX_SPAN_MS = CI_RETENTION_MS + DAY * 1000
/** Runs read per possibly red workflow to find where its streak began. */
const STREAK_RUNS = 200
/** How many possibly red workflows are read at once. */
const STREAK_CONCURRENCY = 4
/** Workflows checked for a red streak, busiest first: each check is its own scan. */
const STREAK_CANDIDATES = 10
const DEFAULT_PAGE = 50
/** Failed jobs read per failed run: a matrix workflow can fail dozens at once. */
const FAILED_JOBS_PER_RUN = 50

/** Hourly up to two days, six-hourly to a month, daily to four months, weekly beyond. */
export const ciBucketSeconds = (spanMs: number) =>
	spanMs <= 2 * DAY * 1000
		? HOUR
		: spanMs <= 32 * DAY * 1000
			? 6 * HOUR
			: spanMs <= 120 * DAY * 1000
				? DAY
				: 7 * DAY

/** The window actually read: the start is moved up to the newest `CI_MAX_SPAN_MS`. */
export const ciWindow = (query: { readonly startTime: number; readonly endTime: number }) => {
	const startTime = Math.max(query.startTime, query.endTime - CI_MAX_SPAN_MS)
	return { startTime, endTime: Math.max(startTime, query.endTime) }
}

const encodeCursor = (startedAtMs: number, traceId: string) => `${startedAtMs}_${traceId}`
const decodeCursor = (cursor: string) => {
	const at = cursor.indexOf("_")
	return {
		startedAt: DateTime.makeUnsafe(Number(cursor.slice(0, at))),
		traceId: cursor.slice(at + 1),
	}
}

/** A quantile over no rows is NaN or null; the contract says null. */
const finiteOrNull = (value: number | null) => (value !== null && Number.isFinite(value) ? value : null)

type CiSeriesRow = {
	readonly bucket: DateTime.Utc
	readonly succeeded: number
	readonly failed: number
	readonly cancelled: number
	readonly p50DurationMs: number | null
	readonly p95DurationMs: number | null
}

/** A red workflow's latest judged run failed; a cancelled run after it keeps the streak open. */
const mayBeRed = (lastResult: string) => CH.isCiFailedResult(lastResult) || lastResult === "cancellation"

const pipelineOf = (
	row: {
		readonly owner: string
		readonly repository: string
		readonly pipeline: string
		readonly runs: number
		readonly failed: number
		readonly cancelled: number
		readonly p50DurationMs: number | null
		readonly p95DurationMs: number | null
		readonly totalDurationMs: number
		readonly lastResult: string
		readonly lastStartedAt: DateTime.Utc
	},
	streak:
		| CH.CiRedStreak<{
				readonly revision: string
				readonly traceId: string
				readonly startedAt: DateTime.Utc
		  }>
		| undefined,
) =>
	new CodeReviewCiPipeline({
		owner: row.owner,
		repository: row.repository,
		pipeline: row.pipeline,
		runs: row.runs,
		failed: row.failed,
		cancelled: row.cancelled,
		p50DurationMs: row.p50DurationMs ?? 0,
		p95DurationMs: row.p95DurationMs ?? 0,
		totalDurationMs: row.totalDurationMs,
		lastResult: row.lastResult,
		lastStartedAt: DateTime.toEpochMillis(row.lastStartedAt),
		red:
			streak === undefined
				? null
				: new CodeReviewCiRedStreak({
						failedRuns: streak.failedRuns,
						since: DateTime.toEpochMillis(streak.firstFailed.startedAt),
						firstFailedRevision: streak.firstFailed.revision,
						firstFailedTraceId: streak.firstFailed.traceId,
						lastGreenRevision: streak.lastGreen?.revision ?? null,
						lastGreenAt:
							streak.lastGreen === undefined
								? null
								: DateTime.toEpochMillis(streak.lastGreen.startedAt),
					}),
	})

const emptyTotals = new CodeReviewCiTotals({
	runs: 0,
	succeeded: 0,
	failed: 0,
	cancelled: 0,
	p50DurationMs: null,
	p95DurationMs: null,
	totalDurationMs: 0,
	jobs: 0,
	p50QueueMs: null,
	p95QueueMs: null,
})

export class CiAnalyticsService extends Context.Service<CiAnalyticsService, CiAnalyticsServiceApi>()(
	"@maple/api/services/pr-review/CiAnalyticsService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const warehouse = yield* WarehouseQueryService
			const dbExecute = makeDbExecute(
				database,
				"CiAnalyticsService",
				(error) => new PrReviewPersistenceError({ message: error.message }),
			)

			/**
			 * CI traces name a repository by owner and name; the filter names it by id. None when the
			 * id is not the org's, which reads as an empty result rather than another org's runs.
			 */
			const resolveScope = Effect.fn("CiAnalyticsService.resolveScope")(function* (
				orgId: OrgId,
				query: {
					readonly repositoryId?: VcsRepositoryId | undefined
					readonly pipeline?: string | undefined
				},
			): Effect.fn.Return<CH.CiScopeOpts | undefined, PrReviewPersistenceError> {
				const pipeline: CH.CiScopeOpts =
					query.pipeline === undefined ? {} : { pipeline: query.pipeline }
				if (query.repositoryId === undefined) return pipeline
				const repositoryId = query.repositoryId
				const rows = yield* dbExecute((db) =>
					db.run(
						PG.from(VcsRepositories)
							.select(($) => ({ owner: $.owner, name: $.name }))
							.where(($) => [$.orgId.eq(orgId), $.id.eq(repositoryId)])
							.limit(1),
					),
				)
				const repository = rows[0]
				return repository === undefined
					? undefined
					: { ...pipeline, owner: repository.owner, repository: repository.name }
			})

			const read = <T>(tenant: TenantContext, compiled: CompiledQueryInput<T>, context: string) =>
				warehouse.compiledQuery(tenant, compiled, { profile: "aggregation", context })

			const totalsOf = Effect.fn("CiAnalyticsService.totals")(function* (
				tenant: TenantContext,
				scope: CH.CiScopeOpts,
				startTime: number,
				endTime: number,
			) {
				const window = {
					startTime: formatWarehouseDateTime(startTime),
					endTime: formatWarehouseDateTime(endTime),
				}
				const [runs, queue] = yield* Effect.all(
					[
						read(
							tenant,
							CH.compile(CH.ciRunTotalsQuery(scope), { orgId: tenant.orgId, ...window }),
							"ciRunTotals",
						),
						read(
							tenant,
							CH.compile(CH.ciQueueTotalsQuery(scope), { orgId: tenant.orgId, ...window }),
							"ciQueueTotals",
						),
					],
					{ concurrency: "unbounded" },
				)
				const run = runs[0]
				const jobs = queue[0]
				if (run === undefined || run.runs === 0) return emptyTotals
				return new CodeReviewCiTotals({
					runs: run.runs,
					succeeded: run.succeeded,
					failed: run.failed,
					cancelled: run.cancelled,
					p50DurationMs: finiteOrNull(run.p50DurationMs),
					p95DurationMs: finiteOrNull(run.p95DurationMs),
					totalDurationMs: run.totalDurationMs,
					jobs: jobs?.jobs ?? 0,
					p50QueueMs: jobs === undefined || jobs.jobs === 0 ? null : finiteOrNull(jobs.p50QueueMs),
					p95QueueMs: jobs === undefined || jobs.jobs === 0 ? null : finiteOrNull(jobs.p95QueueMs),
				})
			})

			const analytics = Effect.fn("CiAnalyticsService.analytics")(function* (
				tenant: TenantContext,
				query: CodeReviewCiQuery,
			) {
				const { startTime, endTime } = ciWindow(query)
				const spanMs = endTime - startTime
				const bucketSeconds = ciBucketSeconds(spanMs)
				yield* Effect.annotateCurrentSpan({
					orgId: tenant.orgId,
					"maple.ci.window_ms": spanMs,
					"maple.ci.repository_filtered": query.repositoryId !== undefined,
				})

				// Every bucket of the window, so the chart's x axis is the window and not the data.
				const bucketMs = bucketSeconds * 1000
				const first = Math.floor(startTime / bucketMs) * bucketMs
				const fillSeries = (rows: ReadonlyArray<CiSeriesRow>) => {
					const bySlot = new Map(rows.map((row) => [DateTime.toEpochMillis(row.bucket), row]))
					return Array.from(
						{ length: Math.max(0, Math.ceil((endTime - first) / bucketMs)) },
						(_, i) => {
							const bucket = first + i * bucketMs
							const row = bySlot.get(bucket)
							return new CodeReviewCiBucket({
								bucket,
								succeeded: row?.succeeded ?? 0,
								failed: row?.failed ?? 0,
								cancelled: row?.cancelled ?? 0,
								p50DurationMs: row === undefined ? null : finiteOrNull(row.p50DurationMs),
								p95DurationMs: row === undefined ? null : finiteOrNull(row.p95DurationMs),
							})
						},
					)
				}

				const scope = yield* resolveScope(tenant.orgId, query)
				if (scope === undefined) {
					return new CodeReviewCiAnalytics({
						startTime,
						endTime,
						bucketSeconds,
						current: emptyTotals,
						previous: emptyTotals,
						series: fillSeries([]),
						pipelines: [],
						jobs: [],
					})
				}

				const window = {
					startTime: formatWarehouseDateTime(startTime),
					endTime: formatWarehouseDateTime(endTime),
				}
				// A previous period the tables no longer hold whole would read as a drop: compare to nothing.
				const nowMs = yield* Clock.currentTimeMillis
				const previousKept = startTime - spanMs >= nowMs - CI_RETENTION_MS
				const [current, previous, seriesRows, pipelineRows, jobRows] = yield* Effect.all(
					[
						totalsOf(tenant, scope, startTime, endTime),
						previousKept
							? totalsOf(tenant, scope, startTime - spanMs, startTime)
							: Effect.succeed(emptyTotals),
						read(
							tenant,
							CH.compile(CH.ciRunSeriesQuery(scope), {
								orgId: tenant.orgId,
								...window,
								bucketSeconds,
							}),
							"ciRunSeries",
						),
						read(
							tenant,
							CH.compile(CH.ciPipelineStatsQuery(scope), { orgId: tenant.orgId, ...window }),
							"ciPipelineStats",
						),
						read(
							tenant,
							CH.compile(CH.ciJobStatsQuery(scope), { orgId: tenant.orgId, ...window }),
							"ciJobStats",
						),
					],
					{ concurrency: "unbounded" },
				)

				// Only a workflow whose latest run broke or was cancelled can be red: read its own runs.
				// Rows come busiest first, so the checked workflows are the ones that matter most.
				const candidates = new Set(
					pipelineRows.filter((row) => mayBeRed(row.lastResult)).slice(0, STREAK_CANDIDATES),
				)
				yield* Effect.annotateCurrentSpan("maple.ci.streak_checks", candidates.size)
				const pipelines = yield* Effect.forEach(
					pipelineRows,
					(row) =>
						Effect.gen(function* () {
							const runs = candidates.has(row)
								? yield* read(
										tenant,
										CH.compile(
											CH.ciRunsQuery({
												owner: row.owner,
												repository: row.repository,
												pipeline: row.pipeline,
												ranOnly: true,
												limit: STREAK_RUNS,
											}),
											{ orgId: tenant.orgId, ...window },
										),
										"ciWorkflowRuns",
									)
								: []
							return pipelineOf(row, CH.ciRedStreak(runs))
						}),
					{ concurrency: STREAK_CONCURRENCY },
				)

				const series = fillSeries(seriesRows)
				return new CodeReviewCiAnalytics({
					startTime,
					endTime,
					bucketSeconds,
					current,
					previous,
					series,
					pipelines,
					jobs: jobRows.map(
						(row) =>
							new CodeReviewCiJob({
								...row,
								p50DurationMs: row.p50DurationMs ?? 0,
								p95DurationMs: row.p95DurationMs ?? 0,
								p50QueueMs: row.p50QueueMs ?? 0,
								p95QueueMs: row.p95QueueMs ?? 0,
							}),
					),
				})
			})

			const listRuns = Effect.fn("CiAnalyticsService.listRuns")(function* (
				tenant: TenantContext,
				query: CodeReviewCiRunsQuery,
			) {
				const { startTime, endTime } = ciWindow(query)
				const limit = query.limit ?? DEFAULT_PAGE
				yield* Effect.annotateCurrentSpan({
					orgId: tenant.orgId,
					"maple.ci.window_ms": endTime - startTime,
				})
				const scope = yield* resolveScope(tenant.orgId, query)
				if (scope === undefined) return new CodeReviewCiRunsResponse({ runs: [], nextCursor: null })

				const before = query.cursor === undefined ? undefined : decodeCursor(query.cursor)
				const window = {
					startTime: formatWarehouseDateTime(startTime),
					endTime: formatWarehouseDateTime(endTime),
				}
				const rows = yield* read(
					tenant,
					CH.compile(
						CH.ciRunsQuery({
							...scope,
							branch: query.branch,
							result: query.result,
							pullRequest: query.pullRequest,
							before,
							limit: limit + 1,
						}),
						before === undefined
							? { orgId: tenant.orgId, ...window }
							: {
									orgId: tenant.orgId,
									...window,
									beforeStartedAt: before.startedAt,
									beforeTraceId: before.traceId,
								},
					),
					"ciRuns",
				)
				const page = rows.slice(0, limit)
				const failed = page.filter((run) => CH.isCiFailedResult(run.result))
				const failedIds = failed.map((run) => run.traceId)
				// Jobs are queued after their run starts and can outlast the window: read over the runs' span.
				const span = CH.ciRunsSpanMs(failed)
				const failedJobs =
					span === undefined
						? []
						: yield* read(
								tenant,
								CH.compile(
									CH.ciFailedJobsQuery({
										traceIds: failedIds,
										limit: failedIds.length * FAILED_JOBS_PER_RUN,
									}),
									{
										orgId: tenant.orgId,
										startTime: formatWarehouseDateTime(span.startMs),
										endTime: formatWarehouseDateTime(span.endMs),
									},
								),
								"ciFailedJobs",
							)
				const jobsByTrace = Arr.groupBy(failedJobs, (job) => job.traceId)
				const last = page[page.length - 1]

				return new CodeReviewCiRunsResponse({
					runs: page.map(
						(run) =>
							new CodeReviewCiRun({
								traceId: run.traceId,
								pipeline: run.pipeline,
								repository: run.repository,
								branch: run.branch,
								revision: run.revision,
								runId: run.runId,
								// 0 when the span carried none: an attempt counts from 1, and no run is pull request 0.
								attempt: Math.max(run.attempt, 1),
								trigger: run.trigger,
								actor: run.actor,
								pullRequest: run.pullRequest === 0 ? null : run.pullRequest,
								result: run.result,
								durationMs: run.durationMs,
								startedAt: DateTime.toEpochMillis(run.startedAt),
								url: run.url,
								failedJobs: (jobsByTrace[run.traceId] ?? []).map(
									(job) =>
										new CodeReviewCiFailedJob({
											job: job.job,
											reason: job.reason,
											url: job.url,
										}),
								),
							}),
					),
					nextCursor:
						rows.length > limit && last !== undefined
							? encodeCursor(DateTime.toEpochMillis(last.startedAt), last.traceId)
							: null,
				})
			})

			return { analytics, listRuns } satisfies CiAnalyticsServiceApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(WarehouseQueryService.layer))
}
