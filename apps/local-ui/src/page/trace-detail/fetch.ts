import { TraceId } from "@maple/domain"
import { CH } from "@maple/query-engine"
import { LOCAL_ORG_ID } from "@maple/query-engine/local"
import { logKey, normalizeLog } from "../../lib/log-shape"
import { boundsForRange, parseClickHouseDateTime, toClickHouseDateTime, WIDEST_RANGE } from "../../lib/time"
import type { TraceData } from "@maple/web/page/traces/detail/trace-data"
import { buildTraceDetail, parseAttributes } from "@maple/ui/lib/span-tree"
import { DateTime, Effect, Option, Schema } from "effect"
import { localParams, queryFirstRow, queryRows } from "../../data/local-query"
import type { SpanAttrs, SpanLog } from "./panel-model"
import { LOG_LIMIT } from "./panel-model"

// The queries of `useLocalTraceDetail`, `useLocalSpanDetail` and `useLocalSpanLogs`.

const decodeTraceId = Schema.decodeUnknownOption(TraceId)

/**
 * The full span hierarchy, shaped like `TraceViewTabs` reads it; none for a trace with no spans.
 * `narrowByTime` stays off: the trace-id lookup is cheaper than threading time bounds.
 */
export const fetchTrace = (traceId: string, apiBase: string) =>
	Effect.map(
		queryRows(CH.compile(CH.spanHierarchyQuery({ traceId }), { orgId: LOCAL_ORG_ID }), apiBase),
		(rows): Option.Option<TraceData> => {
			const detail = buildTraceDetail(rows.map((row) => ({ ...row, startTime: DateTime.formatIso(row.startTime) })))
			if (detail.spans.length === 0) return Option.none()
			return Option.map(decodeTraceId(traceId), (id) => ({
				traceId: id,
				spans: detail.spans,
				rootSpans: detail.rootSpans,
				totalDurationMs: detail.totalDurationMs,
				traceStartTime: detail.traceStartTime,
			}))
		},
	)

/** One span's full attribute maps (the hierarchy trims them to the keys the tree renders). */
export const fetchSpanDetail = (traceId: string, spanId: string, apiBase: string) =>
	Effect.map(
		queryFirstRow(CH.compile(CH.spanDetailQuery({ traceId, spanId }), { orgId: LOCAL_ORG_ID }), apiBase),
		(maybeRow): SpanAttrs =>
			Option.match(maybeRow, {
				onNone: () => null,
				onSome: (row) => ({
					spanAttributes: parseAttributes(row.spanAttributes),
					resourceAttributes: parseAttributes(row.resourceAttributes),
				}),
			}),
	)

const HOUR_MS = 60 * 60 * 1000

/** Logs emitted within one span, newest first, bounded to the span's own window ±1h. */
export const fetchSpanLogs = (
	traceId: string,
	spanId: string,
	spanStartTime: string,
	spanDurationMs: number,
	apiBase: string,
) => {
	const startMs = parseClickHouseDateTime(spanStartTime)
	const bounds =
		startMs === null
			? boundsForRange(WIDEST_RANGE)
			: {
					startTime: toClickHouseDateTime(startMs - HOUR_MS),
					endTime: toClickHouseDateTime(startMs + Math.max(0, spanDurationMs) + HOUR_MS),
				}
	return Effect.map(
		queryRows(CH.compile(CH.logsListQuery({ traceId, spanId, limit: LOG_LIMIT }), localParams(bounds)), apiBase),
		(rows) =>
			rows.map((row): SpanLog => {
				const log = normalizeLog(row)
				return { ...log, key: logKey(log) }
			}),
	)
}
