import { useQuery } from "@tanstack/react-query"
import { CH } from "@maple/query-engine"
import type { ServicesFacetsOutput } from "@maple/query-engine/ch"
import { executeLocalQuery } from "../lib/local-query-client"
import { LOCAL_ORG_ID } from "../lib/constants"
import { boundsForRange } from "../lib/time"
import type { FilterOption } from "../components/filter-section"

/**
 * Distinct service names in the window, shaped as filter options. Drives the
 * "Service" facet on the Traces and Logs sidebars. Backed by the
 * service_overview MV scan, so it's cheap to refresh alongside the list.
 */
export function useLocalServices(range: string | undefined) {
	return useQuery<ReadonlyArray<FilterOption>>({
		queryKey: ["local", "services", range],
		staleTime: 60_000,
		queryFn: async () => {
			const { startTime, endTime } = boundsForRange(range)
			const compiled = CH.compileUnion(CH.servicesFacetsQuery(), {
				orgId: LOCAL_ORG_ID,
				startTime,
				endTime,
			})
			const rows = compiled.castRows(
				await executeLocalQuery(compiled.sql),
			) as ReadonlyArray<ServicesFacetsOutput>
			return rows
				.filter((row) => row.facetType === "service" && row.name)
				.map((row) => ({ name: row.name, count: row.count }))
		},
	})
}
