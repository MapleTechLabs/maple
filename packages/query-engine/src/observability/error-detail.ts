import { Array as Arr, Effect, pipe } from "effect"
import type { ErrorsTimeseriesOutput, ListLogsOutput } from "@maple/domain/tinybird"
import type { ErrorDetailTracesOutput } from "../ch/queries/errors"
import { parseWarehouseDateTime, formatWarehouseDateTime } from "../datetime"
import * as CH from "../ch"
import { WarehouseExecutor } from "./WarehouseExecutor"
import { isUnlabelledError, spanErrorLabel } from "./fingerprint-labels"
import type { TimeRange } from "./types"

const LOG_WINDOW_HALF_WIDTH_MS = 60 * 60 * 1000

/**
 * ±1h window around a trace's start time. A trace's logs share its timestamps,
 * so bounding `list_logs` lets ClickHouse prune partitions — without a range,
 * pipe-dispatch falls back to an all-time sentinel window (2023→2099) and the
 * lookup scans full retention (mined at p95 ~5s on busy orgs).
 */
const logRangeAround = (traceStartTime: string): { start_time: string; end_time: string } | undefined => {
	const ms = parseWarehouseDateTime(traceStartTime)
	if (Number.isNaN(ms)) return undefined
	return {
		start_time: formatWarehouseDateTime(ms - LOG_WINDOW_HALF_WIDTH_MS),
		end_time: formatWarehouseDateTime(ms + LOG_WINDOW_HALF_WIDTH_MS),
	}
}

/** The span that failed, with the handful of attributes that identify what it was doing. */
export interface ErrorDetailSpan {
	readonly spanId: string
	readonly name: string
	readonly serviceName: string
	readonly statusMessage: string
	readonly attributes: Readonly<Record<string, string>>
}

export interface ErrorDetailTrace {
	readonly traceId: string
	readonly rootSpanName: string
	readonly durationMs: number
	readonly spanCount: number
	readonly services: readonly string[]
	readonly startTime: string
	readonly errorMessage: string
	readonly errorSpan: ErrorDetailSpan | undefined
	readonly logs: ReadonlyArray<{ timestamp: string; severityText: string; body: string }>
}

const errorSpanOf = (t: ErrorDetailTracesOutput): ErrorDetailSpan | undefined => {
	if (!t.errorSpanId) return undefined
	const attributes: Record<string, string> = {}
	const attr = (key: string, value: string | undefined) => {
		if (value) attributes[key] = value
	}
	attr("gen_ai.request.model", t.errorModel)
	attr("gen_ai.tool.name", t.errorToolName)
	attr("http.request.method", t.errorHttpMethod)
	attr("http.route", t.errorHttpRoute)
	attr("http.response.status_code", t.errorHttpStatus)
	attr("query.context", t.errorQueryContext)
	attr("error.type", t.errorType)
	return {
		spanId: t.errorSpanId,
		name: t.errorSpanName ?? "",
		serviceName: t.errorServiceName ?? "",
		statusMessage: t.errorMessage ?? "",
		attributes,
	}
}

/** The error a fingerprint stands for, as its most recent sampled occurrence recorded it. */
export interface ErrorDetailIdentity {
	readonly label: string
	readonly exceptionType: string
	readonly message: string
	readonly serviceName: string
}

/** The fingerprint across its whole lookback, from error_events alone. */
export interface ErrorDetailSummary {
	readonly timeRange: TimeRange
	readonly occurrences: number
	readonly firstSeen: string
	readonly lastSeen: string
	readonly services: readonly string[]
	readonly serviceCount: number
	/** Occurrences that recorded no exception: a span with status Error and nothing else. */
	readonly noExceptionCount: number
}

/** Another fingerprint raised in the same sampled traces, e.g. the cause a wrapper wraps. */
export interface ErrorDetailRelated {
	readonly fingerprintHash: string
	readonly label: string
	readonly serviceName: string
	readonly traces: number
}

export interface ErrorDetailOutput {
	readonly fingerprintHash: string
	readonly timeRange: TimeRange
	readonly summary?: ErrorDetailSummary
	/** True when the sample window was moved to end at the fingerprint's last occurrence. */
	readonly anchored?: boolean
	readonly related?: ReadonlyArray<ErrorDetailRelated>
	/** Absent when no sampled trace was found in the window. */
	readonly error?: ErrorDetailIdentity
	readonly traces: ReadonlyArray<ErrorDetailTrace>
	readonly timeseries?: ReadonlyArray<{ bucket: string; count: number }>
}

/** "{}" is what some SDKs put in a status message when they had nothing to say. */
const meaningful = (text: string | undefined): string => {
	const trimmed = (text ?? "").trim()
	return trimmed === "{}" || trimmed === "[]" || trimmed === "null" ? "" : trimmed
}

interface SummaryIdentity {
	readonly errorLabel: string
	readonly exceptionType: string
	readonly exceptionMessage: string
	readonly statusMessage: string
	readonly services: readonly string[]
}

/** Newest sampled occurrence first, then the error_events summary for whatever it lacks. */
const identityOf = (
	head: ErrorDetailTracesOutput | undefined,
	summary: SummaryIdentity | undefined,
): ErrorDetailIdentity | undefined => {
	if (head === undefined && summary === undefined) return undefined
	const label =
		head?.errorLabel || summary?.errorLabel || head?.exceptionType || summary?.exceptionType || ""
	const spanLabel =
		head === undefined
			? ""
			: spanErrorLabel({
					spanName: head.errorSpanName ?? "",
					httpMethod: head.errorHttpMethod ?? "",
					httpRoute: head.errorHttpRoute ?? "",
					httpStatus: head.errorHttpStatus ?? "",
				})
	return {
		label: isUnlabelledError(label) && spanLabel !== "" ? spanLabel : label,
		exceptionType: head?.exceptionType || summary?.exceptionType || "",
		message:
			meaningful(head?.exceptionMessage) ||
			meaningful(head?.errorMessage) ||
			meaningful(summary?.exceptionMessage) ||
			meaningful(summary?.statusMessage),
		serviceName: head?.errorServiceName || summary?.services[0] || "",
	}
}

const SEVERITY_RANK: ReadonlyMap<string, number> = new Map([
	["FATAL", 0],
	["ERROR", 1],
	["WARN", 2],
	["WARNING", 2],
])
const severityRank = (severity: string): number => SEVERITY_RANK.get(severity.toUpperCase()) ?? 3

/** Error-level logs first (then newest first): a trace's last Info line is rarely the clue. */
export const errorFirstLogs = <L extends { readonly severityText: string; readonly timestamp: string }>(
	logs: ReadonlyArray<L>,
): ReadonlyArray<L> =>
	[...logs].sort(
		(a, b) =>
			severityRank(a.severityText) - severityRank(b.severityText) ||
			(a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0),
	)

const ANCHOR_SLACK_MS = 60 * 1000
const RELATED_SLACK_MS = 5 * 60 * 1000

/** The same width as `range`, ending just after `lastSeen`. */
const rangeEndingAt = (range: TimeRange, lastSeen: string): TimeRange | undefined => {
	const lastMs = parseWarehouseDateTime(lastSeen)
	const width = parseWarehouseDateTime(range.endTime) - parseWarehouseDateTime(range.startTime)
	if (Number.isNaN(lastMs) || Number.isNaN(width)) return undefined
	return {
		startTime: formatWarehouseDateTime(lastMs - width),
		endTime: formatWarehouseDateTime(lastMs + ANCHOR_SLACK_MS),
	}
}

export const errorDetail = Effect.fn("Observability.errorDetail")(function* (input: {
	readonly fingerprintHash: string
	readonly timeRange: TimeRange
	/**
	 * When set, the summary reads this (longer) range and the samples move to a window of
	 * `timeRange`'s width ending at the last occurrence: a default "last 6h" missed every
	 * fingerprint that had gone quiet, and agents read that as "no traces".
	 */
	readonly anchorWithin?: TimeRange
	readonly service?: string
	readonly includeTimeseries?: boolean
	readonly limit?: number
}) {
	const executor = yield* WarehouseExecutor
	const limit = input.limit ?? 5

	yield* Effect.annotateCurrentSpan({
		fingerprintHash: input.fingerprintHash,
		service: input.service ?? "all",
	})

	const summaryRange = input.anchorWithin ?? input.timeRange
	const summaryRows = yield* executor.compiledQuery(
		CH.compile(
			CH.errorFingerprintSummaryQuery({
				fingerprintHash: input.fingerprintHash,
				services: input.service ? [input.service] : undefined,
			}),
			{ orgId: executor.orgId, startTime: summaryRange.startTime, endTime: summaryRange.endTime },
		),
		{ profile: "list", context: "errorFingerprintSummary" },
	)
	const summaryRow = summaryRows.find((row) => row.occurrences > 0)
	const anchoredRange =
		input.anchorWithin !== undefined && summaryRow !== undefined
			? rangeEndingAt(input.timeRange, summaryRow.lastSeen)
			: undefined
	const sampleRange = anchoredRange ?? input.timeRange
	yield* Effect.annotateCurrentSpan({
		"maple.error_detail.occurrences": summaryRow?.occurrences ?? 0,
		"maple.error_detail.anchored": anchoredRange !== undefined,
	})

	const tracesResult = yield* executor.query<ErrorDetailTracesOutput>(
		"error_detail_traces",
		{
			fingerprint_hash: input.fingerprintHash,
			start_time: sampleRange.startTime,
			end_time: sampleRange.endTime,
			...(input.service && { services: input.service }),
			limit,
		},
		{ profile: "list" },
	)

	const traces = tracesResult.data
	yield* Effect.annotateCurrentSpan("traceCount", traces.length)

	const logsResults = yield* pipe(
		traces,
		Arr.take(3),
		Effect.forEach(
			(t) =>
				executor.query<ListLogsOutput>(
					"list_logs",
					{
						trace_id: t.traceId,
						// Wider than the 5 shown, so error-level lines can be picked out of it.
						limit: 20,
						...(logRangeAround(t.startTime) ?? {
							start_time: sampleRange.startTime,
							end_time: sampleRange.endTime,
						}),
					},
					{ profile: "list" },
				),
			{ concurrency: "unbounded" },
		),
	)

	const related = yield* relatedFingerprints(input.fingerprintHash, traces)

	const timeseries = input.includeTimeseries
		? yield* executor
				.query<ErrorsTimeseriesOutput>(
					"errors_timeseries",
					{
						fingerprint_hash: input.fingerprintHash,
						start_time: sampleRange.startTime,
						end_time: sampleRange.endTime,
						...(input.service && { services: input.service }),
					},
					{ profile: "aggregation" },
				)
				.pipe(
					Effect.map((r) =>
						pipe(
							r.data,
							Arr.map((p) => ({ bucket: String(p.bucket), count: Number(p.count) })),
						),
					),
				)
		: undefined

	const summary: ErrorDetailSummary | undefined =
		summaryRow === undefined
			? undefined
			: {
					timeRange: summaryRange,
					occurrences: summaryRow.occurrences,
					firstSeen: summaryRow.firstSeen,
					lastSeen: summaryRow.lastSeen,
					services: summaryRow.services,
					serviceCount: summaryRow.serviceCount,
					noExceptionCount: summaryRow.noExceptionCount,
				}

	return {
		fingerprintHash: input.fingerprintHash,
		timeRange: sampleRange,
		summary,
		anchored: anchoredRange !== undefined,
		related,
		error: identityOf(traces[0], summaryRow),
		traces: pipe(
			traces,
			Arr.map((t, i): ErrorDetailTrace => ({
				traceId: t.traceId,
				rootSpanName: t.rootSpanName,
				// No `Number(...)` / `String(...)`: the row already decoded through
				// the compiled query's schema, which is what coerces the wire form.
				durationMs: t.durationMicros / 1000,
				spanCount: t.spanCount,
				services: t.services,
				startTime: t.startTime,
				errorMessage: t.errorMessage ?? "",
				errorSpan: errorSpanOf(t),
				logs: pipe(
					errorFirstLogs(
						(logsResults[i]?.data ?? []).map((l) => ({
							timestamp: String(l.timestamp),
							severityText: l.severityText || "INFO",
							body: l.body,
						})),
					),
					Arr.take(5),
				),
			})),
		),
		timeseries,
	}
})

/** Fingerprints that fired inside the sampled traces too, read over just those traces' span. */
const relatedFingerprints = Effect.fn("Observability.errorDetail.related")(function* (
	fingerprintHash: string,
	traces: ReadonlyArray<ErrorDetailTracesOutput>,
) {
	if (traces.length === 0) return []
	const starts = traces.map((t) => parseWarehouseDateTime(t.startTime)).filter((ms) => !Number.isNaN(ms))
	if (starts.length === 0) return []
	const maxDurationMs = Math.max(...traces.map((t) => t.durationMicros / 1000))
	const executor = yield* WarehouseExecutor
	const rows = yield* executor.compiledQuery(
		CH.compile(
			CH.errorCooccurringFingerprintsQuery({
				fingerprintHash,
				traceIds: traces.map((t) => t.traceId),
			}),
			{
				orgId: executor.orgId,
				startTime: formatWarehouseDateTime(Math.min(...starts) - RELATED_SLACK_MS),
				endTime: formatWarehouseDateTime(Math.max(...starts) + maxDurationMs + RELATED_SLACK_MS),
			},
		),
		{ profile: "list", context: "errorCooccurringFingerprints" },
	)
	return rows.map((row): ErrorDetailRelated => ({
		fingerprintHash: row.fingerprintHash,
		label: row.errorLabel,
		serviceName: row.serviceName,
		traces: row.traces,
	}))
})
