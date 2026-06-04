import { useQuery } from "@tanstack/react-query"
import { CH } from "@maple/query-engine"
import { executeLocalCompiledQuery } from "@/lib/query"
import { LOCAL_ORG_ID } from "../lib/constants"
import { toClickHouseDateTime } from "../lib/time"
import { normalizeLog, type LocalLog } from "../lib/log-shape"

/**
 * Logs emitted within a single span, newest first. Powers the "Logs" tab of the
 * span detail panel. The list query needs time bounds, so we span the full
 * history (epoch → now+1h) — the `(TraceId, SpanId)` filter keeps the scan tiny
 * on local data regardless of window width.
 */
export function useLocalSpanLogs(traceId: string | undefined, spanId: string | undefined) {
	return useQuery<ReadonlyArray<LocalLog>>({
		queryKey: ["local", "span-logs", traceId, spanId],
		enabled: !!traceId && !!spanId,
		queryFn: async () => {
			const startTime = toClickHouseDateTime(0)
			const endTime = toClickHouseDateTime(Date.now() + 60 * 60 * 1000)
			const compiled = CH.compile(
				CH.logsListQuery({ traceId: traceId!, spanId: spanId!, limit: 100 }),
				{ orgId: LOCAL_ORG_ID, startTime, endTime },
			)
			const rows = await executeLocalCompiledQuery(compiled)
			return rows.map(normalizeLog)
		},
	})
}
