import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { CH } from "@maple/query-engine"
import type { FilterOption } from "@maple/ui/components/filters/filter-section"
import { boundsKey, executeLocalCompiledQuery, localParams } from "@/lib/query"
import type { TimeBounds } from "../lib/time"
import type { LogFilters } from "./use-local-logs"

/**
 * Distinct services that emitted logs in the selected window, under every log
 * filter except the service itself. Scans the same raw table and exact bounds
 * as the rendered list, so hourly aggregates can never add or hide an option.
 */
export function compileLocalLogServicesQuery(
	startTime: string,
	endTime: string,
	filters: Pick<LogFilters, "severity" | "search"> = {},
) {
	return CH.compile(
		CH.logsBreakdownQuery({
			groupBy: "service",
			limit: null,
			source: "raw",
			severity: filters.severity,
			search: filters.search,
		}),
		localParams({ startTime, endTime }),
	)
}

export function useLocalLogServices(filters: LogFilters, bounds: TimeBounds) {
	return useQuery<ReadonlyArray<FilterOption>>({
		queryKey: [
			"local",
			"logs",
			"services",
			filters.severity ?? null,
			filters.search ?? null,
			boundsKey(bounds),
		],
		staleTime: 60_000,
		placeholderData: keepPreviousData,
		queryFn: async ({ signal }) => {
			const compiled = compileLocalLogServicesQuery(bounds.startTime, bounds.endTime, filters)
			const rows = await executeLocalCompiledQuery(compiled, signal)
			return rows.filter((row) => row.name).map((row) => ({ name: row.name, count: Number(row.count) }))
		},
	})
}
