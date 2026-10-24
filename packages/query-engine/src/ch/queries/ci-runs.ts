// CI pipeline runs
//
// GitHub Actions runs land as traces under `service.name = github-actions` (CiTraceService): one
// root SERVER span per workflow run carrying the `cicd.pipeline.*` attributes, one child per job,
// and step / runner-wait spans under each job. Migration 0047's views keep the runs in `ci_runs`
// and the jobs in `ci_jobs` with those attributes as columns; every read here goes to them.

import { DateTime } from "effect"
import * as CH from "@maple-dev/effect-orm/expr"
import { from, param, type ColumnAccessor } from "@maple-dev/effect-orm/clickhouse"
import { CiJobs, CiRuns, orgIdParam, utcSecondsParam } from "../tables"
import { timeseriesBucket } from "./query-helpers"

/** `cicd.pipeline.result` values that mean the run broke, as opposed to being cancelled or skipped. */
export const CI_FAILED_RESULTS = ["failure", "timeout", "error"] as const

export interface CiRunsOpts {
	/** Exact `cicd.pipeline.name` (the workflow name). */
	readonly pipeline?: string
	/** Exact repository name, without the owner (`vcs.repository.name`). */
	readonly repository?: string
	/** Exact head branch (`vcs.ref.head.name`). */
	readonly branch?: string
	/** `cicd.pipeline.result`: success, failure, timeout, cancellation, skip, error. */
	readonly result?: string
	/** Repository owner (`vcs.owner.name`), to tell same-named repositories apart. */
	readonly owner?: string
	/** Pull request number (`vcs.change.id`). */
	readonly pullRequest?: number
	/** Leave out skipped runs, which did nothing. */
	readonly ranOnly?: boolean
	/** Keyset cursor: only runs that sort after this one, newest first. */
	readonly before?: { readonly startedAt: DateTime.Utc; readonly traceId: string }
	readonly limit?: number
}

/** Workflow runs, newest first. `pullRequest` is 0 for a run without one. */
export function ciRunsQuery(opts: CiRunsOpts) {
	return from(CiRuns)
		.select(($) => ({
			traceId: $.TraceId,
			pipeline: $.Pipeline,
			runId: $.RunId,
			result: $.Result,
			url: $.Url,
			repository: $.Repository,
			branch: $.Branch,
			revision: $.Revision,
			attempt: $.Attempt,
			trigger: $.TriggerEvent,
			actor: $.Actor,
			pullRequest: $.PullRequest,
			durationMs: $.Duration.div(1000000),
			startedAt: $.Timestamp,
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.Timestamp.gte(utcSecondsParam("startTime")),
			$.Timestamp.lte(utcSecondsParam("endTime")),
			CH.when(opts.pipeline, (v: string) => $.Pipeline.eq(v)),
			CH.when(opts.repository, (v: string) => $.Repository.eq(v)),
			CH.when(opts.branch, (v: string) => $.Branch.eq(v)),
			CH.when(opts.result, (v: string) => $.Result.eq(v)),
			CH.when(opts.owner, (v: string) => $.Owner.eq(v)),
			CH.whenTrue(opts.ranOnly === true, () => $.Result.neq("skip")),
			CH.when(opts.pullRequest, (v: number) => $.PullRequest.eq(v)),
			CH.whenTrue(opts.before !== undefined, () =>
				$.Timestamp.lt(param.dateTime("beforeStartedAt")).or(
					$.Timestamp.eq(param.dateTime("beforeStartedAt")).and(
						$.TraceId.lt(param.string("beforeTraceId")),
					),
				),
			),
		])
		.orderBy(["startedAt", "desc"], ["traceId", "desc"])
		.limit(opts.limit ?? 200)
		.format("JSON")
}

export interface CiFailedJobsOpts {
	/** Only jobs of these runs (their trace ids). */
	readonly traceIds: readonly string[]
	readonly limit?: number
}

/** Failed jobs of the given runs, with the failure reason their annotations gave. */
export function ciFailedJobsQuery(opts: CiFailedJobsOpts) {
	return from(CiJobs)
		.select(($) => ({
			traceId: $.TraceId,
			job: $.Job,
			result: $.Result,
			reason: $.FailureReason,
			url: $.Url,
			durationMs: $.Duration.div(1000000),
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.Timestamp.gte(utcSecondsParam("startTime")),
			$.Timestamp.lte(utcSecondsParam("endTime")),
			CH.inList($.TraceId, opts.traceIds),
			$.StatusCode.eq("Error"),
		])
		.orderBy(["traceId", "asc"])
		.limit(opts.limit ?? 200)
		.format("JSON")
}

const FAILED: ReadonlySet<string> = new Set(CI_FAILED_RESULTS)

/** Whether a `cicd.pipeline.result` means the run or job broke. */
export const isCiFailedResult = (result: string) => FAILED.has(result)

export interface CiRedStreak<R> {
	readonly failedRuns: number
	/** The streak's oldest run: the one that turned the workflow red. */
	readonly firstFailed: R
	readonly lastGreen: R | undefined
}

/**
 * One workflow's failure streak from its runs, newest first; undefined when its latest judged run
 * passed. Cancelled and skipped runs carry no verdict, so they neither extend nor end a streak.
 */
export const ciRedStreak = <R extends { readonly result: string }>(
	runsNewestFirst: ReadonlyArray<R>,
): CiRedStreak<R> | undefined => {
	const judged = runsNewestFirst.filter((run) => run.result === "success" || isCiFailedResult(run.result))
	const greenAt = judged.findIndex((run) => run.result === "success")
	const streak = greenAt === -1 ? judged : judged.slice(0, greenAt)
	const firstFailed = streak[streak.length - 1]
	return firstFailed === undefined
		? undefined
		: { failedRuns: streak.length, firstFailed, lastGreen: greenAt === -1 ? undefined : judged[greenAt] }
}

/**
 * The time span the given runs cover, epoch ms: a run's jobs are queued after it starts and end
 * before it does, so their spans fall inside it even when the runs window ends first.
 */
export const ciRunsSpanMs = (
	runs: ReadonlyArray<{ readonly startedAt: DateTime.Utc; readonly durationMs: number }>,
): { readonly startMs: number; readonly endMs: number } | undefined =>
	runs.length === 0
		? undefined
		: {
				startMs: Math.min(...runs.map((run) => DateTime.toEpochMillis(run.startedAt))),
				// A second past the end: span timestamps keep the milliseconds the run's own end rounds off.
				endMs:
					Math.max(...runs.map((run) => DateTime.toEpochMillis(run.startedAt) + run.durationMs)) +
					1000,
			}

/** What the CI analytics read: one repository and workflow, or every one. */
export interface CiScopeOpts {
	readonly owner?: string
	readonly repository?: string
	readonly pipeline?: string
}

type RunColumns = ColumnAccessor<typeof CiRuns.columns>
type JobColumns = ColumnAccessor<typeof CiJobs.columns>

const ciScope = ($: RunColumns | JobColumns, opts: CiScopeOpts) => [
	$.OrgId.eq(orgIdParam),
	$.Timestamp.gte(utcSecondsParam("startTime")),
	$.Timestamp.lte(utcSecondsParam("endTime")),
	CH.when(opts.owner, (v: string) => $.Owner.eq(v)),
	CH.when(opts.repository, (v: string) => $.Repository.eq(v)),
	CH.when(opts.pipeline, (v: string) => $.Pipeline.eq(v)),
]

/** Runs that did something: a skipped run takes a second and would drag every percentile down. */
const ranRuns = ($: RunColumns, opts: CiScopeOpts) => [...ciScope($, opts), $.Result.neq("skip")]

/** Jobs that ran: a job skipped, or cancelled before a runner took it (zero length), never ran. */
const ranJobs = ($: JobColumns, opts: CiScopeOpts) => [
	...ciScope($, opts),
	$.Result.neq("skip"),
	$.Duration.gt(0),
]

const runAggregates = ($: RunColumns) => ({
	runs: CH.count(),
	succeeded: CH.countIf($.Result.eq("success")),
	failed: CH.countIf(CH.inList($.Result, CI_FAILED_RESULTS)),
	cancelled: CH.countIf($.Result.eq("cancellation")),
	p50DurationMs: CH.quantile(0.5)($.Duration).div(1000000),
	p95DurationMs: CH.quantile(0.95)($.Duration).div(1000000),
	totalDurationMs: CH.sum($.Duration).div(1000000),
})

/** Run counts and durations over the whole window. */
export function ciRunTotalsQuery(opts: CiScopeOpts) {
	return from(CiRuns)
		.select(($) => runAggregates($))
		.where(($) => ranRuns($, opts))
		.format("JSON")
}

/** Run counts and durations per `bucketSeconds` bucket; empty buckets are absent. */
export function ciRunSeriesQuery(opts: CiScopeOpts) {
	return from(CiRuns)
		.select(($) => ({ bucket: timeseriesBucket($.Timestamp, false), ...runAggregates($) }))
		.where(($) => ranRuns($, opts))
		.groupBy("bucket")
		.orderBy(["bucket", "asc"])
		.format("JSON")
}

/** Per repository and workflow: run counts, durations and the latest run's result. */
export function ciPipelineStatsQuery(opts: CiScopeOpts & { readonly limit?: number }) {
	return from(CiRuns)
		.select(($) => ({
			owner: $.Owner,
			repository: $.Repository,
			pipeline: $.Pipeline,
			...runAggregates($),
			lastResult: CH.argMax($.Result, $.Timestamp),
			lastStartedAt: CH.max_($.Timestamp),
		}))
		.where(($) => ranRuns($, opts))
		.groupBy("owner", "repository", "pipeline")
		.orderBy(["runs", "desc"])
		.limit(opts.limit ?? 100)
		.format("JSON")
}

/**
 * Per job: runs, failures, reruns, and where the time went. A job span covers its wait for a
 * runner, so the durations include the queue that `p50QueueMs` and `p95QueueMs` break out.
 */
export function ciJobStatsQuery(opts: CiScopeOpts & { readonly limit?: number }) {
	return from(CiJobs)
		.select(($) => ({
			owner: $.Owner,
			repository: $.Repository,
			pipeline: $.Pipeline,
			job: $.Job,
			runs: CH.count(),
			failed: CH.countIf(CH.inList($.Result, CI_FAILED_RESULTS)),
			// 0 when the span carried no attempt: that is a first run, not a rerun.
			retried: CH.countIf($.Attempt.gt(1)),
			p50DurationMs: CH.quantile(0.5)($.Duration).div(1000000),
			p95DurationMs: CH.quantile(0.95)($.Duration).div(1000000),
			totalDurationMs: CH.sum($.Duration).div(1000000),
			p50QueueMs: CH.quantile(0.5)($.QueueMs),
			p95QueueMs: CH.quantile(0.95)($.QueueMs),
		}))
		.where(($) => ranJobs($, opts))
		.groupBy("owner", "repository", "pipeline", "job")
		.orderBy(["totalDurationMs", "desc"])
		.limit(opts.limit ?? 50)
		.format("JSON")
}

/** How long jobs waited for a runner over the whole window. */
export function ciQueueTotalsQuery(opts: CiScopeOpts) {
	return from(CiJobs)
		.select(($) => ({
			jobs: CH.count(),
			p50QueueMs: CH.quantile(0.5)($.QueueMs),
			p95QueueMs: CH.quantile(0.95)($.QueueMs),
		}))
		.where(($) => ranJobs($, opts))
		.format("JSON")
}
