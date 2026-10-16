// CI pipeline runs
//
// GitHub Actions runs land as traces under `service.name = github-actions` (CiTraceService): one
// root SERVER span per workflow run carrying the `cicd.pipeline.*` attributes, one child per job,
// and step / runner-wait spans under each job. A failed job carries `maple.cicd.failure.reason`
// from its annotations. Both queries read raw `traces`, scoped to that one service.

import type { DateTime } from "effect"
import * as CH from "@maple-dev/effect-orm/expr"
import { from } from "@maple-dev/effect-orm/clickhouse"
import { Traces, orgIdParam, utcSecondsParam } from "../tables"

export const CI_TRACES_SERVICE_NAME = "github-actions"

export interface CiRunsOpts {
	/** Exact `cicd.pipeline.name` (the workflow name). */
	readonly pipeline?: string
	/** Exact repository name, without the owner (`vcs.repository.name`). */
	readonly repository?: string
	/** Exact head branch (`vcs.ref.head.name`). */
	readonly branch?: string
	/** `cicd.pipeline.result`: success, failure, timeout, cancellation, skip, error. */
	readonly result?: string
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
		])
		.orderBy(["startedAt", "desc"])
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
