import type { BackfillSpec } from "../backfill"

/**
 * Migration 0047: `ci_runs` and `ci_jobs`, the CI analytics' filtered projections of
 * `github-actions` traces. Reading the run and job attributes off raw `traces` scanned every
 * step span's Map columns; these keep one row per run and per job, for a year.
 *
 * The views go first, then the retained raw history is backfilled. Nothing is emptied first: a
 * replay must keep the rows older than raw retention, so the backfill skips every span its target
 * already holds, which also covers spans the views write meanwhile. `requiredForIngest: false`.
 *
 * The CREATE statements are the verbatim DDL the schema emitter produced at v47.
 * Frozen history: never re-derive it from a later snapshot.
 */
const CI_RUNS_PROJECTION_SQL =
	"          OrgId,\n          Timestamp,\n          TraceId,\n          SpanId,\n          ResourceAttributes['vcs.owner.name'] AS Owner,\n          ResourceAttributes['vcs.repository.name'] AS Repository,\n          SpanAttributes['cicd.pipeline.name'] AS Pipeline,\n          SpanAttributes['cicd.pipeline.run.id'] AS RunId,\n          toUInt64OrZero(SpanAttributes['maple.cicd.run_number']) AS RunNumber,\n          toUInt16OrZero(SpanAttributes['maple.cicd.run_attempt']) AS Attempt,\n          SpanAttributes['cicd.pipeline.result'] AS Result,\n          Duration,\n          SpanAttributes['cicd.pipeline.run.url.full'] AS Url,\n          SpanAttributes['vcs.ref.head.name'] AS Branch,\n          SpanAttributes['vcs.ref.head.revision'] AS Revision,\n          SpanAttributes['maple.cicd.trigger_event'] AS TriggerEvent,\n          SpanAttributes['maple.cicd.actor'] AS Actor,\n          toUInt32OrZero(SpanAttributes['vcs.change.id']) AS PullRequest,\n          SpanAttributes['maple.cicd.workflow_path'] AS WorkflowPath"
const CI_RUNS_FILTER = "ServiceName = 'github-actions'\n          AND ParentSpanId = ''"
const CI_JOBS_PROJECTION_SQL =
	"          OrgId,\n          Timestamp,\n          TraceId,\n          SpanId,\n          ResourceAttributes['vcs.owner.name'] AS Owner,\n          ResourceAttributes['vcs.repository.name'] AS Repository,\n          SpanAttributes['cicd.pipeline.name'] AS Pipeline,\n          SpanAttributes['cicd.pipeline.run.id'] AS RunId,\n          toUInt16OrZero(SpanAttributes['maple.cicd.run_attempt']) AS Attempt,\n          SpanAttributes['cicd.pipeline.task.name'] AS Job,\n          SpanAttributes['cicd.pipeline.task.run.result'] AS Result,\n          StatusCode,\n          Duration,\n          toUInt32OrZero(SpanAttributes['maple.cicd.queue_duration_ms']) AS QueueMs,\n          SpanAttributes['cicd.pipeline.task.run.url.full'] AS Url,\n          SpanAttributes['maple.cicd.failure.reason'] AS FailureReason,\n          SpanAttributes['cicd.worker.name'] AS RunnerName,\n          SpanAttributes['maple.cicd.runner_labels'] AS RunnerLabels"
const CI_JOBS_FILTER =
	"ServiceName = 'github-actions'\n          AND ParentSpanId != ''\n          AND SpanAttributes['cicd.pipeline.task.name'] != ''\n          AND SpanAttributes['maple.cicd.step.number'] = ''"

/** Unqualified like the ALTERs: both apply paths set the session database. */
const notYetIn = (target: string) => `(TraceId, SpanId) NOT IN (SELECT TraceId, SpanId FROM ${target})`

const ciRunsBackfill: BackfillSpec = {
	kind: "backfill",
	target: "ci_runs",
	columns: [
		"OrgId",
		"Timestamp",
		"TraceId",
		"SpanId",
		"Owner",
		"Repository",
		"Pipeline",
		"RunId",
		"RunNumber",
		"Attempt",
		"Result",
		"Duration",
		"Url",
		"Branch",
		"Revision",
		"TriggerEvent",
		"Actor",
		"PullRequest",
		"WorkflowPath",
	],
	from: "traces",
	tsColumn: "Timestamp",
	select: CI_RUNS_PROJECTION_SQL,
	where: `${CI_RUNS_FILTER} AND ${notYetIn("ci_runs")}`,
}

const ciJobsBackfill: BackfillSpec = {
	kind: "backfill",
	target: "ci_jobs",
	columns: [
		"OrgId",
		"Timestamp",
		"TraceId",
		"SpanId",
		"Owner",
		"Repository",
		"Pipeline",
		"RunId",
		"Attempt",
		"Job",
		"Result",
		"StatusCode",
		"Duration",
		"QueueMs",
		"Url",
		"FailureReason",
		"RunnerName",
		"RunnerLabels",
	],
	from: "traces",
	tsColumn: "Timestamp",
	select: CI_JOBS_PROJECTION_SQL,
	where: `${CI_JOBS_FILTER} AND ${notYetIn("ci_jobs")}`,
}

export const migration_0047_ci_runs_jobs = {
	version: 47,
	description:
		"Create ci_runs + ci_jobs and their views: CI runs and jobs off github-actions traces, backfilled",
	requiredForIngest: false,
	statements: [
		"CREATE TABLE IF NOT EXISTS ci_runs (\n    OrgId LowCardinality(String),\n    Timestamp DateTime64(9),\n    TraceId String,\n    SpanId String,\n    Owner LowCardinality(String),\n    Repository LowCardinality(String),\n    Pipeline LowCardinality(String),\n    RunId String,\n    RunNumber UInt64,\n    Attempt UInt16,\n    Result LowCardinality(String),\n    Duration UInt64,\n    Url String,\n    Branch String,\n    Revision String,\n    TriggerEvent LowCardinality(String),\n    Actor LowCardinality(String),\n    PullRequest UInt32,\n    WorkflowPath LowCardinality(String)\n)\nENGINE = MergeTree\nPARTITION BY toYYYYMM(Timestamp)\nORDER BY (OrgId, Timestamp, TraceId)\nTTL toDate(Timestamp) + INTERVAL 365 DAY",
		"CREATE TABLE IF NOT EXISTS ci_jobs (\n    OrgId LowCardinality(String),\n    Timestamp DateTime64(9),\n    TraceId String,\n    SpanId String,\n    Owner LowCardinality(String),\n    Repository LowCardinality(String),\n    Pipeline LowCardinality(String),\n    RunId String,\n    Attempt UInt16,\n    Job LowCardinality(String),\n    Result LowCardinality(String),\n    StatusCode LowCardinality(String),\n    Duration UInt64,\n    QueueMs UInt32,\n    Url String,\n    FailureReason String,\n    RunnerName LowCardinality(String),\n    RunnerLabels LowCardinality(String)\n)\nENGINE = MergeTree\nPARTITION BY toYYYYMM(Timestamp)\nORDER BY (OrgId, Timestamp, TraceId)\nTTL toDate(Timestamp) + INTERVAL 365 DAY",
		"ALTER TABLE ci_runs MODIFY SETTING ttl_only_drop_parts = 1",
		"ALTER TABLE ci_jobs MODIFY SETTING ttl_only_drop_parts = 1",
		`CREATE MATERIALIZED VIEW IF NOT EXISTS ci_runs_mv TO ci_runs AS\nSELECT\n${CI_RUNS_PROJECTION_SQL}\n        FROM traces\n        WHERE ${CI_RUNS_FILTER}`,
		`CREATE MATERIALIZED VIEW IF NOT EXISTS ci_jobs_mv TO ci_jobs AS\nSELECT\n${CI_JOBS_PROJECTION_SQL}\n        FROM traces\n        WHERE ${CI_JOBS_FILTER}`,
		ciRunsBackfill,
		ciJobsBackfill,
	],
} as const
