#!/usr/bin/env bun
/**
 * Seed GitHub Actions CI traces into a Tinybird `traces` datasource, for the Code Review CI tab.
 *
 *   bun scripts/seed-ci-runs.ts --org <orgId> [--repo acme/web] [--days 7] [--dry-run]
 *   bun scripts/seed-ci-runs.ts --ingest https://ingest-pr-<n>.maple.dev --key <ingest-key>
 *
 * Runs and jobs go through the real encoder (`ci-traces/otlp.ts`), so the spans carry exactly the
 * attributes the GitHub integration writes; only the OTLP to row step is done here, the way the
 * ingest gateway does it. The history has a green baseline, slow and flaky test shards, a retried
 * run, cancelled runs and a red streak on `CI` at the end.
 *
 * With `--org` the rows go straight into a Tinybird `traces` datasource (env TINYBIRD_HOST,
 * TINYBIRD_TOKEN; the `.env.local` pair points at the local container). With `--ingest` the OTLP
 * goes through an ingest gateway, which stamps the key's org: the way to seed a PR preview.
 */
import { parseArgs } from "node:util"
import {
	type OtlpKeyValue,
	type OtlpTracesPayload,
	workflowJobToOtlp,
	workflowRunToOtlp,
} from "../packages/backend/src/services/integrations/ci-traces/otlp"

const { values } = parseArgs({
	options: {
		org: { type: "string" },
		ingest: { type: "string" },
		key: { type: "string" },
		repo: { type: "string", default: "acme/web" },
		days: { type: "string", default: "7" },
		"dry-run": { type: "boolean", default: false },
	},
})
const org = values.org ?? "ingest-stamped"
if (values.org === undefined && (values.ingest === undefined || values.key === undefined)) {
	console.error("Pass --org <orgId>, or --ingest <gateway url> --key <ingest key>")
	process.exit(2)
}
const repo = values.repo ?? "acme/web"
const days = Number(values.days)

const MIN = 60_000
const HOUR = 60 * MIN
const now = Date.now()
let seed = 42
const random = () => {
	seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31
	return seed / 2 ** 31
}
const between = (low: number, high: number) => low + random() * (high - low)
const sha = () => Array.from({ length: 40 }, () => Math.floor(random() * 16).toString(16)).join("")

interface JobPlan {
	readonly name: string
	readonly minutes: readonly [number, number]
	/** Chance the job fails on its own. */
	readonly flake?: number
	readonly reason?: { readonly path: string; readonly line: number; readonly message: string }
}

const WORKFLOWS: ReadonlyArray<{ name: string; path: string; jobs: ReadonlyArray<JobPlan>; every: number }> =
	[
		{
			name: "CI",
			path: ".github/workflows/ci.yml",
			every: 1,
			jobs: [
				{ name: "Lint", minutes: [1, 2] },
				{ name: "Typecheck", minutes: [3, 4.5] },
				{
					name: "Tests (shard 1/3)",
					minutes: [4, 6],
					flake: 0.06,
					reason: {
						path: "src/checkout/cart.test.ts",
						line: 88,
						message: "AssertionError: expected 3 to be 2",
					},
				},
				{ name: "Tests (shard 2/3)", minutes: [5, 9] },
				{ name: "Tests (shard 3/3)", minutes: [3, 5] },
				{ name: "Build", minutes: [2, 3] },
			],
		},
		{
			name: "CodeQL",
			path: ".github/workflows/codeql.yml",
			every: 3,
			jobs: [{ name: "Analyze (javascript-typescript)", minutes: [6, 11] }],
		},
		{
			name: "Deploy",
			path: ".github/workflows/deploy.yml",
			every: 6,
			jobs: [
				{ name: "Migrate", minutes: [0.5, 1] },
				{ name: "Deploy workers", minutes: [4, 7], flake: 0.04 },
			],
		},
	]

const payloads: OtlpTracesPayload[] = []
const runCount = Math.round((days * 24 * HOUR) / (45 * MIN))
let runId = 9_000_000_000
for (let i = 0; i < runCount; i++) {
	const startedAt = now - days * 24 * HOUR + i * 45 * MIN + between(0, 20 * MIN)
	const pr = 1400 + Math.floor(i / 4)
	const branch = i % 5 === 0 ? "main" : `feat/change-${pr}`
	const headSha = sha()
	// The last few CI runs break the same test: the red streak the tab should name.
	const redTail = i >= runCount - 4
	for (const [index, workflow] of WORKFLOWS.entries()) {
		if (i % workflow.every !== index % workflow.every) continue
		if (workflow.name === "Deploy" && branch !== "main") continue
		const cancelled = random() < 0.03
		const attempts = workflow.name === "CI" && i % 23 === 7 ? 2 : 1
		for (let attempt = 1; attempt <= attempts; attempt++) {
			runId++
			const runStart = startedAt + (attempt - 1) * 20 * MIN
			let cursor = runStart
			let failed = false
			const jobs = workflow.jobs.map((plan, jobIndex) => {
				const queuedAt = cursor + between(0, 5_000)
				// Runner waits spike in the afternoon (UTC), when everyone pushes.
				const busy = new Date(queuedAt).getUTCHours() >= 13 && new Date(queuedAt).getUTCHours() <= 17
				const started = queuedAt + between(5_000, busy ? 150_000 : 40_000)
				const completed = started + between(plan.minutes[0], plan.minutes[1]) * MIN
				const breaks =
					!cancelled &&
					plan.reason !== undefined &&
					((redTail && workflow.name === "CI") || (attempt === 1 && random() < (plan.flake ?? 0)))
				const flaked = !cancelled && !breaks && attempt === 1 && attempts === 2 && jobIndex === 2
				const conclusion = cancelled ? "cancelled" : breaks || flaked ? "failure" : "success"
				if (conclusion === "failure") failed = true
				return {
					plan,
					conclusion,
					job: {
						kind: "workflow-job" as const,
						provider: "github" as const,
						externalInstallationId: "1",
						externalRepoId: "1",
						repoFullName: repo,
						runId: String(runId),
						runAttempt: attempt,
						jobId: String(runId * 10 + jobIndex),
						name: plan.name,
						workflowName: workflow.name,
						conclusion,
						headBranch: branch,
						headSha,
						runnerName: `GitHub Actions ${jobIndex + 1}`,
						labels: ["ubuntu-latest"],
						url: `https://github.com/${repo}/actions/runs/${runId}/job/${runId * 10 + jobIndex}`,
						queuedAtMs: Math.round(queuedAt),
						startedAtMs: Math.round(started),
						completedAtMs: Math.round(completed),
						steps: [
							{
								number: 1,
								name: "Set up job",
								conclusion: "success",
								start: started,
								end: started + 2_000,
							},
							{
								number: 2,
								name: "Run actions/checkout@08eba0b27e820071cde6df949e0beb9ba4906955",
								conclusion: "success",
								start: started + 2_000,
								end: started + 6_000,
							},
							{
								number: 3,
								name: `Run ${plan.name}`,
								conclusion,
								start: started + 6_000,
								end: completed,
							},
						].map((step) => ({
							number: step.number,
							name: step.name,
							conclusion: step.conclusion,
							startedAtMs: Math.round(step.start),
							completedAtMs: Math.round(step.end),
						})),
					},
				}
			})
			const completedAt = Math.max(...jobs.map((entry) => entry.job.completedAtMs))
			cursor = completedAt
			payloads.push(
				workflowRunToOtlp({
					kind: "workflow-run",
					provider: "github",
					externalInstallationId: "1",
					externalRepoId: "1",
					repoFullName: repo,
					runId: String(runId),
					runAttempt: attempt,
					runNumber: runId - 9_000_000_000,
					workflowName: workflow.name,
					workflowPath: workflow.path,
					triggerEvent: branch === "main" ? "push" : "pull_request",
					conclusion: cancelled ? "cancelled" : failed ? "failure" : "success",
					headBranch: branch,
					headSha,
					actorLogin: ["ada", "grace", "linus"][i % 3] ?? "ada",
					pullRequestNumbers: branch === "main" ? [] : [pr],
					url: `https://github.com/${repo}/actions/runs/${runId}`,
					startedAtMs: Math.round(runStart),
					completedAtMs: completedAt,
				}),
				...jobs.map(({ job, conclusion, plan }) =>
					workflowJobToOtlp(
						job,
						conclusion === "failure" && plan.reason !== undefined
							? [
									{
										level: "failure",
										message: plan.reason.message,
										title: "Test failed",
										path: plan.reason.path,
										startLine: plan.reason.line,
									},
									{
										level: "failure",
										message: "Process completed with exit code 1.",
										title: null,
										path: null,
										startLine: null,
									},
								]
							: [],
					),
				),
			)
		}
	}
}

// OTLP to `traces` rows, as the ingest gateway writes them.
const valueOf = (kv: OtlpKeyValue) => ("stringValue" in kv.value ? kv.value.stringValue : kv.value.intValue)
const mapOf = (attributes: ReadonlyArray<OtlpKeyValue>) =>
	Object.fromEntries(attributes.map((kv) => [kv.key, valueOf(kv)]))
const timeOf = (nanos: string) => {
	const ms = Number(nanos.slice(0, -6))
	return `${new Date(ms).toISOString().slice(0, 19).replace("T", " ")}.${nanos.slice(-9).padStart(9, "0")}`
}
const kindOf = (kind: number) => (kind === 2 ? "Server" : "Internal")
const statusOf = (code: number) => (code === 2 ? "Error" : code === 1 ? "Ok" : "Unset")

const rows = payloads.flatMap((payload) =>
	payload.resourceSpans.flatMap((resourceSpan) => {
		const resource = {
			...mapOf(resourceSpan.resource.attributes),
			maple_org_id: org,
			maple_ingest_source: "seed-ci-runs",
		}
		return resourceSpan.scopeSpans.flatMap((scopeSpan) =>
			scopeSpan.spans.map((span) => ({
				start_time: timeOf(span.startTimeUnixNano),
				trace_id: span.traceId,
				span_id: span.spanId,
				parent_span_id: span.parentSpanId,
				trace_state: "",
				span_name: span.name,
				span_kind: kindOf(span.kind),
				service_name: resource["service.name"] ?? "github-actions",
				resource_schema_url: "",
				resource_attributes: resource,
				scope_schema_url: "",
				scope_name: scopeSpan.scope.name,
				scope_version: "",
				scope_attributes: {},
				// A JSON number: a quoted UInt64 lands in quarantine. Nanosecond spans of days stay exact.
				duration: Number(BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano)),
				status_code: statusOf(span.status.code),
				status_message: span.status.message,
				span_attributes: mapOf(span.attributes),
				events_timestamp: (span.events ?? []).map((event) => timeOf(event.timeUnixNano)),
				events_name: (span.events ?? []).map((event) => event.name),
				events_attributes: (span.events ?? []).map((event) => mapOf(event.attributes)),
				links_trace_id: [],
				links_span_id: [],
				links_trace_state: [],
				links_attributes: [],
			})),
		)
	}),
)

const runs = rows.filter((row) => row.parent_span_id === "").length
console.log(`${runs} runs, ${rows.length} spans for ${org} (${repo}, last ${days} days)`)
if (values["dry-run"]) {
	console.log(JSON.stringify(rows.slice(0, 2), null, 2))
	process.exit(0)
}

if (values.ingest !== undefined && values.key !== undefined) {
	for (const payload of payloads) {
		const response = await fetch(`${values.ingest.replace(/\/+$/, "")}/v1/traces`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${values.key}` },
			body: JSON.stringify(payload),
		})
		if (!response.ok) {
			console.error(`The gateway answered ${response.status}: ${await response.text()}`)
			process.exit(1)
		}
	}
	console.log(`Sent ${payloads.length} OTLP payloads.`)
	process.exit(0)
}

const host = process.env.TINYBIRD_HOST
const token = process.env.TINYBIRD_TOKEN
if (!host || !token) {
	console.error("TINYBIRD_HOST and TINYBIRD_TOKEN are required")
	process.exit(2)
}
const BATCH = 2_000
for (let start = 0; start < rows.length; start += BATCH) {
	const body = rows
		.slice(start, start + BATCH)
		.map((row) => JSON.stringify(row))
		.join("\n")
	const response = await fetch(`${host.replace(/\/+$/, "")}/v0/events?name=traces&wait=true`, {
		method: "POST",
		headers: { Authorization: `Bearer ${token}` },
		body,
	})
	if (!response.ok) {
		console.error(`Tinybird answered ${response.status}: ${await response.text()}`)
		process.exit(1)
	}
}
console.log("Seeded.")
