import { makePrng, type NonEmpty, type Prng } from "../prng.ts"
import { emptyTelemetry, formatMicros, type TelemetryRows, type WarehouseRow } from "./rows.ts"

/**
 * GitHub Actions runs as the GitHub integration writes them (`ci-traces/otlp.ts`): one root SERVER
 * span per workflow run under `github-actions`, one INTERNAL child per job. Two repositories, three
 * workflows, about two runs a day each over the last three weeks.
 */

export const CI_OWNER = "acme-shop"

interface Workflow {
	readonly repository: string
	readonly name: string
	readonly path: string
	readonly jobs: NonEmpty<{ readonly name: string; readonly baseMs: number; readonly failure?: string }>
	readonly runsPerDay: number
	/** Chance a run breaks; the flaky E2E suite breaks more and is red at `now`. */
	readonly failRate: number
}

const WORKFLOWS: NonEmpty<Workflow> = [
	{
		repository: "shop",
		name: "CI",
		path: ".github/workflows/ci.yml",
		runsPerDay: 3,
		failRate: 0.12,
		jobs: [
			{ name: "lint", baseMs: 62_000, failure: "oxlint: 3 errors in src/checkout/cart.ts" },
			{ name: "typecheck", baseMs: 118_000, failure: "TS2322: Type 'string' is not assignable to type 'OrderId'." },
			{ name: "test (unit)", baseMs: 254_000, failure: "2 failed: payment retries the capture once" },
			{ name: "build", baseMs: 171_000 },
		],
	},
	{
		repository: "shop",
		name: "E2E",
		path: ".github/workflows/e2e.yml",
		runsPerDay: 2,
		failRate: 0.3,
		jobs: [
			{ name: "playwright (chromium)", baseMs: 512_000, failure: "checkout.spec.ts: timed out waiting for 'Order placed'" },
			{ name: "playwright (webkit)", baseMs: 588_000, failure: "cart.spec.ts: expected 3 items, received 2" },
		],
	},
	{
		repository: "payments",
		name: "Deploy",
		path: ".github/workflows/deploy.yml",
		runsPerDay: 1,
		failRate: 0.08,
		jobs: [
			{ name: "build image", baseMs: 204_000 },
			{ name: "migrate", baseMs: 41_000, failure: "migration 0042_capture_ledger: lock timeout" },
			{ name: "rollout", baseMs: 133_000 },
		],
	},
]

const ACTORS: NonEmpty<string> = ["ada-l", "grace-h", "linus-t", "margaret-h"]
/** Pull requests the reviews fixture knows, so a review's sheet lists its CI runs. */
export const CI_PULL_REQUESTS: NonEmpty<{ readonly number: number; readonly branch: string; readonly author: string }> = [
	{ number: 482, branch: "feat/checkout-retries", author: "ada-l" },
	{ number: 479, branch: "fix/cart-rounding", author: "grace-h" },
	{ number: 476, branch: "chore/otel-upgrade", author: "linus-t" },
	{ number: 131, branch: "feat/capture-ledger", author: "margaret-h" },
]

const HOUR_MICROS = 3_600_000_000
const DAYS = 21

const jobRows = (
	run: { readonly traceId: string; readonly spanId: string; readonly startMicros: number; readonly base: WarehouseRow },
	workflow: Workflow,
	rng: Prng,
	failedJob: number,
) =>
	workflow.jobs.reduce<{ readonly cursor: number; readonly rows: ReadonlyArray<WarehouseRow> }>(
		(state, job, index) => {
			const queueMs = rng.int(2_000, 45_000)
			const durationMs = Math.round(job.baseMs * rng.spread(0.2)) + queueMs
			const failed = index === failedJob
			const skipped = failedJob !== -1 && index > failedJob
			const reason = failed ? (job.failure ?? "Process completed with exit code 1.") : ""
			const row: WarehouseRow = {
				...run.base,
				Timestamp: formatMicros(state.cursor),
				SpanId: rng.hex(16),
				ParentSpanId: run.spanId,
				SpanName: job.name,
				SpanKind: "Internal",
				Duration: skipped ? 0 : durationMs * 1_000_000,
				StatusCode: failed ? "Error" : "Unset",
				StatusMessage: reason,
				SpanAttributes: {
					...sharedAttributes(run.base),
					"cicd.pipeline.task.name": job.name,
					"cicd.pipeline.task.run.id": String(4_100_000 + index),
					"cicd.pipeline.task.run.url.full": `${String(sharedAttributes(run.base)["cicd.pipeline.run.url.full"])}/job/${index + 1}`,
					"cicd.pipeline.task.run.result": skipped ? "skip" : failed ? "failure" : "success",
					"maple.cicd.queue_duration_ms": String(queueMs),
					"maple.cicd.runner_labels": "ubuntu-latest",
					...(failed ? { "maple.cicd.failure.reason": reason, "error.type": "failure" } : undefined),
				},
			}
			return { cursor: state.cursor + (skipped ? 0 : durationMs * 1000), rows: [...state.rows, row] }
		},
		{ cursor: run.startMicros + 1_000_000, rows: [] },
	)

const sharedAttributes = (base: WarehouseRow): Readonly<Record<string, string>> => {
	const attributes = base.SpanAttributes
	return typeof attributes === "object" && attributes !== null ? Object.fromEntries(Object.entries(attributes)) : {}
}

export const codeReviewCiTelemetry = (options: { readonly orgId: string; readonly now: Date; readonly seed: number }): TelemetryRows => {
	const rng = makePrng(options.seed)
	const nowMicros = options.now.getTime() * 1000
	const traces = WORKFLOWS.flatMap((workflow, workflowIndex) =>
		Array.from({ length: DAYS * workflow.runsPerDay }, (_, index) => {
			const hoursAgo = ((DAYS * 24) / (DAYS * workflow.runsPerDay)) * (index + 0.5) + workflowIndex * 1.7
			const startMicros = nowMicros - Math.round(hoursAgo * HOUR_MICROS) - rng.int(0, 1_800_000_000)
			const pr = index % 3 === 2 ? undefined : CI_PULL_REQUESTS[(index + workflowIndex) % CI_PULL_REQUESTS.length]
			const repoPr = pr !== undefined && (workflow.repository === "payments") === (pr.number < 200) ? pr : undefined
			// E2E has been red for its three newest runs; every other workflow fails at its rate.
			const red = workflow.name === "E2E" && index < 3
			const cancelled = !red && rng.chance(0.05)
			const failed = red || (!cancelled && rng.chance(workflow.failRate))
			const failedJob = failed ? rng.int(0, workflow.jobs.length - 1) : -1
			const traceId = rng.hex(32)
			const spanId = rng.hex(16)
			const runId = String(9_800_000_000 + workflowIndex * 1_000 + index)
			const attempt = failed && index % 4 === 1 ? "2" : "1"
			const base: WarehouseRow = {
				OrgId: options.orgId,
				TraceId: traceId,
				TraceState: "",
				ServiceName: "github-actions",
				ResourceSchemaUrl: "",
				ResourceAttributes: {
					"service.name": "github-actions",
					"vcs.provider.name": "github",
					"vcs.owner.name": CI_OWNER,
					"vcs.repository.name": workflow.repository,
					"vcs.repository.url.full": `https://github.com/${CI_OWNER}/${workflow.repository}`,
				},
				ScopeSchemaUrl: "",
				ScopeName: "maple-github-actions",
				ScopeVersion: "1.0.0",
				ScopeAttributes: {},
				EventsTimestamp: [],
				EventsName: [],
				EventsAttributes: [],
				LinksTraceId: [],
				LinksSpanId: [],
				LinksTraceState: [],
				LinksAttributes: [],
				SpanAttributes: {
					"cicd.pipeline.name": workflow.name,
					"cicd.pipeline.run.id": runId,
					"cicd.pipeline.run.url.full": `https://github.com/${CI_OWNER}/${workflow.repository}/actions/runs/${runId}`,
					"vcs.ref.head.name": repoPr?.branch ?? "main",
					"vcs.ref.head.revision": rng.hex(40),
					"maple.cicd.run_attempt": attempt,
				},
			}
			const jobs = jobRows({ traceId, spanId, startMicros, base }, workflow, rng, cancelled ? -1 : failedJob)
			const durationMicros = jobs.cursor - startMicros + 2_000_000
			const result = cancelled ? "cancellation" : failed ? "failure" : "success"
			const root: WarehouseRow = {
				...base,
				Timestamp: formatMicros(startMicros),
				SpanId: spanId,
				ParentSpanId: "",
				SpanName: `RUN ${workflow.name}`,
				SpanKind: "Server",
				Duration: durationMicros * 1000,
				StatusCode: failed ? "Error" : "Unset",
				StatusMessage: "",
				SpanAttributes: {
					...sharedAttributes(base),
					"cicd.pipeline.result": result,
					"cicd.pipeline.action.name": "RUN",
					...(failed ? { "error.type": "failure" } : undefined),
					...(repoPr === undefined ? undefined : { "vcs.change.id": String(repoPr.number) }),
					"maple.cicd.run_number": String(1_200 + index),
					"maple.cicd.trigger_event": repoPr === undefined ? "push" : "pull_request",
					"maple.cicd.workflow_path": workflow.path,
					"maple.cicd.actor": repoPr?.author ?? rng.pick(ACTORS),
				},
			}
			return [root, ...jobs.rows]
		}).flat(),
	)
	return { ...emptyTelemetry, traces }
}
