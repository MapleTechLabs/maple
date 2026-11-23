import type { McpToolRegistrar } from "./types"
import { McpInvalidInputError } from "./types"
import { warehouseToMcpHandlers } from "../lib/map-warehouse-error"
import { withTenantExecutor } from "../lib/query-warehouse"
import { CurrentMcpTenant } from "../tenant"
import { MCP_SEARCH_MAX_HOURS } from "../lib/time"
import { toSecondTimestamp, truncate } from "../lib/format"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"
import { Effect, Schema, Array as Arr } from "effect"
import { MetricType } from "@maple/domain/query-engine"
import { computeBucketSecondsForRange } from "@maple/query-engine"
import { metricExemplars } from "@maple/query-engine/observability"

const TOOL = "get_metric_exemplars"
const WINDOW = P.timeWindow({ defaultHours: 1, maxHours: MCP_SEARCH_MAX_HOURS })
const DEFAULT_PER_BUCKET = 3

const formatValue = (value: number): string =>
	Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(6)))

export function registerGetMetricExemplarsTool(server: McpToolRegistrar) {
	server.define({
		name: TOOL,
		title: "Get Metric Exemplars",
		description:
			"The traces behind a metric's highest values: the exemplars SDKs attach to datapoints (mostly latency histograms), " +
			"ranked highest first with a few per time bucket so one spike does not hide the rest. " +
			"Use it to go from a spike on a chart to the trace that caused it, then inspect_trace the trace id. " +
			"metric_name is the OTel name list_metrics reports; metric_type is looked up when omitted.",
		parameters: Schema.Struct({
			metric_name: P.text("The metric, as list_metrics names it, e.g. http.server.request.duration"),
			metric_type: P.optionalOneOf(
				MetricType.literals,
				"Type of metric_name, as list_metrics reports it (looked up when omitted)",
			),
			...WINDOW.fields,
			service: P.service(),
			environment: P.environment(),
			attribute_key: P.optionalText("A datapoint label to match, e.g. http.route"),
			attribute_value: P.optionalText("Exact value for attribute_key"),
			bucket_seconds: P.optionalNumber(
				"Time bucket width in seconds that exemplars are ranked within (auto-computed when omitted)",
			),
			per_bucket: P.limit({ default: DEFAULT_PER_BUCKET, max: 20, noun: "exemplars per time bucket" }),
			limit: P.limit({ default: 20, max: 200, noun: "exemplars" }),
		}),
		aliases: P.SERVICE_ALIASES,
		untrustedOutput: true,
		hints: { readOnly: true },
		phrases: ["Finding the traces behind a metric", "Reading metric exemplars"],
		handler: Effect.fn("McpTool.getMetricExemplars")(function* (params) {
			const { st, et } = yield* WINDOW.resolve(params, TOOL)
			const tenant = yield* CurrentMcpTenant
			if (params.attribute_value !== undefined && params.attribute_key === undefined) {
				return yield* new McpInvalidInputError({
					message: "attribute_value needs attribute_key.",
					parameter: "attribute_key",
					example: 'attribute_key="http.route" attribute_value="/checkout"',
				})
			}
			const bucketSeconds =
				params.bucket_seconds === undefined
					? computeBucketSecondsForRange(st, et, "chart", 30)
					: Math.max(1, Math.round(params.bucket_seconds))
			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				"maple.ai.metric_name": params.metric_name,
				"maple.ai.service": params.service ?? "all",
				"maple.ai.bucket_seconds": bucketSeconds,
			})

			const attributeFilters =
				params.attribute_key === undefined
					? []
					: [
							params.attribute_value === undefined
								? { key: params.attribute_key, mode: "exists" as const }
								: {
										key: params.attribute_key,
										value: params.attribute_value,
										mode: "equals" as const,
									},
						]
			// One more than asked, so a cut list is told apart from one that ends exactly at the limit.
			const result = yield* withTenantExecutor(
				metricExemplars({
					metricName: params.metric_name,
					metricType: params.metric_type,
					service: params.service,
					environment: params.environment,
					attributeFilters,
					timeRange: { startTime: st, endTime: et },
					bucketSeconds,
					perBucket: params.per_bucket,
					limit: params.limit + 1,
				}),
			).pipe(Effect.catchTags(warehouseToMcpHandlers(TOOL)))

			if (result._tag === "missing") {
				const similar = Arr.take(result.similar, 5)
				return yield* new McpInvalidInputError({
					message:
						`No metric named "${params.metric_name}" in ${st} to ${et}` +
						(params.service === undefined ? "" : ` for service ${params.service}`) +
						(similar.length === 0
							? ". Find the name with list_metrics."
							: `. Similar names: ${Arr.join(similar, ", ")}.`),
					parameter: "metric_name",
					example: 'metric_name="http.server.request.duration"',
				})
			}
			yield* Effect.annotateCurrentSpan("result.rowCount", result.exemplars.length)

			return {
				metricName: params.metric_name,
				metricType: result.metricType,
				timeRange: { start: st, end: et },
				bucketSeconds,
				perBucket: params.per_bucket,
				filters: {
					...(params.service === undefined ? undefined : { service: params.service }),
					...(params.environment === undefined ? undefined : { environment: params.environment }),
					...(attributeFilters.length === 0
						? undefined
						: { attributeFilterCount: attributeFilters.length }),
				},
				exemplars: Arr.take(result.exemplars, params.limit),
				truncated: result.exemplars.length > params.limit,
			}
		}),
		render: (output) => {
			const scope: ReadonlyArray<readonly [string, string | undefined]> = [
				["Metric", `${output.metricName} (${output.metricType})`],
				["Time range", `${output.timeRange.start} to ${output.timeRange.end}`],
				["Service", output.filters.service],
				["Environment", output.filters.environment],
				["Ranked per", `${output.bucketSeconds}s bucket, top ${output.perBucket}`],
			]
			if (output.exemplars.length === 0) {
				return {
					title: "Metric Exemplars",
					scope,
					blocks: [],
					empty: {
						message: `No exemplars recorded on ${output.metricName} in this window.`,
						hints: [
							"Exemplars exist only where the SDK records them (OTel SDKs sample them from a recording span, mostly on histograms).",
							"Widen start_time/end_time or drop the filters; find_slow_traces finds slow traces without exemplars.",
						],
					},
					next: [
						doc.next(
							"find_slow_traces",
							{
								start_time: output.timeRange.start,
								end_time: output.timeRange.end,
								service: output.filters.service,
								environment: output.filters.environment,
							},
							"slow traces without exemplars",
						),
					],
				}
			}
			return {
				title: "Metric Exemplars",
				scope,
				untrusted: true,
				blocks: [
					doc.table(
						["Time", "Value", "Service", "Trace ID", "Span ID"],
						Arr.map(output.exemplars, (e) => [
							toSecondTimestamp(e.timestamp),
							formatValue(e.value),
							truncate(e.serviceName, 40),
							e.traceId,
							e.spanId,
						]),
					),
				],
				...(output.truncated
					? { truncation: { shown: output.exemplars.length, noun: "exemplars" } }
					: undefined),
				next: Arr.map(
					Arr.dedupeWith(output.exemplars, (a, b) => a.traceId === b.traceId).slice(0, 3),
					(e) =>
						doc.next(
							"inspect_trace",
							{ trace_id: e.traceId, timestamp: toSecondTimestamp(e.timestamp) },
							`the trace behind ${formatValue(e.value)}`,
						),
				),
			}
		},
	})
}
