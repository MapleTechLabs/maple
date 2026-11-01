import { Array as Arr, DateTime, Effect, Option, Schema, pipe } from "effect"
import * as CH from "../ch"
import { WarehouseExecutor } from "./WarehouseExecutor"

import { formatWarehouseDateTime, formatWarehouseDateTimeMs } from "../datetime"
const StringRecordFromJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String))

const parseAttributes = (raw: string): Effect.Effect<Record<string, string>> =>
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

const DEFAULT_RANGE_HOURS = 1

export interface SpanDetailInput {
	readonly traceId: string
	readonly spanId: string
	/**
	 * Approximate timestamp of the span. The point lookup is O(log N) on the
	 * `(OrgId, TraceId, SpanId)` sort key even without it, but passing it lets
	 * ClickHouse prune partitions to a window around the span.
	 */
	readonly timestampHint?: Date
	/** Half-width of the time window when `timestampHint` is set. Defaults to 1h. */
	readonly rangeHours?: number
}

export interface SpanDetailResult {
	readonly found: boolean
	readonly traceId: string
	readonly spanId: string
	/** Full span attribute map (not the trimmed set the trace tree renders). */
	readonly spanAttributes: Record<string, string>
	readonly resourceAttributes: Record<string, string>
	/** The rest of the span row, present when `found`. */
	readonly span?: SpanDetailSpan
	/** True when the hinted window missed and the lookup was retried unbounded. */
	readonly widened?: boolean
}

export interface SpanDetailSpan {
	/** Display name: an HTTP span's bare method gains its route, as in `inspectTrace`. */
	readonly spanName: string
	/** The stored SpanName, when the display name rewrote it. */
	readonly rawSpanName?: string
	readonly serviceName: string
	readonly spanKind: string
	readonly durationMs: number
	/** UTC, `YYYY-MM-DD HH:MM:SS.mmm`. */
	readonly startTime: string
	readonly statusCode: string
	readonly statusMessage: string
}

/**
 * Fetch the full attribute set for one span. Complements `inspectTrace`, whose
 * tree view intentionally projects only a trimmed set of attributes per span.
 */
export const spanDetail = Effect.fn("Observability.spanDetail")(function* (input: SpanDetailInput) {
	const executor = yield* WarehouseExecutor
	yield* Effect.annotateCurrentSpan({
		orgId: executor.orgId,
		"maple.trace.id": input.traceId,
		"maple.span.id": input.spanId,
	})

	const narrowByTime = input.timestampHint != null
	const range = input.timestampHint
		? (() => {
				const halfWidthMs = (input.rangeHours ?? DEFAULT_RANGE_HOURS) * 60 * 60 * 1000
				return {
					startTime: formatWarehouseDateTime(input.timestampHint.getTime() - halfWidthMs),
					endTime: formatWarehouseDateTime(input.timestampHint.getTime() + halfWidthMs),
				}
			})()
		: undefined

	const lookup = (bounded: boolean) =>
		executor.compiledQueryFirst(
			CH.compile(
				CH.spanDetailQuery({ traceId: input.traceId, spanId: input.spanId, narrowByTime: bounded }),
				bounded && range
					? { orgId: executor.orgId, startTime: range.startTime, endTime: range.endTime }
					: { orgId: executor.orgId },
			),
			{ profile: "discovery", context: "spanDetail" },
		)
	const firstRow = yield* lookup(narrowByTime)
	// A wrong hint should not hide the span: retry once without the time bound.
	const widened = Option.isNone(firstRow) && narrowByTime
	const maybeRow = widened ? yield* lookup(false) : firstRow
	yield* Effect.annotateCurrentSpan("maple.query.widened", widened)

	if (Option.isNone(maybeRow)) {
		return {
			found: false,
			traceId: input.traceId,
			spanId: input.spanId,
			spanAttributes: {},
			resourceAttributes: {},
			widened,
		} satisfies SpanDetailResult
	}

	const row = maybeRow.value
	const spanAttributes = yield* parseAttributes(row.spanAttributes ?? "{}")
	const resourceAttributes = yield* parseAttributes(row.resourceAttributes ?? "{}")
	return {
		found: true,
		traceId: row.traceId,
		spanId: row.spanId,
		spanAttributes,
		resourceAttributes,
		span: {
			spanName: row.spanName,
			...(row.rawSpanName !== row.spanName ? { rawSpanName: row.rawSpanName } : undefined),
			serviceName: row.serviceName,
			spanKind: row.spanKind,
			durationMs: row.durationMs,
			startTime: formatWarehouseDateTimeMs(DateTime.toEpochMillis(row.startTime)),
			statusCode: row.statusCode,
			statusMessage: row.statusMessage,
		},
		widened,
	} satisfies SpanDetailResult
})
