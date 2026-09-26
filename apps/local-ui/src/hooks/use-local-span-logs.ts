import { skipToken, useQuery } from "@tanstack/react-query"
import { CH } from "@maple/query-engine"
import { executeLocalCompiledQuery, localParams } from "@/lib/query"
import { normalizeLog, type LocalLog } from "../lib/log-shape"
import { boundsForRange, parseClickHouseDateTime, toClickHouseDateTime, WIDEST_RANGE } from "../lib/time"

const HOUR_MS = 60 * 60 * 1000

/**
 * Logs emitted within one span, newest first (the span detail's Logs tab).
 * Bounded to the span start ±1h: a span's logs cannot drift further, and an
 * unbounded scan reads every partition on each span click.
 */
export function useLocalSpanLogs(
	traceId: string | undefined,
	spanId: string | undefined,
	spanStartTime: string,
) {
	return useQuery<ReadonlyArray<LocalLog>>({
		queryKey: ["local", "span-logs", traceId, spanId],
		queryFn:
			traceId && spanId
				? async ({ signal }) => {
						const startMs = parseClickHouseDateTime(spanStartTime)
						const bounds =
							startMs === null
								? boundsForRange(WIDEST_RANGE)
								: {
										startTime: toClickHouseDateTime(startMs - HOUR_MS),
										endTime: toClickHouseDateTime(startMs + HOUR_MS),
									}
						const compiled = CH.compile(
							CH.logsListQuery({ traceId, spanId, limit: 100 }),
							localParams(bounds),
						)
						const rows = await executeLocalCompiledQuery(compiled, signal)
						return rows.map(normalizeLog)
					}
				: skipToken,
	})
}
