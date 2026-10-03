import { McpInvalidInputError, type McpToolRegistrar } from "./types"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { formatDurationFromMs, formatNumber, truncate } from "../lib/format"
import { toMcpQueryError } from "../lib/map-warehouse-error"
import * as P from "../lib/params"
import { doc, type DocBlock } from "../lib/tool-doc"
import { bucketLabels, PARTIAL_BUCKET_NOTE } from "../lib/format-query-result"
import { Effect, Schema } from "effect"
import { ErrorDetailOutput } from "@maple/domain/mcp-outputs"
import { ErrorIssueId } from "@maple/domain/http"
import { formatWarehouseDateTime, parseWarehouseDateTime } from "@maple/query-engine"
import { errorDetail } from "@maple/query-engine/observability"
import { provideWarehouseExecutorFromTenant } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { ErrorIssueWorkflowService } from "@maple/backend/services/errors/ErrorIssueWorkflowService"
import { persistenceFailed } from "./error-issue-shared"

const WINDOW = P.timeWindow({ defaultHours: 6 })

/** How far back a fingerprint is looked up when no window is given, to find its last occurrence. */
const ANCHOR_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000

/**
 * A FingerprintHash is a ClickHouse UInt64 rendered as a decimal string. An issue id is a
 * Postgres UUID, a different identity space; this tool accepts either and resolves the issue
 * to its fingerprint, because agents kept calling it with the id list_error_issues showed.
 */
const isFingerprintHash = (value: string): boolean => /^\d{1,20}$/.test(value)
const isUuid = (value: string): boolean =>
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)

const notAWarehouseError = (value: string, kind: string, parameter: string): McpInvalidInputError =>
	kind === "alert"
		? new McpInvalidInputError({
				message: `'${value}' is an alert issue, not an exception fingerprint: alerts have no sample traces here. Use list_alert_incidents to find its incident and get_incident_timeline for the timeline.`,
				parameter,
				example: "list_alert_incidents",
			})
		: new McpInvalidInputError({
				message: `'${value}' is a ${kind} issue (raised by a third-party webhook), not an exception fingerprint, so there are no sample traces. Use list_error_issue_events for its history.`,
				parameter,
			})

const rejectNonFingerprint = (rawFingerprint: string): McpInvalidInputError => {
	if (rawFingerprint.startsWith("alert:")) return notAWarehouseError(rawFingerprint, "alert", "fingerprint")
	if (/^[a-z][a-z0-9_-]*:/i.test(rawFingerprint))
		return notAWarehouseError(rawFingerprint, "integration", "fingerprint")
	return new McpInvalidInputError({
		message:
			`Invalid fingerprint: '${rawFingerprint}'. A fingerprint is a decimal number (a UInt64 hash), e.g. "11640295108927840024", not hex. ` +
			`Pass a full issue UUID from list_error_issues as issue_id instead; find_errors lists errors with their fingerprint.`,
		parameter: "fingerprint",
		example: 'error_detail fingerprint="11640295108927840024"',
	})
}

const decodeIssueId = Schema.decodeUnknownEffect(ErrorIssueId)

/** The fingerprint to read, from `fingerprint`, or from `issue_id` (or a UUID passed as fingerprint). */
const resolveTarget = Effect.fn("McpTool.errorDetail.resolveTarget")(function* (params: {
	readonly fingerprint?: string | undefined
	readonly issue_id?: string | undefined
}) {
	const rawFingerprint = params.fingerprint?.trim() ?? ""
	const rawIssue = params.issue_id?.trim() || (isUuid(rawFingerprint) ? rawFingerprint : "")
	if (rawIssue !== "") {
		const parameter = params.issue_id?.trim() ? "issue_id" : "fingerprint"
		const issueId = yield* decodeIssueId(rawIssue).pipe(
			Effect.mapError(
				() =>
					new McpInvalidInputError({
						message: `Invalid issue_id '${rawIssue}': an issue id is the full UUID from list_error_issues.`,
						parameter,
					}),
			),
		)
		const tenant = yield* CurrentMcpTenant
		const workflow = yield* ErrorIssueWorkflowService
		const issue = yield* workflow.requireIssue(tenant.orgId, issueId).pipe(
			Effect.catchTags({
				"@maple/http/errors/ErrorIssueNotFoundError": () =>
					Effect.fail(
						new McpInvalidInputError({
							message: `No error issue with id '${rawIssue}' in this org. A UUID is read as an issue id from list_error_issues; a fingerprint is a decimal number from find_errors.`,
							parameter,
						}),
					),
				"@maple/http/errors/ErrorPersistenceError": persistenceFailed("error_detail"),
			}),
		)
		if (issue.kind !== "error" || !isFingerprintHash(issue.fingerprintHash))
			return yield* notAWarehouseError(
				rawIssue,
				issue.kind === "error" ? "integration" : issue.kind,
				parameter,
			)
		return { fingerprint: issue.fingerprintHash, issueId: rawIssue }
	}
	if (rawFingerprint === "")
		return yield* new McpInvalidInputError({
			message:
				"Pass `fingerprint` (a decimal UInt64 from find_errors) or `issue_id` (a UUID from list_error_issues).",
			parameter: "fingerprint",
			example: 'error_detail fingerprint="11640295108927840024"',
		})
	if (!isFingerprintHash(rawFingerprint)) return yield* rejectNonFingerprint(rawFingerprint)
	return { fingerprint: rawFingerprint, issueId: undefined }
})

type Output = typeof ErrorDetailOutput.Type
type Trace = Output["traces"][number]

const NO_EXCEPTION =
	"no exception recorded: the span set status Error without an exception event or status message"

const errorIdentityLine = (error: NonNullable<Output["error"]>): string => {
	const detail = error.message === "" ? "" : `: ${truncate(error.message, 120)}`
	const service = error.serviceName === "" ? "" : ` (${error.serviceName})`
	return `${error.label || error.exceptionType || "Error"}${detail}${service}`
}

/** Routes (or span names) the sampled occurrences failed on, most frequent first. */
const topRoutes = (traces: ReadonlyArray<Trace>): string => {
	const counts = new Map<string, number>()
	for (const trace of traces) {
		const span = trace.errorSpan
		if (span === undefined) continue
		const attrs = span.attributes
		const route = attrs["http.route"] ?? span.name
		const key = [attrs["http.request.method"], route, attrs["http.response.status_code"]]
			.filter((part) => part !== undefined && part !== "")
			.join(" ")
		if (key !== "") counts.set(key, (counts.get(key) ?? 0) + 1)
	}
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 3)
		.map(([route, n]) => `${route} (${n})`)
		.join(", ")
}

const summaryBlock = (output: Output): DocBlock | undefined => {
	const summary = output.summary
	const error = output.error
	if (summary === undefined && error === undefined) return undefined
	const extraServices = summary === undefined ? 0 : summary.serviceCount - summary.services.length
	const routes = topRoutes(output.traces)
	return doc.fields([
		["Exception", error === undefined ? undefined : error.exceptionType || "none recorded"],
		["Message", error === undefined ? undefined : error.message || NO_EXCEPTION],
		[
			"Services",
			summary === undefined
				? error?.serviceName || undefined
				: `${summary.services.join(", ")}${extraServices > 0 ? ` (+${extraServices} more)` : ""}`,
		],
		[
			"Occurrences",
			summary === undefined
				? undefined
				: `${formatNumber(summary.occurrences)} between ${summary.timeRange.start} and ${summary.timeRange.end}`,
		],
		[
			"Without exception",
			summary === undefined || summary.noExceptionCount === 0
				? undefined
				: `${formatNumber(summary.noExceptionCount)} of ${formatNumber(summary.occurrences)}`,
		],
		["First seen", summary?.firstSeen],
		["Last seen", summary?.lastSeen],
		["Top routes", routes === "" ? undefined : `${routes} (in ${output.traces.length} samples)`],
	])
}

const traceBlocks =
	(fallbackMessage: string) =>
	(trace: Trace, index: number): Array<DocBlock> => {
		const span = trace.errorSpan
		const message = (span?.statusMessage ?? "") || trace.errorMessage || fallbackMessage || NO_EXCEPTION
		const blocks: Array<DocBlock> = [
			doc.heading(`Trace ${index + 1}: ${trace.traceId}`),
			doc.fields([
				["Root span", trace.rootSpanName],
				["Duration", formatDurationFromMs(trace.durationMs)],
				["Spans", trace.spanCount],
				["Services", trace.services.join(", ")],
				["Time", trace.startTime],
				// The span this fingerprint's occurrence belongs to: a trace usually carries other
				// failing spans (the callers the error propagated through), and those are not it.
				[
					"Error span (this fingerprint)",
					span === undefined ? undefined : `${span.name} (${span.serviceName}) span=${span.spanId}`,
				],
				["Error", `"${truncate(message, 160)}"`],
			]),
		]
		const attrs = Object.entries(span?.attributes ?? {})
		if (attrs.length > 0) {
			blocks.push(
				doc.text(
					`Error span attributes: {${attrs.map(([k, v]) => `${k}=${truncate(v, 60)}`).join(", ")}}`,
				),
			)
		}
		if (trace.logs.length > 0) {
			blocks.push(
				doc.text(
					[
						`Logs (${trace.logs.length}, error-level first):`,
						...trace.logs.map((log) => {
							const time = log.timestamp.split(" ")[1] ?? log.timestamp
							return `  ${time} [${log.severityText.padEnd(5)}] ${truncate(log.body, 90)}`
						}),
					].join("\n"),
				),
			)
		}
		return blocks
	}

const relatedBlocks = (output: Output): Array<DocBlock> => {
	const related = output.related ?? []
	if (related.length === 0) return []
	return [
		doc.heading("Also failing in these traces"),
		doc.text(
			"Fingerprints raised in the same sampled traces. One that appears in every trace is usually the same failure counted twice (a wrapper and its cause).",
		),
		doc.table(
			["Fingerprint", "Error", "Service", "Traces"],
			related.map((r) => [
				r.fingerprintHash,
				truncate(r.label, 60),
				r.serviceName,
				`${r.traces} of ${output.traces.length}`,
			]),
		),
	]
}

export function registerErrorDetailTool(server: McpToolRegistrar) {
	server.define({
		name: "error_detail",
		title: "Error Detail",
		description:
			"One error: what it is (exception, message, services, count, first/last seen), sample traces with the failing span, and correlated logs. Takes a `fingerprint` (decimal UInt64 from find_errors) or an `issue_id` (UUID from list_error_issues). Without a window it reads around the error's last occurrence. Use inspect_trace on a trace_id for the full span tree.",
		parameters: Schema.Struct({
			fingerprint: P.optionalText(
				'The error FingerprintHash from find_errors or list_error_issues: a decimal UInt64 string, e.g. "11640295108927840024".',
			),
			issue_id: P.optionalText(
				"An error issue id (UUID) from list_error_issues, instead of fingerprint.",
			),
			...WINDOW.fields,
			service: P.service(),
			include_timeseries: P.optionalFlag(
				"Include error count over time to see if the error is trending up or down",
			),
			limit: P.limit({ default: 5, max: 20, noun: "sample traces" }),
		}),
		aliases: P.SERVICE_ALIASES,
		output: ErrorDetailOutput,
		hints: { readOnly: true },
		phrases: ["Reading error details", "Looking into an error"],
		handler: Effect.fn("McpTool.errorDetail")(function* (params) {
			const target = yield* resolveTarget(params)
			const { st, et } = yield* WINDOW.resolve(params, "error_detail")
			const tenant = yield* CurrentMcpTenant
			// No window given: read the error's last 30 days and sample around its last occurrence.
			const anchorWithin =
				params.start_time === undefined && params.end_time === undefined
					? {
							startTime: formatWarehouseDateTime(
								parseWarehouseDateTime(et) - ANCHOR_LOOKBACK_MS,
							),
							endTime: et,
						}
					: undefined

			const result = yield* errorDetail({
				fingerprintHash: target.fingerprint,
				timeRange: { startTime: st, endTime: et },
				anchorWithin,
				service: params.service,
				includeTimeseries: params.include_timeseries ?? false,
				limit: params.limit,
			}).pipe(
				provideWarehouseExecutorFromTenant(tenant),
				Effect.mapError(toMcpQueryError("error_detail_traces")),
			)

			const summary = result.summary
			return {
				timeRange: { start: result.timeRange.startTime, end: result.timeRange.endTime },
				fingerprintHash: target.fingerprint,
				...(target.issueId === undefined ? undefined : { issueId: target.issueId }),
				...(result.error === undefined ? undefined : { error: result.error }),
				...(summary === undefined
					? undefined
					: {
							summary: {
								timeRange: {
									start: summary.timeRange.startTime,
									end: summary.timeRange.endTime,
								},
								occurrences: summary.occurrences,
								firstSeen: summary.firstSeen,
								lastSeen: summary.lastSeen,
								services: summary.services,
								serviceCount: summary.serviceCount,
								noExceptionCount: summary.noExceptionCount,
							},
						}),
				...(result.anchored === true ? { anchored: true } : undefined),
				...(result.related === undefined || result.related.length === 0
					? undefined
					: { related: result.related }),
				traces: result.traces.map((t) => ({
					traceId: t.traceId,
					rootSpanName: t.rootSpanName,
					durationMs: t.durationMs,
					spanCount: t.spanCount,
					services: t.services,
					startTime: t.startTime,
					...(t.errorMessage ? { errorMessage: t.errorMessage } : undefined),
					...(t.errorSpan === undefined ? undefined : { errorSpan: t.errorSpan }),
					logs: t.logs,
				})),
				...(result.timeseries === undefined ? undefined : { timeseries: result.timeseries }),
				...(params.service === undefined ? undefined : { service: params.service }),
			}
		}),
		render: (output) => {
			const window = `${output.timeRange.start} to ${output.timeRange.end}`
			const scope: ReadonlyArray<readonly [string, string | undefined]> = [
				["Error", output.error === undefined ? undefined : errorIdentityLine(output.error)],
				["Issue", output.issueId],
				[
					"Sample window",
					output.anchored === true ? `${window} (ending at the last occurrence)` : window,
				],
				["Service", output.service],
			]
			const title = `Error Detail: fingerprint ${output.fingerprintHash}`
			const summary = summaryBlock(output)
			// The service the error belongs to, so the log search is not an org-wide `service=""`.
			const logService =
				output.service ||
				output.error?.serviceName ||
				output.traces.find((t) => t.errorSpan !== undefined)?.errorSpan?.serviceName ||
				undefined
			const logSearch = doc.next(
				"search_logs",
				{
					service: logService,
					severity: "ERROR",
					start_time: output.timeRange.start,
					end_time: output.timeRange.end,
				},
				"error logs from the same service and window",
			)
			if (output.traces.length === 0) {
				if (summary === undefined) {
					return {
						title,
						scope,
						blocks: [],
						empty: {
							message: `No occurrences of error fingerprint "${output.fingerprintHash}" between ${output.timeRange.start} and ${output.timeRange.end}.`,
							hints: [
								"A fingerprint changes when the error's type, top frames or message shape change. Run find_errors (or list_error_issues) for current fingerprints.",
								"Widen start_time/end_time, or drop the service filter.",
							],
						},
					}
				}
				return {
					title,
					scope,
					blocks: [
						summary,
						doc.text(
							`No sample traces in ${window}: the spans behind these occurrences are no longer in trace storage, or fell outside this window. Pass start_time/end_time around the last-seen time to sample a specific period.`,
						),
					],
					next: [logSearch],
				}
			}
			const trend = output.timeseries ?? []
			const trendLabels = bucketLabels(
				trend.map((point) => point.bucket),
				output.timeRange.end,
			)
			return {
				title,
				scope,
				blocks: [
					...(summary === undefined ? [] : [summary]),
					doc.text(`Sample traces: ${output.traces.length}`),
					...output.traces.flatMap(traceBlocks(output.error?.message ?? "")),
					...relatedBlocks(output),
					...(trend.length === 0
						? []
						: [
								doc.heading("Error Trend"),
								doc.text(
									trend
										.map(
											(point, i) =>
												`${trendLabels.labels[i] ?? point.bucket}: ${point.count} errors`,
										)
										.join("\n"),
								),
								...(trendLabels.lastIsPartial ? [doc.text(PARTIAL_BUCKET_NOTE)] : []),
							]),
				],
				next: [
					...output.traces
						.slice(0, 3)
						.map((t) =>
							t.errorSpan === undefined
								? doc.next(
										"inspect_trace",
										{ trace_id: t.traceId, errors_only: true },
										"the failing spans only",
									)
								: doc.next(
										"inspect_span",
										{ trace_id: t.traceId, span_id: t.errorSpan.spanId },
										"the failing span's full attributes",
									),
						),
					...(output.related ?? [])
						.slice(0, 1)
						.map((r) =>
							doc.next(
								"error_detail",
								{ fingerprint: r.fingerprintHash },
								`the other error in these traces ("${truncate(r.label, 40)}")`,
							),
						),
					logSearch,
				],
			}
		},
	})
}
