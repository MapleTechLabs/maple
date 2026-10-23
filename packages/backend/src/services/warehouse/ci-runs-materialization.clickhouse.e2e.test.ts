// SAFETY-FILE: JSON in this test is emitted by ClickHouse before its fields are asserted.
// `ci_runs` and `ci_jobs` are filtered projections of `github-actions` traces, and a projection
// that silently drops or doubles rows reads as plausible CI numbers. So this proves rows: spans
// shaped like CiTraceService's, inserted into `traces` on a database built from the real
// migration chain, must land in the projections exactly, and migration 0047's backfill must
// rebuild them without doubling the rows the views already wrote.

import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest"
import { migrations, renderStatementFull } from "@maple/domain/clickhouse"
import {
	applyRealMigrations,
	clickhouseE2eEnabled,
	clickhouseExec,
	uniqueDatabase,
} from "./clickhouse-e2e-support"

const database = uniqueDatabase("maple_ci_runs_e2e")
const ORG_ID = "org_ci_runs_e2e"

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

const insert = (spans: ReadonlyArray<SeedSpan>) =>
	clickhouseExec(
		`INSERT INTO traces
		 (OrgId, Timestamp, TraceId, SpanId, ParentSpanId, SpanName, SpanKind, ServiceName, Duration, StatusCode, StatusMessage, SampleRate, SpanAttributes, ResourceAttributes)
		 VALUES\n${spans
				.map((span, index) => {
					const attributes = Object.entries(span.attributes)
						.map(([key, value]) => `'${key}', '${value}'`)
						.join(", ")
					return `('${ORG_ID}', '${chDateTime(BASE_MS + index * 1000)}', '${span.traceId}', '${span.spanId}', '${span.parentSpanId}', '${span.name}', 'Internal', '${span.service ?? "github-actions"}', ${span.durationNs}, '${span.status ?? "Unset"}', '', 1, map(${attributes}), ${REPO})`
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

const backfills = migrations
	.find((migration) => migration.version === 47)!
	.statements.filter((statement) => typeof statement !== "string")

describe.skipIf(!clickhouseE2eEnabled)("ci_runs / ci_jobs materialization", () => {
	beforeAll(async () => {
		await clickhouseExec(`CREATE DATABASE ${database}`)
		await applyRealMigrations(database)
		await insert(SPANS)
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
})
