import { TraceData } from "@maple/web/page/traces/detail/trace-data"
import { Option, Schema } from "effect"
import type { CacheValue, QueryKey } from "../../data/cache-store"

// `useLocalTraceDetail`'s key and data (`buildTraceDetail`'s `TraceDetail`) in the result cache.

/** `["local", "trace", traceId]`. */
export const traceCacheKey = (traceId: string): QueryKey => ["local", "trace", traceId]

/** An unknown trace caches as an empty detail, as legacy's hook returns it. */
export const traceToCached = (maybeTrace: Option.Option<TraceData>) =>
	Option.match(maybeTrace, {
		onNone: () => ({ spans: [], rootSpans: [], totalDurationMs: 0, services: [], traceStartTime: "" }),
		onSome: (trace) => ({
			spans: trace.spans,
			rootSpans: trace.rootSpans,
			totalDurationMs: trace.totalDurationMs,
			services: [...new Set(trace.spans.map((span) => span.serviceName).filter(Boolean))],
			traceStartTime: trace.traceStartTime ?? "",
		}),
	})

const decodeTrace = Schema.decodeUnknownOption(Schema.toType(TraceData))
const CachedDetail = Schema.Struct({
	spans: Schema.Array(Schema.Unknown),
	rootSpans: Schema.Array(Schema.Unknown),
	totalDurationMs: Schema.Number,
	traceStartTime: Schema.UndefinedOr(Schema.String),
})
const isCachedDetail = Schema.is(CachedDetail)

/** None when the value is not a detail; Some(None) for a cached empty (unknown) trace. */
export const traceFromCached =
	(traceId: string) =>
	(value: CacheValue): Option.Option<Option.Option<TraceData>> => {
		if (!isCachedDetail(value)) return Option.none()
		if (value.spans.length === 0) return Option.some(Option.none())
		const { spans, rootSpans, totalDurationMs, traceStartTime } = value
		return Option.map(
			decodeTrace({ traceId, spans, rootSpans, totalDurationMs, traceStartTime }),
			Option.some,
		)
	}
