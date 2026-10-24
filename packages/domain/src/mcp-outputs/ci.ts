/** Output schemas for the CI and commit MCP tools. */
import { Schema } from "effect"
import { OutputTimeRange } from "./shared"

// ---------------------------------------------------------------------------------------------
// ci_runs

export const CiFailedJobRow = Schema.Struct({
	job: Schema.String,
	result: Schema.String,
	/** The failure the job's annotations gave; empty when GitHub reported none. */
	reason: Schema.String,
	url: Schema.String,
})

export const CiRunRow = Schema.Struct({
	pipeline: Schema.String,
	repository: Schema.String,
	branch: Schema.String,
	revision: Schema.String,
	runId: Schema.String,
	attempt: Schema.Number,
	trigger: Schema.String,
	/** `cicd.pipeline.result`: success, failure, timeout, cancellation, skip, error. */
	result: Schema.String,
	durationMs: Schema.Number,
	startedAt: Schema.String,
	url: Schema.String,
	traceId: Schema.String,
	failedJobs: Schema.Array(CiFailedJobRow),
})

export const CiPipelineSummaryRow = Schema.Struct({
	pipeline: Schema.String,
	repository: Schema.String,
	runs: Schema.Number,
	failed: Schema.Number,
	p50DurationMs: Schema.Number,
	p95DurationMs: Schema.Number,
	lastResult: Schema.String,
	lastStartedAt: Schema.String,
	/**
	 * Set while the workflow is red: the newest runs failed in a row. `firstFailedRevision` is the
	 * commit the streak started on, `lastGreenRevision` the newest passing commit before it (absent
	 * when the window holds none). Full SHAs, for compare_commits.
	 */
	red: Schema.optionalKey(
		Schema.Struct({
			failedRuns: Schema.Number,
			since: Schema.String,
			firstFailedRevision: Schema.String,
			lastGreenRevision: Schema.optionalKey(Schema.String),
			lastGreenAt: Schema.optionalKey(Schema.String),
		}),
	),
})

export const CiRunsOutput = Schema.Struct({
	timeRange: OutputTimeRange,
	filters: Schema.Struct({
		pipeline: Schema.optionalKey(Schema.String),
		repository: Schema.optionalKey(Schema.String),
		branch: Schema.optionalKey(Schema.String),
		result: Schema.optionalKey(Schema.String),
	}),
	/** Per workflow, over every run read (up to the summary cap), not only the listed ones. */
	pipelines: Schema.Array(CiPipelineSummaryRow),
	runs: Schema.Array(CiRunRow),
	/** Runs read for the summary; when it hits the cap, older runs are not counted. */
	runsRead: Schema.Number,
	/** Runs read that pass the `result` filter, of which `runs` lists the newest `limit`. */
	runsMatched: Schema.Number,
	summaryCapped: Schema.Boolean,
	/** The failed-jobs read hit its cap, so some failed runs may list fewer jobs than failed. */
	failedJobsCapped: Schema.optionalKey(Schema.Boolean),
})

// ---------------------------------------------------------------------------------------------
// compare_commits

export const CommitRow = Schema.Struct({
	sha: Schema.String,
	/** First line of the commit message. */
	title: Schema.String,
	author: Schema.NullOr(Schema.String),
	committedAt: Schema.String,
	url: Schema.String,
})

export const CompareCommitsOutput = Schema.Struct({
	base: Schema.String,
	head: Schema.String,
	/** Where the two ends came from: given, or the service's two newest deployed versions. */
	source: Schema.Literals(["given", "service_deployments"]),
	service: Schema.optionalKey(Schema.String),
	environment: Schema.optionalKey(Schema.String),
	status: Schema.Literals(["resolved", "unavailable"]),
	repository: Schema.String,
	/** Commits after `base` up to and including `head`; a lower bound when `truncated`. */
	totalCount: Schema.Number,
	truncated: Schema.Boolean,
	commits: Schema.Array(CommitRow),
	/** Why the range could not be read, when it could not. */
	reason: Schema.optionalKey(Schema.String),
})
