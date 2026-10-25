/**
 * A finished CI job's log as OTLP/HTTP JSON log records on the job's trace. The runner stamps
 * every line, and the stamp places the line in the step that was running then, so each record
 * links to its step span and a step's output sits beside it in the trace.
 *
 * Step times come from the API in whole seconds, so several steps can share the second a line was
 * stamped in. Lines are read in order and only ever move forward through the steps that ran; within
 * a shared second, the line that opens a step of the next step's kind is what moves them on.
 */
import type { WorkflowJobJob } from "@maple/domain/http"
import { Stream } from "effect"
import { timestampMs } from "@maple/backend/platform/time"
import {
	type OtlpKeyValue,
	SCOPE_NAME,
	attrs,
	ciStepName,
	ciTraceId,
	jobSpanId,
	resourceOf,
	stepSpanId,
} from "./otlp"

export interface OtlpLogRecord {
	readonly timeUnixNano: string
	readonly severityNumber: number
	readonly severityText: string
	readonly body: { readonly stringValue: string }
	readonly attributes: ReadonlyArray<OtlpKeyValue>
	readonly traceId: string
	readonly spanId: string
}

export interface OtlpLogsPayload {
	readonly resourceLogs: ReadonlyArray<{
		readonly resource: { readonly attributes: ReadonlyArray<OtlpKeyValue> }
		readonly scopeLogs: ReadonlyArray<{
			readonly scope: { readonly name: string }
			readonly logRecords: ReadonlyArray<OtlpLogRecord>
		}>
	}>
}

/** Log text kept per job. A longer log stops here, with a record that says so. */
export const MAX_JOB_LOG_CHARS = 5_000_000
const MAX_LINE_CHARS = 8_000

const SEVERITY_DEBUG = { severityNumber: 5, severityText: "DEBUG" }
const SEVERITY_INFO = { severityNumber: 9, severityText: "INFO" }
const SEVERITY_WARN = { severityNumber: 13, severityText: "WARN" }
const SEVERITY_ERROR = { severityNumber: 17, severityText: "ERROR" }

/** `2024-05-01T12:00:00.1234567Z text`: the runner's stamp, to 100ns, then the line. */
const STAMPED_LINE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z ?(.*)$/s
/**
 * The runner's markers, `##[error]` and the like. `::error::` workflow commands are written to the
 * log in this form too.
 */
const MARKER = /^##\[(error|warning|notice|debug|group|command)\]/
// oxlint-disable-next-line no-control-regex -- ANSI color codes are control characters by definition.
const ANSI_ESCAPE = /\u001b\[[0-9;?]*[A-Za-z]/g
/** The runner's first line of a step. Composite actions repeat some of these inside one step. */
const RUN_STEP_HEADER =
	/^(?:##\[group\]Run |##\[group\]Checking docker version|Prepare all required actions|Waiting for background step|Print service container logs|Evaluate and set job outputs)/

type StepKind = "setup" | "run" | "post" | "complete"

const headerKind = (text: string): StepKind | undefined => {
	if (text.startsWith("Current runner version")) return "setup"
	if (text.startsWith("Post job cleanup.")) return "post"
	if (text.startsWith("Cleaning up orphan processes")) return "complete"
	return RUN_STEP_HEADER.test(text) ? "run" : undefined
}

const severityOf = (marker: string | undefined) => {
	switch (marker) {
		case "error":
			return SEVERITY_ERROR
		case "warning":
			return SEVERITY_WARN
		case "debug":
			return SEVERITY_DEBUG
		default:
			return SEVERITY_INFO
	}
}

interface Stamp {
	readonly unixNano: string
	readonly ms: number
}

const stampOf = (date: string, fraction: string | undefined): Stamp | undefined => {
	const seconds = timestampMs(`${date}Z`) / 1000
	if (!Number.isFinite(seconds)) return undefined
	const nanos = (fraction ?? "").padEnd(9, "0")
	return { unixNano: `${seconds}${nanos}`, ms: seconds * 1000 + Number(nanos.slice(0, 3)) }
}

interface ReaderState {
	readonly chars: number
	readonly stamp: Stamp
	/** Index into the steps that ran; -1 before the first. */
	readonly step: number
	/** Lines kept on `step` so far. */
	readonly stepLines: number
}

interface Entry {
	readonly record: OtlpLogRecord
	/** The last record: the log ran past `MAX_JOB_LOG_CHARS` and reading stops after it. */
	readonly last: boolean
}

/**
 * The job's log lines as records, in order. Lines without a stamp take the previous line's; the
 * `##[endgroup]` markers and blank lines are dropped. Reading stops at `MAX_JOB_LOG_CHARS`, which
 * also stops pulling from `lines`.
 */
export const jobLogRecords = <E, R>(
	job: WorkflowJobJob,
	lines: Stream.Stream<string, E, R>,
): Stream.Stream<OtlpLogRecord, E, R> => {
	const traceId = ciTraceId(job)
	const jobSpan = jobSpanId(job)
	// The runner names a post step after its step, so "Post …" alone is not one.
	const stepNames = new Set(job.steps.map((step) => step.name))
	const stepKind = (name: string): StepKind => {
		if (name === "Set up job") return "setup"
		if (name === "Complete job") return "complete"
		return name.startsWith("Post ") && stepNames.has(name.slice(5)) ? "post" : "run"
	}
	// A skipped step prints nothing, though the API stamps it with the next step's start.
	const steps = job.steps
		.filter((step) => step.conclusion !== "skipped")
		.toSorted((a, b) => a.number - b.number)
		.map((step) => ({ step, spanId: stepSpanId(job, step), kind: stepKind(step.name) }))
	const shared = {
		"cicd.pipeline.name": job.workflowName,
		"cicd.pipeline.run.id": job.runId,
		"vcs.ref.head.name": job.headBranch,
		"vcs.ref.head.revision": job.headSha,
		"maple.cicd.job.name": job.name,
		"maple.cicd.run_attempt": job.runAttempt,
	}

	/** The step a line stamped at `stamp` belongs to, never one before `state.step`. */
	const stepOf = (state: ReaderState, stamp: Stamp, text: string) => {
		const second = Math.floor(stamp.ms / 1000) * 1000
		// Past a step once the next one started in an earlier second, or this one ended in one.
		const advance = (index: number): number => {
			const current = steps[index]?.step
			const next = steps[index + 1]?.step
			if (next === undefined || next.startedAtMs > second) return index
			const past = current === undefined || next.startedAtMs < second || current.completedAtMs < second
			return past ? advance(index + 1) : index
		}
		const index = advance(state.step)
		const next = steps[index + 1]
		const opensNext =
			index === state.step &&
			state.stepLines > 0 &&
			next !== undefined &&
			next.step.startedAtMs <= second &&
			headerKind(text) === next.kind
		return opensNext ? index + 1 : index
	}

	const recordAt = (
		step: number,
		stamp: Stamp,
		severity: { readonly severityNumber: number; readonly severityText: string },
		body: string,
	): OtlpLogRecord => {
		const owner = steps[step]
		return {
			timeUnixNano: stamp.unixNano,
			...severity,
			body: { stringValue: body },
			attributes: attrs({
				...shared,
				// The same task the record's span names, so logs and spans join on it.
				"cicd.pipeline.task.name": owner === undefined ? job.name : ciStepName(owner.step.name),
				"cicd.pipeline.task.run.id":
					owner === undefined ? job.jobId : `${job.jobId}.${owner.step.number}`,
				"maple.cicd.step.number": owner?.step.number,
			}),
			traceId,
			spanId: owner?.spanId ?? jobSpan,
		}
	}

	const read = (state: ReaderState, raw: string): readonly [ReaderState, ReadonlyArray<Entry>] => {
		const stamped = STAMPED_LINE.exec(raw.replace(/^﻿/, ""))
		const stamp = (stamped === null ? undefined : stampOf(stamped[1] ?? "", stamped[2])) ?? state.stamp
		const text = (stamped === null ? raw : (stamped[3] ?? "")).replace(ANSI_ESCAPE, "").trimEnd()
		if (text === "" || text === "##[endgroup]") return [{ ...state, stamp }, []]
		const step = stepOf(state, stamp, text)
		const stepLines = step === state.step ? state.stepLines + 1 : 1
		const marker = MARKER.exec(text)
		const body = marker === null ? text : text.slice(marker[0].length)
		const clipped = body.length > MAX_LINE_CHARS ? `${body.slice(0, MAX_LINE_CHARS)}...` : body
		const chars = state.chars + clipped.length
		if (chars > MAX_JOB_LOG_CHARS) {
			const notice = recordAt(
				step,
				stamp,
				SEVERITY_WARN,
				`Log truncated: Maple keeps the first ${MAX_JOB_LOG_CHARS / 1_000_000} MB of a job's log. The full log is at ${job.url}`,
			)
			return [{ chars, stamp, step, stepLines }, [{ record: notice, last: true }]]
		}
		return [
			{ chars, stamp, step, stepLines },
			[{ record: recordAt(step, stamp, severityOf(marker?.[1]), clipped), last: false }],
		]
	}

	const start: Stamp = { unixNano: `${Math.trunc(job.startedAtMs)}000000`, ms: job.startedAtMs }
	return lines.pipe(
		Stream.mapAccum((): ReaderState => ({ chars: 0, stamp: start, step: -1, stepLines: 0 }), read),
		Stream.takeUntil((entry) => entry.last),
		Stream.map((entry) => entry.record),
	)
}

export const workflowJobLogsToOtlp = (
	job: WorkflowJobJob,
	records: ReadonlyArray<OtlpLogRecord>,
	sourceId?: string,
): OtlpLogsPayload => ({
	resourceLogs: [
		{
			resource: { attributes: resourceOf(job.repoFullName, job.url, sourceId) },
			scopeLogs: [{ scope: { name: SCOPE_NAME }, logRecords: records }],
		},
	],
})
