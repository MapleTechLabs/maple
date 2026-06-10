import { useInfiniteQuery } from "@tanstack/react-query"
import { CH } from "@maple/query-engine"
import { executeLocalCompiledQuery } from "@/lib/query"
import { LOCAL_ORG_ID } from "../lib/constants"
import { boundsForRange } from "../lib/time"

const PAGE_SIZE = 25

export interface TraceFilters {
	/** Exact service name match. */
	service?: string
	/** Substring match on the root span name (toolbar search). */
	search?: string
	/**
	 * Exact root span name (sidebar facet). Wins over `search` — the engine
	 * accepts a single spanName, and the facet pick is the more specific intent.
	 * Note the trace_list_mv facet derives HTTP span names ("GET /route") while
	 * the list query matches raw SpanName, so a derived pick can return zero
	 * rows for HTTP spans — same behavior as the web app.
	 */
	span?: string
	/** Restrict to traces whose root span errored. */
	errorsOnly?: boolean
	/** Exact `http.method` span attribute on the root span. */
	method?: string
	/** Exact `http.status_code` span attribute on the root span. */
	status?: string
	/** Exact `deployment.environment` resource attribute. */
	env?: string
	/** Exact `service.namespace` resource attribute. */
	ns?: string
	/** Minimum root span duration in milliseconds. */
	minDurationMs?: number
	/** Maximum root span duration in milliseconds. */
	maxDurationMs?: number
	/** Time-range preset key (see `TIME_RANGES`). */
	range?: string
}

/**
 * Infinite list of root traces, newest first. Uses keyset (cursor) pagination
 * on the root span `Timestamp` — the cursor is the last row's `startTime`.
 */
export function useLocalTraces(filters: TraceFilters) {
	return useInfiniteQuery({
		queryKey: ["local", "traces", filters],
		initialPageParam: undefined as string | undefined,
		queryFn: async ({ pageParam }) => {
			const { startTime, endTime } = boundsForRange(filters.range)
			// HTTP method/status have no first-class list opts — the web app
			// filters them via span attribute filters too (`http.method` /
			// `http.status_code`, old-semconv keys only, matching prod).
			const attributeFilters = [
				...(filters.method
					? [{ key: "http.method", value: filters.method, mode: "equals" as const }]
					: []),
				...(filters.status
					? [{ key: "http.status_code", value: filters.status, mode: "equals" as const }]
					: []),
			]
			const compiled = CH.compile(
				CH.tracesRootListQuery({
					limit: PAGE_SIZE,
					cursor: pageParam,
					serviceName: filters.service,
					spanName: filters.span ?? filters.search,
					matchModes: !filters.span && filters.search ? { spanName: "contains" } : undefined,
					errorsOnly: filters.errorsOnly,
					environments: filters.env ? [filters.env] : undefined,
					namespaces: filters.ns ? [filters.ns] : undefined,
					minDurationMs: filters.minDurationMs,
					maxDurationMs: filters.maxDurationMs,
					attributeFilters: attributeFilters.length > 0 ? attributeFilters : undefined,
				}),
				{ orgId: LOCAL_ORG_ID, startTime, endTime },
			)
			return executeLocalCompiledQuery(compiled)
		},
		getNextPageParam: (lastPage) =>
			lastPage.length === PAGE_SIZE ? lastPage[lastPage.length - 1]?.startTime : undefined,
	})
}
