import {
	Array as Arr,
	Clock,
	Effect,
	HashMap,
	HashSet,
	Option,
	Schema,
	pipe,
	Record as Rec,
	String as Str,
} from "effect"
import { TraceId, SpanId } from "@maple/domain"
import type { SpanHierarchyOutput, ListLogsOutput } from "@maple/domain/tinybird"
import { WarehouseExecutor, type WarehouseExecutorApi } from "./WarehouseExecutor"
import type { InspectTraceOutput, SpanNode, TimeRange } from "./types"
import { toLogEntry } from "./row-mappers"
import { TRACE_RETENTION_HOURS, locateTrace } from "./locate-trace"

import { formatWarehouseDateTime } from "../datetime"
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

/** Keys the trace tree drops by default: the span name already shows them, or they are header noise. */
export const isRedundantTreeAttribute = (key: string): boolean =>
	HashSet.has(SKIP_ATTR_KEYS, key) || Arr.some(SKIP_ATTR_PREFIXES, (p) => Str.startsWith(p)(key))

const StringRecordFromJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String))

const extractKeyAttributes = (raw: string, keepAll: boolean): Effect.Effect<Record<string, string>> =>
	Schema.decodeEffect(StringRecordFromJson)(raw).pipe(
		Effect.map((parsed) =>
			pipe(
				Rec.toEntries(parsed),
				Arr.filter(([k, v]) => v !== "" && (keepAll || !isRedundantTreeAttribute(k))),
				Rec.fromEntries,
			),
		),
		Effect.orElseSucceed(() => ({})),
	)

const parseJsonAttributes = (raw: string): Effect.Effect<Record<string, string>> =>
	Schema.decodeEffect(StringRecordFromJson)(raw).pipe(
		Effect.map((parsed) =>
			pipe(
				Rec.toEntries(parsed),
				Arr.filter(([, v]) => v !== ""),
				Rec.fromEntries,
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
	/** Padding around the hint, or around the located trace's bounds. Defaults to 1h. */
	readonly rangeHours?: number
	/** An explicit window to read the trace from; wins over `timestampHint`. */
	readonly timeRange?: TimeRange
	/**
	 * How far back `trace_index` is searched when there is no hint (or the hint
	 * missed); the tree is then read from the trace's own bounds. Defaults to 30 days.
	 */
	readonly widenedLookbackHours?: number
	/**
	 * Keep every projected span attribute, including the HTTP method, route,
	 * status and URL keys the default view drops as redundant with the span name.
	 */
	readonly includeAttributes?: boolean
}

const DEFAULT_RANGE_HOURS = 1
/** How far below a hint the trace index is searched when the hint misses. */
const HINT_LOOKBACK_SLACK_HOURS = 24
const HOUR_MS = 60 * 60 * 1000

interface QueryRange {
	readonly start_time: string
	readonly end_time: string
}

const windowAround = (centerMs: number, halfWidthHours: number): QueryRange => ({
	start_time: formatWarehouseDateTime(centerMs - halfWidthHours * HOUR_MS),
	end_time: formatWarehouseDateTime(centerMs + halfWidthHours * HOUR_MS),
})

const queryRangeToScan = (range: QueryRange) => ({ startTime: range.start_time, endTime: range.end_time })

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

const NO_TRACE: Effect.Success<ReturnType<typeof readTrace>> = [{ data: [] }, { data: [] }]

export const inspectTrace = Effect.fn("Observability.inspectTrace")(function* (
	traceId: string,
	options?: InspectTraceOptions,
) {
	const executor = yield* WarehouseExecutor
	yield* Effect.annotateCurrentSpan("maple.trace.id", traceId)
	const decodedTraceId = yield* Schema.decodeEffect(TraceId)(traceId)

	const nowMs = yield* Clock.currentTimeMillis
	const rangeHours = options?.rangeHours ?? DEFAULT_RANGE_HOURS
	const hintMs = options?.timestampHint?.getTime()
	const widenedHours = options?.widenedLookbackHours ?? TRACE_RETENTION_HOURS
	const oldestMs = Math.min(
		nowMs - widenedHours * HOUR_MS,
		hintMs === undefined ? nowMs : hintMs - HINT_LOOKBACK_SLACK_HOURS * HOUR_MS,
	)
	const probed = { startTime: formatWarehouseDateTime(oldestMs), endTime: formatWarehouseDateTime(nowMs) }
	yield* Effect.annotateCurrentSpan(
		"maple.query.narrow_by_time",
		options?.timeRange != null || hintMs !== undefined,
	)

	const read = (range: QueryRange, widened: boolean) =>
		Effect.map(readTrace(executor, traceId, range), (result) => ({
			result,
			scanned: { ...queryRangeToScan(range), widened },
		}))
	type TraceWindowRead = Effect.Success<ReturnType<typeof read>>
	// The trace's own bounds, padded like a hint so logs written after the last span start stay in.
	const locateThenRead = (widened: boolean, onMiss: TraceWindowRead) =>
		Effect.flatMap(locateTrace(traceId, { nowMs, oldestMs }), (found) =>
			Option.match(found, {
				onNone: () => Effect.succeed(onMiss),
				onSome: (bounds) =>
					read(
						{
							start_time: formatWarehouseDateTime(bounds.startMs - rangeHours * HOUR_MS),
							end_time: formatWarehouseDateTime(bounds.endMs + rangeHours * HOUR_MS),
						},
						widened,
					),
			}),
		)

	// An explicit window is read as given. A hint reads the hour around it and locates the trace
	// in `trace_index` only on a miss. Without either, the trace is located first: reading a
	// default day of spans and logs to find it cost seconds on a busy org.
	const readWindow = Effect.gen(function* () {
		if (options?.timeRange != null)
			return yield* read(
				{ start_time: options.timeRange.startTime, end_time: options.timeRange.endTime },
				false,
			)
		if (hintMs === undefined)
			return yield* locateThenRead(false, { result: NO_TRACE, scanned: { ...probed, widened: false } })
		const first = yield* read(windowAround(hintMs, rangeHours), false)
		return first.result[0].data.length > 0
			? first
			: yield* locateThenRead(true, { ...first, scanned: { ...probed, widened: true } })
	})
	const {
		result: [spansResult, logsResult],
		scanned,
	} = yield* readWindow

	const spans = spansResult.data

	const toSpanNode = Effect.fnUntraced(function* (span: (typeof spans)[number]) {
		const attributes = yield* extractKeyAttributes(
			span.spanAttributes ?? "{}",
			options?.includeAttributes === true,
		)
		const resourceAttributes = yield* parseJsonAttributes(span.resourceAttributes ?? "{}")
		const node: MutableSpanNode = {
			// oxlint-disable-next-line effecttsgo/schema-sync-in-effect -- read back from the warehouse, which only stores valid span ids
			spanId: Schema.decodeSync(SpanId)(span.spanId),
			parentSpanId: span.parentSpanId,
			spanName: span.spanName,
			...(span.rawSpanName !== undefined && span.rawSpanName !== span.spanName
				? { rawSpanName: span.rawSpanName }
				: undefined),
			serviceName: span.serviceName,
			spanKind: span.spanKind,
			durationMs: span.durationMs,
			startTime: span.startTime,
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

	yield* Effect.annotateCurrentSpan("result.spanCount", spans.length)
	yield* Effect.annotateCurrentSpan("result.serviceCount", serviceCount)

	return {
		traceId: decodedTraceId,
		serviceCount,
		spanCount: spans.length,
		rootDurationMs: roots[0]?.durationMs ?? 0,
		spans: roots,
		scanned,
		logs: pipe(logsResult.data, Arr.take(20), Arr.map(toLogEntry)),
	} satisfies InspectTraceOutput
})
