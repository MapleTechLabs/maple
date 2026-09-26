import { Array as Arr, Clock, Effect, HashMap, HashSet, Option, Schema, pipe } from "effect"
import { TraceId, SpanId } from "@maple/domain"
import type { SpanHierarchyOutput, ListLogsOutput } from "@maple/domain/tinybird"
import * as CH from "../ch"
import { WarehouseExecutor, type WarehouseExecutorApi } from "./WarehouseExecutor"
import type { InspectTraceOutput, SpanNode, TimeRange } from "./types"
import { toLogEntry } from "./row-mappers"

import { formatWarehouseDateTime, parseWarehouseDateTime } from "../datetime"
const SKIP_ATTR_PREFIXES = ["http.request.header.", "http.response.header.", "signoz."]
const SKIP_ATTR_KEYS = HashSet.fromIterable([
	"http.request.method",
	"url.scheme",
	"url.full",
	"url.path",
	"http.route",
	"http.response.status_code",
	"user_agent.original",
	"server.address",
	"server.port",
	"client.address",
])

const StringRecordFromJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String))

const extractKeyAttributes = (raw: string, keepAll: boolean): Effect.Effect<Record<string, string>> =>
	Schema.decodeUnknownEffect(StringRecordFromJson)(raw).pipe(
		Effect.map((parsed) =>
			pipe(
				Object.entries(parsed),
				Arr.filter(
					([k, v]) =>
						v !== "" &&
						(keepAll ||
							(!HashSet.has(SKIP_ATTR_KEYS, k) &&
								!Arr.some(SKIP_ATTR_PREFIXES, (p) => k.startsWith(p)))),
				),
				Object.fromEntries,
			),
		),
		Effect.orElseSucceed(() => ({})),
	)

const parseJsonAttributes = (raw: string): Effect.Effect<Record<string, string>> =>
	Schema.decodeUnknownEffect(StringRecordFromJson)(raw).pipe(
		Effect.map((parsed) =>
			pipe(
				Object.entries(parsed),
				Arr.filter(([, v]) => v !== ""),
				Object.fromEntries,
			),
		),
		Effect.orElseSucceed(() => ({})),
	)

type MutableSpanNode = SpanNode & { children: MutableSpanNode[] }

export interface InspectTraceOptions {
	/**
	 * Approximate timestamp for the trace. When provided, the underlying
	 * `span_hierarchy` and `list_logs` queries are bounded to a window around
	 * it so ClickHouse can prune partitions instead of scanning the full
	 * retention window. Strongly recommended for traces older than the
	 * default fallback window.
	 */
	readonly timestampHint?: Date
	/** Half-width of the time window when `timestampHint` is set. Defaults to 1h. */
	readonly rangeHours?: number
	/** An explicit window to read the trace from; wins over `timestampHint`. */
	readonly timeRange?: TimeRange
	/**
	 * Lookback window when neither `timeRange` nor `timestampHint` is provided.
	 * Defaults to 24h ending at `now`. Without a bound, queries scan full
	 * retention and time out on busy clusters.
	 */
	readonly defaultLookbackHours?: number
	/**
	 * How far back to look for the trace when the default lookback finds
	 * nothing. A cheap timestamp probe searches this far, then the tree is read
	 * from a ±`rangeHours` window around what it found. Defaults to 30 days.
	 */
	readonly widenedLookbackHours?: number
	/**
	 * Keep every projected span attribute, including the HTTP method, route,
	 * status and URL keys the default view drops as redundant with the span name.
	 */
	readonly includeAttributes?: boolean
}

const DEFAULT_RANGE_HOURS = 1
const DEFAULT_LOOKBACK_HOURS = 24
const DEFAULT_WIDENED_LOOKBACK_HOURS = 30 * 24
const HOUR_MS = 60 * 60 * 1000

interface QueryRange {
	readonly start_time: string
	readonly end_time: string
}

const windowAround = (centerMs: number, halfWidthHours: number): QueryRange => ({
	start_time: formatWarehouseDateTime(centerMs - halfWidthHours * HOUR_MS),
	end_time: formatWarehouseDateTime(centerMs + halfWidthHours * HOUR_MS),
})

const readTrace = (executor: WarehouseExecutorApi, traceId: string, range: QueryRange) =>
	Effect.all(
		[
			executor.query<SpanHierarchyOutput>(
				"span_hierarchy",
				{ trace_id: traceId, ...range },
				{ profile: "list" },
			),
			executor.query<ListLogsOutput>(
				"list_logs",
				{ trace_id: traceId, limit: 50, ...range },
				{ profile: "list" },
			),
		],
		{ concurrency: "unbounded" },
	)

export const inspectTrace = Effect.fn("Observability.inspectTrace")(function* (
	traceId: string,
	options?: InspectTraceOptions,
) {
	const executor = yield* WarehouseExecutor
	yield* Effect.annotateCurrentSpan("traceId", traceId)

	const nowMs = yield* Clock.currentTimeMillis
	const rangeHours = options?.rangeHours ?? DEFAULT_RANGE_HOURS
	const usingDefaultLookback = options?.timeRange == null && options?.timestampHint == null

	const range: QueryRange = options?.timeRange
		? { start_time: options.timeRange.startTime, end_time: options.timeRange.endTime }
		: options?.timestampHint
			? windowAround(options.timestampHint.getTime(), rangeHours)
			: {
					start_time: formatWarehouseDateTime(
						nowMs - (options?.defaultLookbackHours ?? DEFAULT_LOOKBACK_HOURS) * HOUR_MS,
					),
					end_time: formatWarehouseDateTime(nowMs),
				}

	yield* Effect.annotateCurrentSpan("narrowByTime", !usingDefaultLookback)
	yield* Effect.annotateCurrentSpan("usingDefaultLookback", usingDefaultLookback)

	const firstRead = yield* readTrace(executor, traceId, range)

	// A trace older than the default lookback is not missing: probe further back
	// once (one column, LIMIT 1) and re-read the tree around what the probe found.
	const [spansResult, logsResult] =
		firstRead[0].data.length > 0 || !usingDefaultLookback
			? firstRead
			: yield* Effect.gen(function* () {
					const widenedHours = options?.widenedLookbackHours ?? DEFAULT_WIDENED_LOOKBACK_HOURS
					const probe = yield* executor.compiledQueryFirst(
						CH.compile(CH.traceTimeProbeQuery({ traceId, narrowByTime: true }), {
							orgId: executor.orgId,
							startTime: formatWarehouseDateTime(nowMs - widenedHours * HOUR_MS),
						}),
						{ profile: "discovery", context: "inspectTraceProbe" },
					)
					const foundMs = pipe(
						probe,
						Option.map((row) => parseWarehouseDateTime(row.timestamp)),
						Option.filter((ms) => !Number.isNaN(ms)),
					)
					yield* Effect.annotateCurrentSpan("widenedLookback", Option.isSome(foundMs))
					return Option.isSome(foundMs)
						? yield* readTrace(executor, traceId, windowAround(foundMs.value, rangeHours))
						: firstRead
				})

	const spans = spansResult.data

	const toSpanNode = Effect.fnUntraced(function* (span: (typeof spans)[number]) {
		const attributes = yield* extractKeyAttributes(
			span.spanAttributes ?? "{}",
			options?.includeAttributes === true,
		)
		const resourceAttributes = yield* parseJsonAttributes(span.resourceAttributes ?? "{}")
		const node: MutableSpanNode = {
			spanId: Schema.decodeSync(SpanId)(span.spanId),
			parentSpanId: span.parentSpanId,
			spanName: span.spanName,
			serviceName: span.serviceName,
			spanKind: span.spanKind,
			durationMs: span.durationMs,
			statusCode: span.statusCode,
			statusMessage: span.statusMessage,
			attributes,
			resourceAttributes,
			children: [],
		}
		return node
	})

	const nodes: MutableSpanNode[] = yield* Effect.forEach(spans, toSpanNode)

	// Index by spanId (use string keys for parentSpanId lookup compatibility)
	const nodeMap = HashMap.fromIterable(
		pipe(
			nodes,
			Arr.map((n) => [n.spanId as string, n] as const),
		),
	)

	// Link children and collect roots
	const roots = pipe(
		nodes,
		Arr.filter((node) => {
			if (node.parentSpanId) {
				pipe(
					HashMap.get(nodeMap, node.parentSpanId),
					Option.map((parent) => {
						parent.children.push(node)
					}),
				)
				return !HashMap.has(nodeMap, node.parentSpanId)
			}
			return true
		}),
	)

	const serviceCount = pipe(
		spans,
		Arr.map((s) => s.serviceName),
		Arr.dedupe,
	).length

	yield* Effect.annotateCurrentSpan("spanCount", spans.length)
	yield* Effect.annotateCurrentSpan("serviceCount", serviceCount)

	return {
		traceId: Schema.decodeSync(TraceId)(traceId),
		serviceCount,
		spanCount: spans.length,
		rootDurationMs: roots[0]?.durationMs ?? 0,
		spans: roots,
		logs: pipe(logsResult.data, Arr.take(20), Arr.map(toLogEntry)),
	} satisfies InspectTraceOutput
})
