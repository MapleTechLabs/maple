import { McpInvalidInputError, type McpToolRegistrar } from "./types"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { formatDurationFromMs, truncate } from "../lib/format"
import { toMcpQueryError } from "../lib/map-warehouse-error"
import * as P from "../lib/params"
import { doc, type DocBlock } from "../lib/tool-doc"
import { Effect, Schema } from "effect"
import { ErrorDetailOutput } from "@maple/domain/mcp-outputs"
import { errorDetail } from "@maple/query-engine/observability"
import { provideWarehouseExecutorFromTenant } from "@maple/backend/services/warehouse/WarehouseQueryService"

const WINDOW = P.timeWindow({ defaultHours: 6 })

/**
 * A FingerprintHash is a ClickHouse UInt64 rendered as a decimal string. It is NOT
 * the id of an error ISSUE — that is a Postgres UUID, a different identity space —
 * and it is not hex.
 *
 * The distinction is load-bearing: `list_error_issues` renders issue ids, and agents
 * were pasting those (and `alert:<uuid>:<scope>` incident ids) straight into this
 * tool. The value reached `toUInt64()` inside the SQL and came back as a raw
 * ClickHouse parse error, which is unactionable — every `error_detail` failure in
 * production had this one cause. Reject it here, where we can name the right tool.
 */
const isFingerprintHash = (value: string): boolean => /^\d{1,20}$/.test(value)

const rejectNonFingerprint = (rawFingerprint: string): McpInvalidInputError =>
	rawFingerprint.startsWith("alert:")
		? new McpInvalidInputError({
				message: `'${rawFingerprint}' is an alert incident id, not an error fingerprint. error_detail only covers fingerprint-grouped errors. Use list_alert_incidents to find the incident and get_incident_timeline for its timeline.`,
				parameter: "fingerprint",
				example: `get_incident_timeline incident_id="${rawFingerprint}"`,
			})
		: new McpInvalidInputError({
				message:
					`Invalid fingerprint: '${rawFingerprint}'. A fingerprint is a decimal number (a UInt64 hash), e.g. "11640295108927840024", not hex and not a UUID. ` +
					`Issue ids from list_error_issues are UUIDs in a different identity space and cannot be used here. find_errors lists errors with their fingerprint.`,
				parameter: "fingerprint",
				example: 'error_detail fingerprint="11640295108927840024"',
			})

const traceBlocks = (
	trace: (typeof ErrorDetailOutput.Type.traces)[number],
	index: number,
): Array<DocBlock> => {
	const blocks: Array<DocBlock> = [
		doc.heading(`Trace ${index + 1}: ${trace.traceId}`),
		doc.fields([
			["Root span", trace.rootSpanName],
			["Duration", formatDurationFromMs(trace.durationMs)],
			["Spans", trace.spanCount],
			["Services", trace.services.join(", ")],
			["Time", trace.startTime],
			// The failing span first: name, service, status and the attributes that say what it
			// was doing. That is the line an investigator needs; the logs below are context.
			[
				"Error span",
				trace.errorSpan === undefined
					? undefined
					: `${trace.errorSpan.name} (${trace.errorSpan.serviceName}) span=${trace.errorSpan.spanId}`,
			],
			[
				"Status",
				trace.errorSpan === undefined || trace.errorSpan.statusMessage === ""
					? undefined
					: `"${truncate(trace.errorSpan.statusMessage, 160)}"`,
			],
			[
				"Error",
				trace.errorSpan === undefined && trace.errorMessage
					? truncate(trace.errorMessage, 120)
					: undefined,
			],
		]),
	]
	const attrs = Object.entries(trace.errorSpan?.attributes ?? {})
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
					`Logs (${trace.logs.length}):`,
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

export function registerErrorDetailTool(server: McpToolRegistrar) {
	server.define({
		name: "error_detail",
		description:
			"Sample traces and correlated logs for one error, by `fingerprint` (a decimal UInt64 from find_errors; not an issue id). Use inspect_trace on a trace_id for the full span tree.",
		parameters: Schema.Struct({
			fingerprint: P.text(
				'The error FingerprintHash from find_errors: a decimal UInt64 string, e.g. "11640295108927840024". Not a list_error_issues issue id (those are UUIDs).',
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
			const fingerprint = params.fingerprint.trim()
			if (!isFingerprintHash(fingerprint)) return yield* rejectNonFingerprint(fingerprint)

			const { st, et } = yield* WINDOW.resolve(params, "error_detail")
			const tenant = yield* CurrentMcpTenant

			const result = yield* errorDetail({
				fingerprintHash: fingerprint,
				timeRange: { startTime: st, endTime: et },
				service: params.service,
				includeTimeseries: params.include_timeseries ?? false,
				limit: params.limit,
			}).pipe(
				provideWarehouseExecutorFromTenant(tenant),
				Effect.mapError(toMcpQueryError("error_detail_traces")),
			)

			return {
				timeRange: { start: st, end: et },
				fingerprintHash: fingerprint,
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
			const scope: ReadonlyArray<readonly [string, string | undefined]> = [
				["Time range", `${output.timeRange.start} to ${output.timeRange.end}`],
				["Service", output.service],
			]
			if (output.traces.length === 0) {
				return {
					title: `Error Detail: fingerprint ${output.fingerprintHash}`,
					scope,
					blocks: [],
					empty: {
						message: `No traces found for error fingerprint "${output.fingerprintHash}" in this window.`,
						hints: [
							"Widen start_time/end_time, or drop the service filter. find_errors shows when the fingerprint was last seen.",
						],
					},
				}
			}
			const trend = output.timeseries ?? []
			return {
				title: `Error Detail: fingerprint ${output.fingerprintHash}`,
				scope,
				blocks: [
					doc.text(`Sample traces: ${output.traces.length}`),
					...output.traces.flatMap(traceBlocks),
					...(trend.length === 0
						? []
						: [
								doc.heading("Error Trend"),
								doc.text(
									trend
										.map((point) => {
											const time = point.bucket.includes("T")
												? point.bucket.slice(11, 19)
												: (point.bucket.split(" ")[1] ?? point.bucket)
											return `${time}: ${point.count} errors`
										})
										.join("\n"),
								),
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
					doc.next(
						"search_logs",
						{ service: output.service, severity: "ERROR" },
						"search for related error logs",
					),
				],
			}
		},
	})
}
