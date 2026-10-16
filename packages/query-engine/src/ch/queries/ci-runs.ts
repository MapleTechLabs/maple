// CI pipeline runs
//
// GitHub Actions runs land as traces under `service.name = github-actions` (CiTraceService): one
// root SERVER span per workflow run carrying the `cicd.pipeline.*` attributes, one child per job,
// and step / runner-wait spans under each job. A failed job carries `maple.cicd.failure.reason`
// from its annotations. Both queries read raw `traces`, scoped to that one service.

import { DateTime } from "effect"
import * as CH from "@maple-dev/effect-orm/expr"
import { from, param, type ColumnAccessor } from "@maple-dev/effect-orm/clickhouse"
import { Traces, orgIdParam, utcSecondsParam } from "../tables"
import { timeseriesBucket } from "./query-helpers"

export const CI_TRACES_SERVICE_NAME = "github-actions"

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

export interface CiRunsOutput {
	readonly traceId: string
	readonly pipeline: string
	readonly runId: string
	readonly result: string
	readonly url: string
	readonly repository: string
	readonly branch: string
	readonly revision: string
	readonly attempt: string
	readonly trigger: string
	readonly actor: string
	readonly pullRequest: string
	readonly durationMs: number
	readonly startedAt: DateTime.Utc
}

/** Workflow runs, newest first: the root span of each CI trace. */
export function ciRunsQuery(opts: CiRunsOpts) {
	return from(Traces)
		.select(($) => ({
			traceId: $.TraceId,
			pipeline: $.SpanAttributes.get("cicd.pipeline.name"),
			runId: $.SpanAttributes.get("cicd.pipeline.run.id"),
			result: $.SpanAttributes.get("cicd.pipeline.result"),
			url: $.SpanAttributes.get("cicd.pipeline.run.url.full"),
			repository: $.ResourceAttributes.get("vcs.repository.name"),
			branch: $.SpanAttributes.get("vcs.ref.head.name"),
			revision: $.SpanAttributes.get("vcs.ref.head.revision"),
			attempt: $.SpanAttributes.get("maple.cicd.run_attempt"),
			trigger: $.SpanAttributes.get("maple.cicd.trigger_event"),
			actor: $.SpanAttributes.get("maple.cicd.actor"),
			pullRequest: $.SpanAttributes.get("vcs.change.id"),
			durationMs: $.Duration.div(1000000),
			startedAt: $.Timestamp,
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.Timestamp.gte(utcSecondsParam("startTime")),
			$.Timestamp.lte(utcSecondsParam("endTime")),
			$.ServiceName.eq(CI_TRACES_SERVICE_NAME),
			$.ParentSpanId.eq(""),
			CH.when(opts.pipeline, (v: string) => $.SpanAttributes.get("cicd.pipeline.name").eq(v)),
			CH.when(opts.repository, (v: string) => $.ResourceAttributes.get("vcs.repository.name").eq(v)),
			CH.when(opts.branch, (v: string) => $.SpanAttributes.get("vcs.ref.head.name").eq(v)),
			CH.when(opts.result, (v: string) => $.SpanAttributes.get("cicd.pipeline.result").eq(v)),
			CH.when(opts.owner, (v: string) => $.ResourceAttributes.get("vcs.owner.name").eq(v)),
			CH.whenTrue(opts.ranOnly === true, () =>
				$.SpanAttributes.get("cicd.pipeline.result").neq("skip"),
			),
			CH.when(opts.pullRequest, (v: number) => $.SpanAttributes.get("vcs.change.id").eq(String(v))),
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

export interface CiFailedJobsOutput {
	readonly traceId: string
	readonly job: string
	readonly result: string
	readonly reason: string
	readonly url: string
	readonly durationMs: number
}

/**
 * Failed jobs of the given runs, with the failure reason their annotations gave. Jobs are the run
 * span's children that name a task but not a step.
 */
export function ciFailedJobsQuery(opts: CiFailedJobsOpts) {
	return from(Traces)
		.select(($) => ({
			traceId: $.TraceId,
			job: $.SpanAttributes.get("cicd.pipeline.task.name"),
			result: $.SpanAttributes.get("cicd.pipeline.task.run.result"),
			reason: $.SpanAttributes.get("maple.cicd.failure.reason"),
			url: $.SpanAttributes.get("cicd.pipeline.task.run.url.full"),
			durationMs: $.Duration.div(1000000),
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.Timestamp.gte(utcSecondsParam("startTime")),
			$.Timestamp.lte(utcSecondsParam("endTime")),
			$.ServiceName.eq(CI_TRACES_SERVICE_NAME),
			CH.inList($.TraceId, opts.traceIds),
			$.StatusCode.eq("Error"),
			$.SpanAttributes.get("cicd.pipeline.task.name").neq(""),
			$.SpanAttributes.get("maple.cicd.step.number").eq(""),
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

type TraceColumns = ColumnAccessor<typeof Traces.columns>

const ciScope = ($: TraceColumns, opts: CiScopeOpts) => [
	$.OrgId.eq(orgIdParam),
	$.Timestamp.gte(utcSecondsParam("startTime")),
	$.Timestamp.lte(utcSecondsParam("endTime")),
	$.ServiceName.eq(CI_TRACES_SERVICE_NAME),
	CH.when(opts.owner, (v: string) => $.ResourceAttributes.get("vcs.owner.name").eq(v)),
	CH.when(opts.repository, (v: string) => $.ResourceAttributes.get("vcs.repository.name").eq(v)),
	CH.when(opts.pipeline, (v: string) => $.SpanAttributes.get("cicd.pipeline.name").eq(v)),
]

/** Run spans that did something: a skipped run takes a second and would drag every percentile down. */
const ranRuns = ($: TraceColumns, opts: CiScopeOpts) => [
	...ciScope($, opts),
	$.ParentSpanId.eq(""),
	$.SpanAttributes.get("cicd.pipeline.result").neq("skip"),
]

/**
 * Job spans that ran: the run's children that name a task but not a step. A job skipped, or
 * cancelled before a runner took it (a zero-length span), never ran.
 */
const ranJobs = ($: TraceColumns, opts: CiScopeOpts) => [
	...ciScope($, opts),
	$.SpanAttributes.get("cicd.pipeline.task.name").neq(""),
	$.SpanAttributes.get("maple.cicd.step.number").eq(""),
	$.SpanAttributes.get("cicd.pipeline.task.run.result").neq("skip"),
	$.Duration.gt(0),
]

const runAggregates = ($: TraceColumns) => {
	const result = $.SpanAttributes.get("cicd.pipeline.result")
	return {
		runs: CH.count(),
		succeeded: CH.countIf(result.eq("success")),
		failed: CH.countIf(CH.inList(result, CI_FAILED_RESULTS)),
		cancelled: CH.countIf(result.eq("cancellation")),
		p50DurationMs: CH.quantile(0.5)($.Duration).div(1000000),
		p95DurationMs: CH.quantile(0.95)($.Duration).div(1000000),
		totalDurationMs: CH.sum($.Duration).div(1000000),
	}
}

/** Run counts and durations over the whole window. */
export function ciRunTotalsQuery(opts: CiScopeOpts) {
	return from(Traces)
		.select(($) => runAggregates($))
		.where(($) => ranRuns($, opts))
		.format("JSON")
}

/** Run counts and durations per `bucketSeconds` bucket; empty buckets are absent. */
export function ciRunSeriesQuery(opts: CiScopeOpts) {
	return from(Traces)
		.select(($) => ({ bucket: timeseriesBucket($.Timestamp, false), ...runAggregates($) }))
		.where(($) => ranRuns($, opts))
		.groupBy("bucket")
		.orderBy(["bucket", "asc"])
		.format("JSON")
}

/** Per repository and workflow: run counts, durations and the latest run's result. */
export function ciPipelineStatsQuery(opts: CiScopeOpts & { readonly limit?: number }) {
	return from(Traces)
		.select(($) => ({
			owner: $.ResourceAttributes.get("vcs.owner.name"),
			repository: $.ResourceAttributes.get("vcs.repository.name"),
			pipeline: $.SpanAttributes.get("cicd.pipeline.name"),
			...runAggregates($),
			lastResult: CH.argMax($.SpanAttributes.get("cicd.pipeline.result"), $.Timestamp),
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
	return from(Traces)
		.select(($) => {
			const result = $.SpanAttributes.get("cicd.pipeline.task.run.result")
			const queueMs = CH.toFloat64OrZero($.SpanAttributes.get("maple.cicd.queue_duration_ms"))
			return {
				owner: $.ResourceAttributes.get("vcs.owner.name"),
				repository: $.ResourceAttributes.get("vcs.repository.name"),
				pipeline: $.SpanAttributes.get("cicd.pipeline.name"),
				job: $.SpanAttributes.get("cicd.pipeline.task.name"),
				runs: CH.count(),
				failed: CH.countIf(CH.inList(result, CI_FAILED_RESULTS)),
				retried: CH.countIf($.SpanAttributes.get("maple.cicd.run_attempt").neq("1")),
				p50DurationMs: CH.quantile(0.5)($.Duration).div(1000000),
				p95DurationMs: CH.quantile(0.95)($.Duration).div(1000000),
				totalDurationMs: CH.sum($.Duration).div(1000000),
				p50QueueMs: CH.quantile(0.5)(queueMs),
				p95QueueMs: CH.quantile(0.95)(queueMs),
			}
		})
		.where(($) => ranJobs($, opts))
		.groupBy("owner", "repository", "pipeline", "job")
		.orderBy(["totalDurationMs", "desc"])
		.limit(opts.limit ?? 50)
		.format("JSON")
}

/** How long jobs waited for a runner over the whole window. */
export function ciQueueTotalsQuery(opts: CiScopeOpts) {
	return from(Traces)
		.select(($) => {
			const queueMs = CH.toFloat64OrZero($.SpanAttributes.get("maple.cicd.queue_duration_ms"))
			return {
				jobs: CH.count(),
				p50QueueMs: CH.quantile(0.5)(queueMs),
				p95QueueMs: CH.quantile(0.95)(queueMs),
			}
		})
		.where(($) => ranJobs($, opts))
		.format("JSON")
}
