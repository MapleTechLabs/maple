import { McpInvalidInputError, type McpToolRegistrar } from "./types"
import { warehouseToMcpHandlers } from "../lib/map-warehouse-error"
import { CurrentMcpTenant, withTenantExecutor } from "../lib/query-warehouse"
import { MCP_SEARCH_MAX_HOURS } from "../lib/time"
import { formatDurationFromMs, toSecondTimestamp, truncate } from "../lib/format"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"
import { Effect, Schema, Array as Arr } from "effect"
import { SearchTracesOutput } from "@maple/domain/mcp-outputs"
import { searchTraces } from "@maple/query-engine/observability"
import { resolveAttributeScope } from "../lib/attribute-scope"
import { emptyResultHints } from "../lib/empty-result-hints"

const hintOf = (startTime: string | undefined) =>
	startTime === undefined ? undefined : toSecondTimestamp(startTime)
const startCell = (startTime: string | undefined) => hintOf(startTime) ?? ""

const SPAN_NAME_MATCHES = ["exact", "contains"] as const
type SpanNameMatch = (typeof SPAN_NAME_MATCHES)[number]

const WINDOW = P.timeWindow({ defaultHours: 6, maxHours: MCP_SEARCH_MAX_HOURS })

export function registerSearchTracesTool(server: McpToolRegistrar) {
	server.define({
		name: "search_traces",
		title: "Search Traces",
		description:
			"Find traces, newest first, by service, duration, error status, HTTP method, span name, or one span attribute. Without `span_name` the filters apply to each trace's entry span and one row per trace comes back; with `span_name` every span is searched and each row is a matching span. Each row has the full trace id, span id and start time; pass the start as inspect_trace `timestamp`. There is no free-text search: log text is search_logs. For the slowest traces ranked by duration with percentiles, use find_slow_traces. explore_attributes lists attribute keys and values.",
		parameters: Schema.Struct({
			...WINDOW.fields,
			service: P.service(
				"Only this service (exact `service.name`), matched on the entry span, or on every span when `span_name` is set",
			),
			environment: P.environment(),
			has_error: P.optionalFlag("Only spans with status Error"),
			min_duration_ms: P.optionalNumber("Minimum duration in milliseconds"),
			max_duration_ms: P.optionalNumber("Maximum duration in milliseconds"),
			http_method: P.optionalText("Only spans with this HTTP method"),
			span_name: P.optionalText(
				"Span name. Matched exactly first (fast, index-backed); when nothing has that exact name it is matched as a case-insensitive substring. Switches the search to span level; set `service` too, or a substring across every service can run out of time",
			),
			span_name_match: P.optionalOneOf(
				SPAN_NAME_MATCHES,
				"How `span_name` matches: 'exact' or 'contains' (case-insensitive substring). Default: exact, then contains when nothing matches exactly",
			),
			trace_id: P.optionalText("Only this trace"),
			attribute_key: P.optionalText(
				"Span attribute to filter on (e.g. user.id). Alone, requires the attribute to exist. With a value, a resource attribute (k8s.pod.name) also works",
			),
			attribute_value: P.optionalText("Exact value for `attribute_key`"),
			root_only: P.optionalFlag("With `span_name`, still match entry spans only instead of every span"),
			offset: P.offset({ max: 10_000 }),
			limit: P.limit({ default: 20, max: 200, noun: "traces" }),
		}),
		aliases: P.SERVICE_ALIASES,
		output: SearchTracesOutput,
		hints: { readOnly: true },
		phrases: ["Searching traces", "Looking through traces"],
		handler: Effect.fn("McpTool.searchTraces")(function* (params) {
			const { st, et } = yield* WINDOW.resolve(params, "search_traces")

			const tenant = yield* CurrentMcpTenant
			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				"maple.ai.service": params.service ?? "all",
				"maple.ai.has_error": params.has_error ?? false,
				"maple.ai.limit": params.limit,
				"maple.ai.offset": params.offset,
			})

			if (params.attribute_value !== undefined && params.attribute_key === undefined) {
				return yield* new McpInvalidInputError({
					message:
						"`attribute_value` requires `attribute_key`. Use explore_attributes to discover available keys.",
					parameter: "attribute_value",
					example: 'attribute_key="user.id" attribute_value="abc123"',
				})
			}

			const rootOnly = params.root_only ?? false
			const window = { startTime: st, endTime: et }
			// Resource keys are matched only with a value; an exists-check stays on span attributes.
			const resourceKey =
				params.attribute_key !== undefined && params.attribute_value !== undefined
					? (yield* resolveAttributeScope(
							{ source: "traces", attribute_key: params.attribute_key },
							window,
						)).scope === "resource"
					: false
			const search = (spanNameMatch: SpanNameMatch | undefined) =>
				withTenantExecutor(
					searchTraces({
						timeRange: { startTime: st, endTime: et },
						service: params.service,
						spanName: params.span_name,
						spanNameMatchMode: spanNameMatch,
						environment: params.environment,
						hasError: params.has_error,
						minDurationMs: params.min_duration_ms,
						maxDurationMs: params.max_duration_ms,
						httpMethod: params.http_method,
						traceId: params.trace_id,
						attributeFilters:
							params.attribute_key && !resourceKey
								? [{ key: params.attribute_key, value: params.attribute_value ?? "" }]
								: undefined,
						resourceAttributeFilter:
							params.attribute_key && params.attribute_value !== undefined && resourceKey
								? { key: params.attribute_key, value: params.attribute_value }
								: undefined,
						rootOnly,
						limit: params.limit,
						offset: params.offset,
					}),
				).pipe(Effect.catchTags(warehouseToMcpHandlers("search_traces")))

			// An exact name prunes on idx_span_name and a miss costs almost nothing; a substring
			// reads every SpanName in the window, so it only runs when the exact name matched nothing.
			const firstMatch: SpanNameMatch | undefined =
				params.span_name === undefined ? undefined : (params.span_name_match ?? "exact")
			const first = yield* search(firstMatch)
			// Only on the first page: past it, an empty exact page means the exact matches ran out.
			const fallBack =
				firstMatch === "exact" &&
				params.span_name_match === undefined &&
				params.offset === 0 &&
				first.spans.length === 0
			const result = fallBack ? yield* search("contains") : first
			const spanNameMatch = fallBack ? "contains" : firstMatch
			yield* Effect.annotateCurrentSpan({
				"maple.ai.span_name_match": spanNameMatch ?? "none",
				"maple.ai.span_name_fallback": fallBack,
			})

			const spans = result.spans
			yield* Effect.annotateCurrentSpan("result.rowCount", spans.length)
			const hasMore = result.pagination.hasMore
			const emptyHints =
				spans.length === 0 && params.offset === 0
					? yield* emptyResultHints(
							{
								service: params.service,
								environments:
									params.environment === undefined ? undefined : [params.environment],
								attributeKey: params.attribute_key,
							},
							window,
						)
					: []

			return {
				timeRange: { start: st, end: et },
				...(result.coveredFrom === undefined ? undefined : { coveredFrom: result.coveredFrom }),
				pagination: {
					offset: params.offset,
					limit: params.limit,
					hasMore,
					...(hasMore ? { nextOffset: params.offset + spans.length } : undefined),
				},
				// No spanCount: these rows read one span per trace and cannot count the rest.
				traces: Arr.map(spans, (s) => ({
					traceId: s.traceId,
					...(s.spanId ? { spanId: s.spanId } : undefined),
					rootSpanName: s.spanName,
					durationMs: s.durationMs,
					services: [s.serviceName],
					hasError: s.statusCode === "Error",
					...(s.timestamp ? { startTime: s.timestamp } : undefined),
					resourceAttributes: s.resourceAttributes,
				})),
				filters: {
					...(params.service === undefined ? undefined : { service: params.service }),
					...(params.has_error === undefined ? undefined : { hasError: params.has_error }),
					...(params.min_duration_ms === undefined
						? undefined
						: { minDurationMs: params.min_duration_ms }),
					...(params.max_duration_ms === undefined
						? undefined
						: { maxDurationMs: params.max_duration_ms }),
					...(params.http_method === undefined ? undefined : { httpMethod: params.http_method }),
					...(params.span_name === undefined ? undefined : { spanName: params.span_name }),
					...(spanNameMatch === undefined ? undefined : { spanNameMatch }),
					...(params.trace_id === undefined ? undefined : { traceId: params.trace_id }),
					...(params.attribute_key === undefined
						? undefined
						: { attributeKey: params.attribute_key }),
					...(params.attribute_value === undefined
						? undefined
						: { attributeValue: params.attribute_value }),
					...(params.environment === undefined ? undefined : { environment: params.environment }),
					rootOnly,
				},
				spanLevel: params.span_name !== undefined && !rootOnly,
				...(emptyHints.length > 0 ? { emptyHints } : undefined),
			}
		}),
		render: (output) => {
			const { filters, pagination } = output
			const noun = output.spanLevel ? "matching spans" : "traces"
			const scope: ReadonlyArray<readonly [string, string | undefined]> = [
				["Time range", `${output.timeRange.start} to ${output.timeRange.end}`],
				["Service", filters.service],
				["Environment", filters.environment],
				[
					"Span name",
					filters.spanName === undefined
						? undefined
						: filters.spanNameMatch === "contains"
							? `contains "${filters.spanName}" (case-insensitive)`
							: filters.spanName,
				],
				[
					"Offset",
					pagination === undefined || pagination.offset === 0
						? undefined
						: String(pagination.offset),
				],
			]
			const title = output.spanLevel ? "Matching Spans" : "Traces"
			const partial =
				output.coveredFrom === undefined
					? undefined
					: {
							notices: [
								`Only ${output.coveredFrom} to ${output.timeRange.end} was searched: the earlier part did not finish within the query limits. Set \`service\` or query the earlier part with its own end_time.`,
							],
						}
			if (output.traces.length === 0) {
				return {
					title,
					scope,
					blocks: [],
					...partial,
					empty: {
						message: `No ${noun} found matching the filters in this window.`,
						hints: [
							...(output.emptyHints ?? []),
							"Widen start_time/end_time, or drop filters.",
							"span_name matches exactly, then as a case-insensitive substring; explore_attributes lists attribute keys and values.",
						],
					},
				}
			}
			const nextOffset = pagination?.nextOffset
			return {
				title,
				scope,
				...partial,
				blocks: [
					output.spanLevel
						? doc.table(
								[
									"Start",
									"Trace ID",
									"Span ID",
									"Span Name",
									"Service",
									"Duration",
									"Status",
								],
								Arr.map(output.traces, (t) => [
									startCell(t.startTime),
									t.traceId,
									t.spanId ?? "",
									truncate(t.rootSpanName, 40),
									Arr.join(t.services, ", "),
									formatDurationFromMs(t.durationMs),
									t.hasError ? "Error" : "",
								]),
							)
						: doc.table(
								["Start", "Trace ID", "Root Span", "Duration", "Service", "Error"],
								Arr.map(output.traces, (t) => [
									startCell(t.startTime),
									t.traceId,
									truncate(t.rootSpanName, 30),
									formatDurationFromMs(t.durationMs),
									Arr.join(t.services, ", "),
									t.hasError ? "Yes" : "",
								]),
							),
				],
				...(nextOffset === undefined
					? undefined
					: {
							truncation: {
								shown: output.traces.length,
								noun,
								next: doc.next(
									"search_traces",
									{
										start_time: output.timeRange.start,
										end_time: output.timeRange.end,
										service: filters.service,
										environment: filters.environment,
										has_error: filters.hasError,
										min_duration_ms: filters.minDurationMs,
										max_duration_ms: filters.maxDurationMs,
										http_method: filters.httpMethod,
										span_name: filters.spanName,
										span_name_match: filters.spanNameMatch,
										trace_id: filters.traceId,
										attribute_key: filters.attributeKey,
										attribute_value: filters.attributeValue,
										root_only: filters.rootOnly ? true : undefined,
										limit: pagination?.limit,
										offset: nextOffset,
									},
									"the next page",
								),
							},
						}),
				next: [
					...Arr.map(output.traces.slice(0, 3), (t) =>
						doc.next(
							"inspect_trace",
							{ trace_id: t.traceId, timestamp: hintOf(t.startTime) },
							"full span tree",
						),
					),
					...Arr.flatMap(output.traces.slice(0, output.spanLevel ? 1 : 0), (t) =>
						t.spanId === undefined
							? []
							: [
									doc.next(
										"inspect_span",
										{
											trace_id: t.traceId,
											span_id: t.spanId,
											timestamp: hintOf(t.startTime),
										},
										"every attribute of the matching span",
									),
								],
					),
				],
			}
		},
	})
}
