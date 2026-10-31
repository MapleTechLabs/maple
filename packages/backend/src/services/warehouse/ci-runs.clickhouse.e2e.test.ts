// SAFETY-FILE: JSON in this test is emitted by ClickHouse before its fields are asserted.
// CiTraceService-shaped spans on the real migration chain must land in `ci_runs` / `ci_jobs`
// exactly, 0047's backfill must never double or drop a row, and the CI queries must read them.

import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest"
import { isBackfill, migrations, renderStatementFull } from "@maple/domain/clickhouse"
import * as CH from "@maple/query-engine/ch"
import { DateTime } from "effect"
import {
	applyRealMigrations,
	clickhouseE2eEnabled,
	clickhouseExec,
	uniqueDatabase,
} from "./clickhouse-e2e-support"

const database = uniqueDatabase("maple_ci_runs_e2e")
const ORG_ID = "org_ci_runs_e2e"
const READS_ORG_ID = "org_ci_reads_e2e"

// Anchored to now: `traces` carries a 30-day TTL enforced at insert.
const BASE_MS = Date.now() - 2 * 3_600_000
const chDateTime = (epochMs: number): string => new Date(epochMs).toISOString().replace("T", " ").slice(0, 19)

const REPO = "map('service.name', 'github-actions', 'vcs.owner.name', 'acme', 'vcs.repository.name', 'api')"

interface SeedSpan {
	readonly traceId: string
	readonly spanId: string
	readonly parentSpanId: string
	readonly name: string
	readonly service?: string
	readonly durationNs: number
	readonly status?: string
	readonly attributes: Record<string, string>
}

const run = (traceId: string, result: string, extra: Record<string, string> = {}): SeedSpan => ({
	traceId,
	spanId: `run-${traceId}`,
	parentSpanId: "",
	name: "RUN CI",
	durationNs: 120_000_000_000,
	attributes: {
		"cicd.pipeline.name": "CI",
		"cicd.pipeline.run.id": `9${traceId.length}`,
		"cicd.pipeline.result": result,
		"cicd.pipeline.run.url.full": `https://github.com/acme/api/actions/runs/${traceId}`,
		"maple.cicd.run_attempt": "1",
		"maple.cicd.run_number": "42",
		"maple.cicd.trigger_event": "pull_request",
		"maple.cicd.actor": "octocat",
		"maple.cicd.workflow_path": ".github/workflows/ci.yml",
		"vcs.change.id": "17",
		"vcs.ref.head.name": "feat/x",
		"vcs.ref.head.revision": "abc123",
		...extra,
	},
})

const job = (
	traceId: string,
	name: string,
	result: string,
	extra: Record<string, string> = {},
): SeedSpan => ({
	traceId,
	spanId: `job-${traceId}-${name}`,
	parentSpanId: `run-${traceId}`,
	name,
	durationNs: 60_000_000_000,
	status: result === "failure" ? "Error" : "Unset",
	attributes: {
		"cicd.pipeline.name": "CI",
		"cicd.pipeline.task.name": name,
		"cicd.pipeline.task.run.result": result,
		"cicd.pipeline.task.run.url.full": `https://github.com/acme/api/actions/runs/${traceId}/job/1`,
		"cicd.worker.name": "GitHub Actions 7",
		"maple.cicd.queue_duration_ms": "3000",
		"maple.cicd.run_attempt": "1",
		"maple.cicd.runner_labels": "ubuntu-latest",
		...extra,
	},
})

const SPANS: ReadonlyArray<SeedSpan> = [
	run("t1", "failure"),
	job("t1", "lint", "success"),
	job("t1", "test", "failure", { "maple.cicd.failure.reason": "Process completed with exit code 1." }),
	// A step and a runner wait sit under a job: neither is a job.
	{
		traceId: "t1",
		spanId: "step-t1-1",
		parentSpanId: "job-t1-test",
		name: "Run tests",
		durationNs: 1_000_000_000,
		attributes: { "cicd.pipeline.task.name": "Run tests", "maple.cicd.step.number": "3" },
	},
	{
		traceId: "t1",
		spanId: "wait-t1",
		parentSpanId: "job-t1-test",
		name: "Waiting for a runner",
		durationNs: 3_000_000_000,
		attributes: { "maple.cicd.job.name": "test", "maple.cicd.queue_duration_ms": "3000" },
	},
	// A skipped run is kept (the runs list shows it); one on a push has no pull request.
	run("t2", "skip", {
		"vcs.change.id": "",
		"maple.cicd.trigger_event": "push",
		"maple.cicd.run_attempt": "2",
	}),
	// Another service's root span is not a CI run.
	{
		traceId: "t3",
		spanId: "api-root",
		parentSpanId: "",
		name: "GET /",
		service: "api",
		durationNs: 5,
		attributes: {},
	},
]

const insert = (spans: ReadonlyArray<SeedSpan>, orgId = ORG_ID) =>
	clickhouseExec(
		`INSERT INTO traces
		 (OrgId, Timestamp, TraceId, SpanId, ParentSpanId, SpanName, SpanKind, ServiceName, Duration, StatusCode, StatusMessage, SampleRate, SpanAttributes, ResourceAttributes)
		 VALUES\n${spans
				.map((span, index) => {
					const attributes = Object.entries(span.attributes)
						.map(([key, value]) => `'${key}', '${value}'`)
						.join(", ")
					return `('${orgId}', '${chDateTime(BASE_MS + index * 1000)}', '${span.traceId}', '${span.spanId}', '${span.parentSpanId}', '${span.name}', 'Internal', '${span.service ?? "github-actions"}', ${span.durationNs}, '${span.status ?? "Unset"}', '', 1, map(${attributes}), ${REPO})`
				})
				.join("\n,")}`,
		database,
	)

const runJson = async (sql: string): Promise<ReadonlyArray<Record<string, unknown>>> => {
	const body = await clickhouseExec(`${sql} FORMAT JSON`, database, {
		output_format_json_quote_64bit_integers: "0",
	})
	return (JSON.parse(body) as { readonly data?: ReadonlyArray<Record<string, unknown>> }).data ?? []
}

const runs = () =>
	runJson(
		`SELECT TraceId, Owner, Repository, Pipeline, RunId, RunNumber, Attempt, Result, Duration, Url, Branch,
		        Revision, TriggerEvent, Actor, PullRequest, WorkflowPath
		 FROM ci_runs WHERE OrgId = '${ORG_ID}' ORDER BY TraceId`,
	)
const jobs = () =>
	runJson(
		`SELECT TraceId, Pipeline, Job, Result, StatusCode, QueueMs, FailureReason, RunnerName, RunnerLabels
		 FROM ci_jobs WHERE OrgId = '${ORG_ID}' ORDER BY TraceId, Job`,
	)

const pipelineRun = (
	traceId: string,
	pipeline: string,
	result: string,
	revision: string,
	pullRequest: string,
	attempt = "1",
) =>
	run(traceId, result, {
		"cicd.pipeline.name": pipeline,
		"vcs.ref.head.revision": revision,
		"vcs.change.id": pullRequest,
		"maple.cicd.run_attempt": attempt,
	})

// Oldest first: each span starts a second after the one before.
const READ_SPANS: ReadonlyArray<SeedSpan> = [
	pipelineRun("r1", "CI", "success", "a", "5"),
	job("r1", "build", "success", { "maple.cicd.queue_duration_ms": "1000" }),
	pipelineRun("r2", "CI", "failure", "b", "5"),
	job("r2", "build", "failure", {
		"maple.cicd.queue_duration_ms": "2000",
		"maple.cicd.failure.reason": "boom",
	}),
	// Cancelled before a runner took it: a zero-length job never ran.
	{ ...job("r2", "lint", "cancellation"), durationNs: 0 },
	pipelineRun("r3", "Deploy", "success", "b", ""),
	pipelineRun("r4", "CI", "skip", "c", "6"),
	pipelineRun("r5", "CI", "timeout", "c", "6", "2"),
	job("r5", "build", "failure", { "maple.cicd.queue_duration_ms": "3000", "maple.cicd.run_attempt": "2" }),
]

const readWindow = {
	orgId: READS_ORG_ID,
	startTime: chDateTime(BASE_MS - 60_000),
	endTime: chDateTime(BASE_MS + 60_000),
}
const read = (query: Parameters<typeof CH.compileUnsafe>[0], params: Record<string, unknown> = readWindow) =>
	runJson(CH.compileUnsafe(query, params).sql.replace(/\s*FORMAT JSON\s*$/, ""))
const traceIds = (rows: ReadonlyArray<Record<string, unknown>>) => rows.map((row) => row.traceId)

const ciMigration = migrations.filter((migration) => migration.version === 47)
const backfills = ciMigration.flatMap((migration) => migration.statements.filter(isBackfill))

describe.skipIf(!clickhouseE2eEnabled)("ci_runs / ci_jobs materialization", () => {
	beforeAll(async () => {
		await clickhouseExec(`CREATE DATABASE ${database}`)
		await applyRealMigrations(database)
		await insert(SPANS)
		await insert(READ_SPANS, READS_ORG_ID)
	}, 180_000)

	afterAll(async () => {
		await clickhouseExec(`DROP DATABASE IF EXISTS ${database}`)
	}, 30_000)

	it("keeps one row per run root span with its attributes as columns", async () => {
		assert.deepStrictEqual(await runs(), [
			{
				TraceId: "t1",
				Owner: "acme",
				Repository: "api",
				Pipeline: "CI",
				RunId: "92",
				RunNumber: 42,
				Attempt: 1,
				Result: "failure",
				Duration: 120_000_000_000,
				Url: "https://github.com/acme/api/actions/runs/t1",
				Branch: "feat/x",
				Revision: "abc123",
				TriggerEvent: "pull_request",
				Actor: "octocat",
				PullRequest: 17,
				WorkflowPath: ".github/workflows/ci.yml",
			},
			{
				TraceId: "t2",
				Owner: "acme",
				Repository: "api",
				Pipeline: "CI",
				RunId: "92",
				RunNumber: 42,
				Attempt: 2,
				Result: "skip",
				Duration: 120_000_000_000,
				Url: "https://github.com/acme/api/actions/runs/t2",
				Branch: "feat/x",
				Revision: "abc123",
				TriggerEvent: "push",
				Actor: "octocat",
				PullRequest: 0,
				WorkflowPath: ".github/workflows/ci.yml",
			},
		])
	})

	it("keeps jobs and leaves out their steps and runner waits", async () => {
		assert.deepStrictEqual(await jobs(), [
			{
				TraceId: "t1",
				Pipeline: "CI",
				Job: "lint",
				Result: "success",
				StatusCode: "Unset",
				QueueMs: 3000,
				FailureReason: "",
				RunnerName: "GitHub Actions 7",
				RunnerLabels: "ubuntu-latest",
			},
			{
				TraceId: "t1",
				Pipeline: "CI",
				Job: "test",
				Result: "failure",
				StatusCode: "Error",
				QueueMs: 3000,
				FailureReason: "Process completed with exit code 1.",
				RunnerName: "GitHub Actions 7",
				RunnerLabels: "ubuntu-latest",
			},
		])
	})

	it("backfills the same rows, and never doubles a row the view already wrote", async () => {
		const [liveRuns, liveJobs] = [await runs(), await jobs()]
		assert.strictEqual(backfills.length, 2)

		// Over tables the views already filled: every span is skipped.
		for (const backfill of backfills)
			await clickhouseExec(renderStatementFull(backfill, database), database)
		assert.deepStrictEqual(await runs(), liveRuns)
		assert.deepStrictEqual(await jobs(), liveJobs)

		// Over empty tables: rebuilt from the raw spans alone.
		await clickhouseExec("TRUNCATE TABLE ci_runs", database)
		await clickhouseExec("TRUNCATE TABLE ci_jobs", database)
		for (const backfill of backfills)
			await clickhouseExec(renderStatementFull(backfill, database), database)
		assert.deepStrictEqual(await runs(), liveRuns)
		assert.deepStrictEqual(await jobs(), liveJobs)
	})

	it("keeps runs older than raw retention when the whole migration is applied again", async () => {
		const expired = "org_ci_expired_e2e"
		await clickhouseExec(
			`INSERT INTO ci_runs (OrgId, Timestamp, TraceId, SpanId, Pipeline, Result) VALUES ('${expired}', now64(9) - INTERVAL 200 DAY, 'gone', 'run-gone', 'CI', 'success')`,
			database,
		)
		const before = await runs()
		for (const statement of ciMigration.flatMap((migration) => migration.statements))
			await clickhouseExec(renderStatementFull(statement, database), database)
		assert.deepStrictEqual(await runs(), before)
		const kept = await runJson(`SELECT TraceId FROM ci_runs WHERE OrgId = '${expired}'`)
		assert.deepStrictEqual(kept, [{ TraceId: "gone" }])
	})

	it("counts runs that ran, failures apart from cancellations", async () => {
		const [totals] = await read(CH.ciRunTotalsQuery({}))
		assert.deepInclude(totals, { runs: 4, succeeded: 2, failed: 2, cancelled: 0 })
		const series = await read(CH.ciRunSeriesQuery({}), { ...readWindow, bucketSeconds: 86_400 })
		assert.strictEqual(
			series.reduce((sum, row) => sum + Number(row.runs), 0),
			4,
		)
	})

	it("keeps each workflow's run counts and latest result", async () => {
		const rows = await read(CH.ciPipelineStatsQuery({}))
		assert.deepStrictEqual(
			rows.map(({ pipeline, runs, failed, lastResult }) => ({ pipeline, runs, failed, lastResult })),
			[
				{ pipeline: "CI", runs: 3, failed: 2, lastResult: "timeout" },
				{ pipeline: "Deploy", runs: 1, failed: 0, lastResult: "success" },
			],
		)
		const [ci] = await read(
			CH.ciPipelineStatsQuery({ owner: "acme", repository: "api", pipeline: "Deploy" }),
		)
		assert.strictEqual(ci?.pipeline, "Deploy")
	})

	it("counts jobs that ran, with reruns and queue time", async () => {
		const [build, ...others] = await read(CH.ciJobStatsQuery({}))
		assert.deepInclude(build, { job: "build", runs: 3, failed: 2, retried: 1, p50QueueMs: 2000 })
		assert.deepStrictEqual(others, [])
		const [queue] = await read(CH.ciQueueTotalsQuery({}))
		assert.deepInclude(queue, { jobs: 3, p50QueueMs: 2000 })
	})

	it("lists runs newest first, pages after a cursor, and filters by pull request", async () => {
		const all = await read(CH.ciRunsQuery({}))
		assert.deepStrictEqual(traceIds(all), ["r5", "r4", "r3", "r2", "r1"])
		assert.deepInclude(all[0], { attempt: 2, pullRequest: 6, durationMs: 120_000 })
		assert.strictEqual(all[2]?.pullRequest, 0)

		const startedAt = DateTime.makeUnsafe(`${String(all[1]?.startedAt).replace(" ", "T")}Z`)
		const after = await read(CH.ciRunsQuery({ before: { startedAt, traceId: "r4" } }), {
			...readWindow,
			beforeStartedAt: startedAt,
			beforeTraceId: "r4",
		})
		assert.deepStrictEqual(traceIds(after), ["r3", "r2", "r1"])
		assert.deepStrictEqual(traceIds(await read(CH.ciRunsQuery({ pullRequest: 5 }))), ["r2", "r1"])
	})

	it("finds a workflow's red streak and the failed jobs of its runs", async () => {
		const ran = await read(CH.ciRunsQuery({ pipeline: "CI", ranOnly: true }))
		assert.deepStrictEqual(traceIds(ran), ["r5", "r2", "r1"])
		const streak = CH.ciRedStreak(
			ran.map((row) => ({ result: String(row.result), revision: String(row.revision) })),
		)
		assert.deepStrictEqual(
			{
				failedRuns: streak?.failedRuns,
				first: streak?.firstFailed.revision,
				green: streak?.lastGreen?.revision,
			},
			{ failedRuns: 2, first: "b", green: "a" },
		)
		const failed = await read(CH.ciFailedJobsQuery({ traceIds: ["r2", "r5"] }))
		assert.deepStrictEqual(
			failed.map(({ traceId, job, reason }) => ({ traceId, job, reason })),
			[
				{ traceId: "r2", job: "build", reason: "boom" },
				{ traceId: "r5", job: "build", reason: "" },
			],
		)
	})
})
