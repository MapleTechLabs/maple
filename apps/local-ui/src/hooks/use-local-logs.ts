import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query"
import { CH } from "@maple/query-engine"
import type { FilterOption } from "@maple/ui/components/filters/filter-section"
import { boundsKey, executeLocalCompiledQuery, localParams, noCursor } from "@/lib/query"
import { compareSeverity, normalizeLog, type LocalLog } from "../lib/log-shape"
import type { TimeBounds } from "../lib/time"

const PAGE_SIZE = 50

export interface LogFilters {
	/** Exact service name match. */
	service?: string
	/** Exact severity text match (e.g. `ERROR`). */
	severity?: string
	/** Substring match on the log body. */
	search?: string
}

type LogCursor = NonNullable<CH.LogsListOpts["cursorIdentity"]>

/**
 * Infinite log stream, newest first. Keyset pagination on the full row
 * identity: a bare timestamp cursor drops every row that shares the boundary
 * timestamp, which batched exporters produce all the time.
 */
export function useLocalLogs(filters: LogFilters, bounds: TimeBounds) {
	return useInfiniteQuery({
		queryKey: ["local", "logs", filters, boundsKey(bounds)],
		initialPageParam: noCursor<LogCursor>(),
		placeholderData: keepPreviousData,
		queryFn: async ({ pageParam, signal }): Promise<ReadonlyArray<LocalLog>> => {
			const compiled = CH.compile(
				CH.logsListQuery({
					limit: PAGE_SIZE,
					cursorIdentity: pageParam,
					serviceName: filters.service,
					severity: filters.severity,
					search: filters.search,
				}),
				localParams(bounds),
			)
			const rows = await executeLocalCompiledQuery(compiled, signal)
			return rows.map(normalizeLog)
		},
		getNextPageParam: (lastPage): LogCursor | undefined => {
			const last = lastPage.length === PAGE_SIZE ? lastPage[lastPage.length - 1] : undefined
			return last
				? {
						timestamp: last.timestamp,
						serviceName: last.serviceName,
						traceId: last.traceId,
						spanId: last.spanId,
						recordIdentity: last.recordIdentity,
					}
				: undefined
		},
	})
}

/**
 * Severity facet: counts under every filter except severity itself, so picking
 * one level never collapses the list of levels. Ordered by level, not count.
 */
export function useLocalLogSeverities(filters: LogFilters, bounds: TimeBounds) {
	return useQuery<ReadonlyArray<FilterOption>>({
		queryKey: [
			"local",
			"log-severities",
			filters.service ?? null,
			filters.search ?? null,
			boundsKey(bounds),
		],
		staleTime: 60_000,
		placeholderData: keepPreviousData,
		queryFn: async ({ signal }) => {
			const compiled = CH.compile(
				CH.logsBreakdownQuery({
					groupBy: "severity",
					limit: 20,
					serviceName: filters.service,
					search: filters.search,
				}),
				localParams(bounds),
			)
			const rows = await executeLocalCompiledQuery(compiled, signal)
			return rows
				.filter((row) => row.name)
				.map((row) => ({ name: row.name, count: Number(row.count) }))
				.sort((a, b) => compareSeverity(a.name, b.name))
		},
	})
}
