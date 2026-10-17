import { Array as Arr, DateTime, Effect, Schema } from "effect"
import {
	CodeReviewCiAnalytics,
	CodeReviewCiBucket,
	CodeReviewCiFailedJob,
	CodeReviewCiJob,
	CodeReviewCiPipeline,
	CodeReviewCiRedStreak,
	CodeReviewCiRun,
	CodeReviewCiRunsResponse,
	CodeReviewCiTotals,
} from "@maple/domain/http"
import { CH, formatWarehouseDateTime } from "@maple/query-engine"
import type { CompiledQueryInput, ExecutionTenant } from "@maple/query-engine/execution"
import { parityOrgId, type FixtureWarehouse } from "../../backend/warehouse.ts"
import type { EndpointHandler } from "../dataset.ts"
import { CI_OWNER } from "./code-review-ci.ts"
import { CODE_REVIEW_ORG_ID, repoNameOf } from "./code-review-records.ts"

/**
 * `CiAnalyticsService` (packages/backend/src/services/pr-review) over the fixture warehouse: the
 * same CH queries, window cut, bucket fill and red-streak reads. Only the repository lookup is a
 * fixture, in place of its `vcs_repositories` read.
 */

const HOUR = 3_600
const DAY = 86_400
const CI_MAX_SPAN_MS = 14 * DAY * 1000
const STREAK_RUNS = 200
const STREAK_CANDIDATES = 10
const DEFAULT_PAGE = 50
const FAILED_JOBS_PER_RUN = 50

const ciBucketSeconds = (spanMs: number) => (spanMs <= 2 * DAY * 1000 ? HOUR : 6 * HOUR)
const ciWindow = (query: { readonly startTime: number; readonly endTime: number }) => {
	const startTime = Math.max(query.startTime, query.endTime - CI_MAX_SPAN_MS)
	return { startTime, endTime: Math.max(startTime, query.endTime) }
}
const finiteOrNull = (value: number | null) => (value !== null && Number.isFinite(value) ? value : null)
const attemptOf = (attempt: string) => {
	const parsed = Number(attempt)
	return Number.isInteger(parsed) && parsed > 0 ? parsed : 1
}
const pullRequestOf = (value: string) => {
	const parsed = Number(value)
	return value !== "" && Number.isInteger(parsed) && parsed > 0 ? parsed : null
}
const mayBeRed = (lastResult: string) => CH.isCiFailedResult(lastResult) || lastResult === "cancellation"

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

const CiQuery = Schema.Struct({
	startTime: Schema.Number,
	endTime: Schema.Number,
	repositoryId: Schema.optional(Schema.String),
	pipeline: Schema.optional(Schema.String),
	branch: Schema.optional(Schema.String),
	result: Schema.optional(Schema.String),
	pullRequest: Schema.optional(Schema.Number),
	limit: Schema.optional(Schema.Number),
	cursor: Schema.optional(Schema.String),
})
const decodeQuery = Schema.decodeUnknownEffect(CiQuery)

/** `resolveScope`: the repository id names an owner and repository of this org, else nothing. */
const scopeOf = (orgId: string, query: typeof CiQuery.Type): CH.CiScopeOpts | undefined => {
	const pipeline: CH.CiScopeOpts = query.pipeline === undefined ? {} : { pipeline: query.pipeline }
	if (query.repositoryId === undefined) return pipeline
	const name = orgId === CODE_REVIEW_ORG_ID ? repoNameOf(query.repositoryId) : undefined
	return name === undefined ? undefined : { ...pipeline, owner: CI_OWNER, repository: name }
}

const windowOf = (startTime: number, endTime: number) => ({
	startTime: formatWarehouseDateTime(startTime),
	endTime: formatWarehouseDateTime(endTime),
})

export const codeReviewCiEndpoints = (warehouse: FixtureWarehouse): Readonly<Record<string, EndpointHandler>> => {
	const tenantFor = (orgId: string) => warehouse.tenantOf(parityOrgId(orgId))
	const read = <T>(tenant: ExecutionTenant, compiled: CompiledQueryInput<T>, context: string) =>
		warehouse.executor.compiledQuery(tenant, compiled, { profile: "aggregation", context })

	const totalsOf = (tenant: ExecutionTenant, scope: CH.CiScopeOpts, startTime: number, endTime: number) =>
		Effect.gen(function* () {
			const window = windowOf(startTime, endTime)
			const [runs, queue] = yield* Effect.all(
				[
					read(tenant, CH.compile(CH.ciRunTotalsQuery(scope), { orgId: tenant.orgId, ...window }), "ciRunTotals"),
					read(tenant, CH.compile(CH.ciQueueTotalsQuery(scope), { orgId: tenant.orgId, ...window }), "ciQueueTotals"),
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

	const analytics: EndpointHandler = ({ dataset, query: raw }) =>
		Effect.gen(function* () {
			const query = yield* decodeQuery(raw)
			const orgId = dataset.identity?.orgId ?? "org_parity_signed_out"
			const tenant = tenantFor(orgId)
			const { startTime, endTime } = ciWindow(query)
			const spanMs = endTime - startTime
			const bucketSeconds = ciBucketSeconds(spanMs)
			const bucketMs = bucketSeconds * 1000
			const first = Math.floor(startTime / bucketMs) * bucketMs
			const fillSeries = (
				rows: ReadonlyArray<{ readonly bucket: DateTime.Utc; readonly succeeded: number; readonly failed: number; readonly cancelled: number; readonly p50DurationMs: number | null; readonly p95DurationMs: number | null }>,
			) => {
				const bySlot = new Map(rows.map((row) => [DateTime.toEpochMillis(row.bucket), row]))
				return Array.from({ length: Math.max(0, Math.ceil((endTime - first) / bucketMs)) }, (_, i) => {
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
				})
			}
			const scope = scopeOf(orgId, query)
			const empty = new CodeReviewCiAnalytics({
				startTime,
				endTime,
				bucketSeconds,
				current: emptyTotals,
				previous: emptyTotals,
				series: fillSeries([]),
				pipelines: [],
				jobs: [],
			})
			if (scope === undefined) return yield* Schema.encodeUnknownEffect(CodeReviewCiAnalytics)(empty)
			const window = windowOf(startTime, endTime)
			const [current, previous, seriesRows, pipelineRows, jobRows] = yield* Effect.all(
				[
					totalsOf(tenant, scope, startTime, endTime),
					totalsOf(tenant, scope, startTime - spanMs, startTime),
					read(tenant, CH.compile(CH.ciRunSeriesQuery(scope), { orgId: tenant.orgId, ...window, bucketSeconds }), "ciRunSeries"),
					read(tenant, CH.compile(CH.ciPipelineStatsQuery(scope), { orgId: tenant.orgId, ...window }), "ciPipelineStats"),
					read(tenant, CH.compile(CH.ciJobStatsQuery(scope), { orgId: tenant.orgId, ...window }), "ciJobStats"),
				],
				{ concurrency: "unbounded" },
			)
			const candidates = new Set(pipelineRows.filter((row) => mayBeRed(row.lastResult)).slice(0, STREAK_CANDIDATES))
			const pipelines = yield* Effect.forEach(pipelineRows, (row) =>
				Effect.gen(function* () {
					const runs = candidates.has(row)
						? yield* read(
								tenant,
								CH.compile(
									CH.ciRunsQuery({ owner: row.owner, repository: row.repository, pipeline: row.pipeline, ranOnly: true, limit: STREAK_RUNS }),
									{ orgId: tenant.orgId, ...window },
								),
								"ciWorkflowRuns",
							)
						: []
					const streak = CH.ciRedStreak(runs)
					return new CodeReviewCiPipeline({
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
										lastGreenAt: streak.lastGreen === undefined ? null : DateTime.toEpochMillis(streak.lastGreen.startedAt),
									}),
					})
				}),
			)
			return yield* Schema.encodeUnknownEffect(CodeReviewCiAnalytics)(
				new CodeReviewCiAnalytics({
					startTime,
					endTime,
					bucketSeconds,
					current,
					previous,
					series: fillSeries(seriesRows),
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
				}),
			)
		})

	const runs: EndpointHandler = ({ dataset, query: raw }) =>
		Effect.gen(function* () {
			const query = yield* decodeQuery(raw)
			const orgId = dataset.identity?.orgId ?? "org_parity_signed_out"
			const tenant = tenantFor(orgId)
			const { startTime, endTime } = ciWindow(query)
			const limit = query.limit ?? DEFAULT_PAGE
			const scope = scopeOf(orgId, query)
			const encode = Schema.encodeUnknownEffect(CodeReviewCiRunsResponse)
			if (scope === undefined) return yield* encode(new CodeReviewCiRunsResponse({ runs: [], nextCursor: null }))
			// The fixture pages fit in one read, so the keyset cursor is never followed.
			const rows = yield* read(
				tenant,
				CH.compile(
					CH.ciRunsQuery({ ...scope, branch: query.branch, result: query.result, pullRequest: query.pullRequest, limit: limit + 1 }),
					{ orgId: tenant.orgId, ...windowOf(startTime, endTime) },
				),
				"ciRuns",
			)
			const page = rows.slice(0, limit)
			const failed = page.filter((run) => CH.isCiFailedResult(run.result))
			const failedIds = failed.map((run) => run.traceId)
			const span = CH.ciRunsSpanMs(failed)
			const failedJobs =
				span === undefined
					? []
					: yield* read(
							tenant,
							CH.compile(CH.ciFailedJobsQuery({ traceIds: failedIds, limit: failedIds.length * FAILED_JOBS_PER_RUN }), {
								orgId: tenant.orgId,
								...windowOf(span.startMs, span.endMs),
							}),
							"ciFailedJobs",
						)
			const jobsByTrace = Arr.groupBy(failedJobs, (job) => job.traceId)
			const last = page[page.length - 1]
			return yield* encode(
				new CodeReviewCiRunsResponse({
					runs: page.map(
						(run) =>
							new CodeReviewCiRun({
								traceId: run.traceId,
								pipeline: run.pipeline,
								repository: run.repository,
								branch: run.branch,
								revision: run.revision,
								runId: run.runId,
								attempt: attemptOf(run.attempt),
								trigger: run.trigger,
								actor: run.actor,
								pullRequest: pullRequestOf(run.pullRequest),
								result: run.result,
								durationMs: run.durationMs,
								startedAt: DateTime.toEpochMillis(run.startedAt),
								url: run.url,
								failedJobs: (jobsByTrace[run.traceId] ?? []).map(
									(job) => new CodeReviewCiFailedJob({ job: job.job, reason: job.reason, url: job.url }),
								),
							}),
					),
					nextCursor:
						rows.length > limit && last !== undefined ? `${DateTime.toEpochMillis(last.startedAt)}_${last.traceId}` : null,
				}),
			)
		})

	return { "codeReview.ciAnalytics": analytics, "codeReview.ciRuns": runs }
}
