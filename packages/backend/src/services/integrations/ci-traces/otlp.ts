/**
 * CI workflow runs and jobs as OTLP/HTTP JSON spans, shipped through the ingest gateway like any
 * other telemetry (per-org routing, metering, WAL durability).
 *
 * One trace per run attempt: the run is the root span, each job a child, each step a grandchild.
 * Runs and jobs arrive as separate webhooks in any order, so every id is derived from the
 * provider's own ids rather than generated, and both halves land in the same trace.
 */
import { createHash } from "node:crypto"
import type { WorkflowJobJob, WorkflowRunJob, WorkflowStep } from "@maple/domain/http"

export const CI_SERVICE_NAME = "github-actions"
const SCOPE_NAME = "@maple/ci-traces"

const SPAN_KIND_INTERNAL = 1
const STATUS_UNSET = 0
const STATUS_OK = 1
const STATUS_ERROR = 2

type OtlpValue = { readonly stringValue: string } | { readonly intValue: string }

interface OtlpKeyValue {
	readonly key: string
	readonly value: OtlpValue
}

export interface OtlpSpan {
	readonly traceId: string
	readonly spanId: string
	readonly parentSpanId: string
	readonly name: string
	readonly kind: number
	readonly startTimeUnixNano: string
	readonly endTimeUnixNano: string
	readonly attributes: ReadonlyArray<OtlpKeyValue>
	readonly status: { readonly code: number; readonly message: string }
}

export interface OtlpTracesPayload {
	readonly resourceSpans: ReadonlyArray<{
		readonly resource: { readonly attributes: ReadonlyArray<OtlpKeyValue> }
		readonly scopeSpans: ReadonlyArray<{
			readonly scope: { readonly name: string }
			readonly spans: ReadonlyArray<OtlpSpan>
		}>
	}>
}

const hashHex = (input: string, length: number) =>
	createHash("sha256").update(input).digest("hex").slice(0, length)

interface RunKey {
	readonly provider: string
	readonly externalRepoId: string
	readonly runId: string
	readonly runAttempt: number
}

const runKey = (run: RunKey) => `${run.provider}:${run.externalRepoId}:${run.runId}:${run.runAttempt}`

export const ciTraceId = (run: RunKey) => hashHex(`trace:${runKey(run)}`, 32)
export const ciRunSpanId = (run: RunKey) => hashHex(`run:${runKey(run)}`, 16)
const jobSpanId = (job: WorkflowJobJob) => hashHex(`job:${runKey(job)}:${job.jobId}`, 16)
const stepSpanId = (job: WorkflowJobJob, step: WorkflowStep) =>
	hashHex(`step:${runKey(job)}:${job.jobId}:${step.number}`, 16)

/** ms → unix-nanosecond string; six zeros keep it exact past 2^53. */
const unixNano = (ms: number) => `${Math.trunc(ms)}000000`

/** GitHub's conclusion as the semconv `cicd.pipeline.result` value; unknown values pass through. */
const resultOf = (conclusion: string | null): string | undefined => {
	switch (conclusion) {
		case null:
			return undefined
		case "success":
			return "success"
		case "failure":
			return "failure"
		case "timed_out":
			return "timeout"
		case "cancelled":
			return "cancellation"
		case "skipped":
			return "skip"
		case "startup_failure":
			return "error"
		default:
			return conclusion
	}
}

/** Failures are Error, a pass is Ok, and cancelled / skipped / neutral runs carry no verdict. */
const statusOf = (conclusion: string | null) => {
	switch (conclusion) {
		case "success":
			return { code: STATUS_OK, message: "" }
		case "failure":
		case "timed_out":
		case "startup_failure":
			return { code: STATUS_ERROR, message: conclusion }
		default:
			return { code: STATUS_UNSET, message: "" }
	}
}

const attrs = (entries: Record<string, string | number | null | undefined>): OtlpKeyValue[] =>
	Object.entries(entries).flatMap(([key, value]) => {
		if (value === null || value === undefined || value === "") return []
		return [
			{
				key,
				value:
					typeof value === "number"
						? { intValue: String(Math.trunc(value)) }
						: { stringValue: value },
			},
		]
	})

const resourceOf = (repoFullName: string) => {
	const slash = repoFullName.indexOf("/")
	return attrs({
		"service.name": CI_SERVICE_NAME,
		"vcs.provider.name": "github",
		"vcs.owner.name": slash === -1 ? undefined : repoFullName.slice(0, slash),
		"vcs.repository.name": slash === -1 ? repoFullName : repoFullName.slice(slash + 1),
	})
}

const payloadOf = (repoFullName: string, spans: ReadonlyArray<OtlpSpan>): OtlpTracesPayload => ({
	resourceSpans: [
		{
			resource: { attributes: resourceOf(repoFullName) },
			scopeSpans: [{ scope: { name: SCOPE_NAME }, spans }],
		},
	],
})

const refAttrs = (headBranch: string | null, headSha: string | null) => ({
	"vcs.ref.head.name": headBranch,
	"vcs.ref.head.revision": headSha,
})

export const workflowRunToOtlp = (run: WorkflowRunJob): OtlpTracesPayload =>
	payloadOf(run.repoFullName, [
		{
			traceId: ciTraceId(run),
			spanId: ciRunSpanId(run),
			parentSpanId: "",
			name: run.workflowName,
			kind: SPAN_KIND_INTERNAL,
			startTimeUnixNano: unixNano(run.startedAtMs),
			endTimeUnixNano: unixNano(run.completedAtMs),
			attributes: attrs({
				"cicd.pipeline.name": run.workflowName,
				"cicd.pipeline.run.id": run.runId,
				"cicd.pipeline.run.url.full": run.url,
				"cicd.pipeline.result": resultOf(run.conclusion),
				...refAttrs(run.headBranch, run.headSha),
				"vcs.change.id":
					run.pullRequestNumbers[0] === undefined ? undefined : String(run.pullRequestNumbers[0]),
				"maple.cicd.run_attempt": run.runAttempt,
				"maple.cicd.run_number": run.runNumber,
				"maple.cicd.trigger_event": run.triggerEvent,
				"maple.cicd.workflow_path": run.workflowPath,
				"maple.cicd.actor": run.actorLogin,
			}),
			status: statusOf(run.conclusion),
		},
	])

export const workflowJobToOtlp = (job: WorkflowJobJob): OtlpTracesPayload => {
	const traceId = ciTraceId(job)
	const jobSpan = jobSpanId(job)
	const shared = {
		"cicd.pipeline.name": job.workflowName,
		"cicd.pipeline.run.id": job.runId,
		"cicd.pipeline.task.run.id": job.jobId,
		...refAttrs(job.headBranch, job.headSha),
		"maple.cicd.run_attempt": job.runAttempt,
	}
	const steps = job.steps.map((step): OtlpSpan => ({
		traceId,
		spanId: stepSpanId(job, step),
		parentSpanId: jobSpan,
		name: step.name,
		kind: SPAN_KIND_INTERNAL,
		startTimeUnixNano: unixNano(step.startedAtMs),
		endTimeUnixNano: unixNano(step.completedAtMs),
		attributes: attrs({
			...shared,
			"cicd.pipeline.task.name": job.name,
			"cicd.pipeline.task.run.result": resultOf(step.conclusion),
			"maple.cicd.step.name": step.name,
			"maple.cicd.step.number": step.number,
		}),
		status: statusOf(step.conclusion),
	}))
	return payloadOf(job.repoFullName, [
		{
			traceId,
			spanId: jobSpan,
			parentSpanId: ciRunSpanId(job),
			name: job.name,
			kind: SPAN_KIND_INTERNAL,
			startTimeUnixNano: unixNano(job.startedAtMs),
			endTimeUnixNano: unixNano(job.completedAtMs),
			attributes: attrs({
				...shared,
				"cicd.pipeline.task.name": job.name,
				"cicd.pipeline.task.run.url.full": job.url,
				"cicd.pipeline.task.run.result": resultOf(job.conclusion),
				"cicd.worker.name": job.runnerName,
				"maple.cicd.queue_duration_ms": job.startedAtMs - job.queuedAtMs,
				"maple.cicd.runner_labels": job.labels.join(","),
			}),
			status: statusOf(job.conclusion),
		},
		...steps,
	])
}
