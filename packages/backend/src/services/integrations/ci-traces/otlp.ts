/**
 * CI workflow runs and jobs as OTLP/HTTP JSON spans, shipped through the ingest gateway like any
 * other telemetry (per-org routing, metering, WAL durability).
 *
 * One trace per run attempt: the run is the root span, each job a child, each step a grandchild.
 * Runs and jobs arrive as separate webhooks in any order, so every id is derived from the
 * provider's own ids rather than generated, and both halves land in the same trace.
 */
import { createHash } from "node:crypto"
import {
	SOURCE_ID_ATTRIBUTE,
	type WorkflowJobAnnotation,
	type WorkflowJobJob,
	type WorkflowRunJob,
	type WorkflowStep,
} from "@maple/domain/http"
import { CI_SERVICE_NAME } from "@maple/domain/tinybird"

export const SCOPE_NAME = "@maple/ci-traces"

const SPAN_KIND_INTERNAL = 1
const SPAN_KIND_SERVER = 2
/** `cicd.pipeline.action.name` of a workflow run: it executes the pipeline, it is not a build or sync. */
const PIPELINE_ACTION = "RUN"
const STATUS_UNSET = 0
const STATUS_OK = 1
const STATUS_ERROR = 2

type OtlpValue = { readonly stringValue: string } | { readonly intValue: string }

export interface OtlpKeyValue {
	readonly key: string
	readonly value: OtlpValue
}

interface OtlpEvent {
	readonly name: string
	readonly timeUnixNano: string
	readonly attributes: ReadonlyArray<OtlpKeyValue>
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
	readonly events?: ReadonlyArray<OtlpEvent>
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
export const jobSpanId = (job: WorkflowJobJob) => hashHex(`job:${runKey(job)}:${job.jobId}`, 16)
export const stepSpanId = (job: WorkflowJobJob, step: WorkflowStep) =>
	hashHex(`step:${runKey(job)}:${job.jobId}:${step.number}`, 16)
const queueSpanId = (job: WorkflowJobJob) => hashHex(`queue:${runKey(job)}:${job.jobId}`, 16)

/** Below this a job's wait for a runner is noise at GitHub's one-second resolution. */
const MIN_QUEUE_SPAN_MS = 1000
const MAX_ANNOTATION_MESSAGE_LENGTH = 1000
/** Annotation events per job span, failures first: the rest repeat what those say. */
const MAX_ANNOTATION_EVENTS = 20
/** The runner's own last word on any failed step; says nothing a real annotation would not. */
const GENERIC_EXIT_MESSAGE = /^Process completed with exit code \d+\.?$/

const truncate = (value: string, length: number) =>
	value.length > length ? `${value.slice(0, length)}...` : value

/**
 * A step name without the commit an action is pinned to: `Run jdx/mise-action@2d8d4caf...` is
 * `Run jdx/mise-action`, so a dependency bump does not split the step's history in two.
 */
export const ciStepName = (name: string) => name.replace(/@[0-9a-f]{7,40}\b/g, "")

/**
 * The annotation that best says why a job failed: a failure that names where it happened, then any
 * specific failure, and the runner's exit code only when there is nothing else.
 */
const failureReason = (annotations: ReadonlyArray<WorkflowJobAnnotation>) => {
	const failures = annotations.filter((annotation) => annotation.level === "failure")
	const specific = failures.filter((annotation) => !GENERIC_EXIT_MESSAGE.test(annotation.message))
	const reason =
		specific.find((annotation) => annotation.path !== null || annotation.title !== null) ??
		specific[0] ??
		failures[0]
	if (reason === undefined) return undefined
	const where =
		reason.path === null
			? ""
			: `${reason.path}${reason.startLine === null ? "" : `:${reason.startLine}`}: `
	return truncate(
		`${where}${reason.title === null ? "" : `${reason.title}: `}${reason.message}`,
		MAX_ANNOTATION_MESSAGE_LENGTH,
	)
}

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

/**
 * `error.type` for a failed run or task, which the conventions require on `failure` and `error`.
 * The result itself is the error's class: GitHub says no more than that it failed, timed out or
 * could not start.
 */
const errorTypeOf = (conclusion: string | null) =>
	statusOf(conclusion).code === STATUS_ERROR ? resultOf(conclusion) : undefined

export const attrs = (entries: Record<string, string | number | null | undefined>): OtlpKeyValue[] =>
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

/** The repository's web URL, from a run or job URL under it (`.../owner/repo/actions/runs/1`). */
const repositoryUrlOf = (url: string) => {
	// The last match: a repository may itself be named `actions` or `runs`.
	const actions = url.lastIndexOf("/actions/runs/")
	return actions === -1 ? undefined : url.slice(0, actions)
}

/** `sourceId` is the installation's pull source, stamped as `maple_source_id` when known. */
export const resourceOf = (repoFullName: string, url: string, sourceId?: string) => {
	const slash = repoFullName.indexOf("/")
	return attrs({
		"service.name": CI_SERVICE_NAME,
		"vcs.provider.name": "github",
		"vcs.owner.name": slash === -1 ? undefined : repoFullName.slice(0, slash),
		"vcs.repository.name": slash === -1 ? repoFullName : repoFullName.slice(slash + 1),
		"vcs.repository.url.full": repositoryUrlOf(url),
		[SOURCE_ID_ATTRIBUTE]: sourceId,
	})
}

const payloadOf = (
	repoFullName: string,
	url: string,
	sourceId: string | undefined,
	spans: ReadonlyArray<OtlpSpan>,
): OtlpTracesPayload => ({
	resourceSpans: [
		{
			resource: { attributes: resourceOf(repoFullName, url, sourceId) },
			scopeSpans: [{ scope: { name: SCOPE_NAME }, spans }],
		},
	],
})

const refAttrs = (headBranch: string | null, headSha: string | null) => ({
	"vcs.ref.head.name": headBranch,
	"vcs.ref.head.revision": headSha,
})

export const workflowRunToOtlp = (run: WorkflowRunJob, sourceId?: string): OtlpTracesPayload =>
	payloadOf(run.repoFullName, run.url, sourceId, [
		{
			traceId: ciTraceId(run),
			spanId: ciRunSpanId(run),
			parentSpanId: "",
			// `{action} {pipeline}`, a SERVER span: the conventions' shape for a pipeline run.
			name: `${PIPELINE_ACTION} ${run.workflowName}`,
			kind: SPAN_KIND_SERVER,
			startTimeUnixNano: unixNano(run.startedAtMs),
			endTimeUnixNano: unixNano(run.completedAtMs),
			attributes: attrs({
				"cicd.pipeline.name": run.workflowName,
				"cicd.pipeline.run.id": run.runId,
				"cicd.pipeline.run.url.full": run.url,
				"cicd.pipeline.result": resultOf(run.conclusion),
				"cicd.pipeline.action.name": PIPELINE_ACTION,
				"error.type": errorTypeOf(run.conclusion),
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

export const workflowJobToOtlp = (
	job: WorkflowJobJob,
	annotations: ReadonlyArray<WorkflowJobAnnotation>,
	sourceId?: string,
): OtlpTracesPayload => {
	const traceId = ciTraceId(job)
	const jobSpan = jobSpanId(job)
	const shared = {
		"cicd.pipeline.name": job.workflowName,
		"cicd.pipeline.run.id": job.runId,
		...refAttrs(job.headBranch, job.headSha),
		"maple.cicd.run_attempt": job.runAttempt,
	}
	const queueMs = job.startedAtMs - job.queuedAtMs
	// The job span covers its wait for a runner, so a waterfall shows where the time went.
	const queue: OtlpSpan[] =
		// A job skipped or cancelled before a runner picked it up never waited: it never ran.
		queueMs < MIN_QUEUE_SPAN_MS || job.startedAtMs === job.completedAtMs
			? []
			: [
					{
						traceId,
						spanId: queueSpanId(job),
						parentSpanId: jobSpan,
						name: "Waiting for a runner",
						kind: SPAN_KIND_INTERNAL,
						startTimeUnixNano: unixNano(job.queuedAtMs),
						endTimeUnixNano: unixNano(job.startedAtMs),
						attributes: attrs({
							...shared,
							"maple.cicd.job.name": job.name,
							"maple.cicd.queue_duration_ms": queueMs,
							"maple.cicd.runner_labels": job.labels.join(","),
						}),
						status: { code: STATUS_UNSET, message: "" },
					},
				]
	// A step is a task too, nested in its job's: its own name, an id unique in the run, and a link
	// to its line in the job's log.
	const steps = job.steps.map((step): OtlpSpan => ({
		traceId,
		spanId: stepSpanId(job, step),
		parentSpanId: jobSpan,
		name: ciStepName(step.name),
		kind: SPAN_KIND_INTERNAL,
		startTimeUnixNano: unixNano(step.startedAtMs),
		endTimeUnixNano: unixNano(step.completedAtMs),
		attributes: attrs({
			...shared,
			"cicd.pipeline.task.name": ciStepName(step.name),
			"cicd.pipeline.task.run.id": `${job.jobId}.${step.number}`,
			"cicd.pipeline.task.run.url.full":
				job.url === "" ? undefined : `${job.url}#step:${step.number}:1`,
			"cicd.pipeline.task.run.result": resultOf(step.conclusion),
			"error.type": errorTypeOf(step.conclusion),
			"maple.cicd.job.name": job.name,
			"maple.cicd.step.name": step.name,
			"maple.cicd.step.number": step.number,
		}),
		status: statusOf(step.conclusion),
	}))
	const status = statusOf(job.conclusion)
	const reason = status.code === STATUS_ERROR ? failureReason(annotations) : undefined
	const events = [
		...annotations.filter((annotation) => annotation.level === "failure"),
		...annotations.filter((annotation) => annotation.level !== "failure"),
	]
		.slice(0, MAX_ANNOTATION_EVENTS)
		.map((annotation): OtlpEvent => ({
			name: "cicd.annotation",
			timeUnixNano: unixNano(job.completedAtMs),
			attributes: attrs({
				"maple.cicd.annotation.level": annotation.level,
				"maple.cicd.annotation.title": annotation.title,
				"maple.cicd.annotation.message": truncate(annotation.message, MAX_ANNOTATION_MESSAGE_LENGTH),
				"code.file.path": annotation.path,
				"code.line.number": annotation.startLine,
			}),
		}))
	return payloadOf(job.repoFullName, job.url, sourceId, [
		{
			traceId,
			spanId: jobSpan,
			parentSpanId: ciRunSpanId(job),
			name: job.name,
			kind: SPAN_KIND_INTERNAL,
			startTimeUnixNano: unixNano(queue.length === 0 ? job.startedAtMs : job.queuedAtMs),
			endTimeUnixNano: unixNano(job.completedAtMs),
			attributes: attrs({
				...shared,
				"cicd.pipeline.task.name": job.name,
				"cicd.pipeline.task.run.id": job.jobId,
				"cicd.pipeline.task.run.url.full": job.url,
				"cicd.pipeline.task.run.result": resultOf(job.conclusion),
				"error.type": errorTypeOf(job.conclusion),
				"cicd.worker.name": job.runnerName,
				"maple.cicd.queue_duration_ms": queueMs,
				"maple.cicd.runner_labels": job.labels.join(","),
				"maple.cicd.failure.reason": reason,
			}),
			status: reason === undefined ? status : { code: STATUS_ERROR, message: reason },
			events,
		},
		...queue,
		...steps,
	])
}
