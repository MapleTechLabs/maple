import { keepPreviousData, skipToken, useQuery } from "@tanstack/react-query"
import { CH } from "@maple/query-engine"
import type { FilterOption } from "@maple/ui/components/filters/filter-section"
import type { DurationStats } from "@maple/ui/components/filters/duration-range-filter"
import { boundsKey, executeLocalCompiledQuery, localParams } from "@/lib/query"
import type { TimeBounds } from "../lib/time"
import type { TraceFilters } from "./use-local-traces"

export type { DurationStats }

export interface TraceFacets {
	services: FilterOption[]
	spanNames: FilterOption[]
	httpMethods: FilterOption[]
	httpStatusCodes: FilterOption[]
	deploymentEnvs: FilterOption[]
	namespaces: FilterOption[]
	errorCount: number
	durationStats?: DurationStats
}

type FacetDimension = NonNullable<CH.TracesFacetsOpts["facet"]>

/** Facet dimension → the wire `facetType` it reports and the filter it owns. */
const DIMENSIONS: ReadonlyArray<{
	readonly dimension: FacetDimension
	readonly facetType: string
	readonly isActive: (filters: TraceFilters) => boolean
	readonly without: (opts: CH.TracesFacetsOpts, filters: TraceFilters) => CH.TracesFacetsOpts
}> = [
	{
		dimension: "service",
		facetType: "service",
		isActive: (f) => !!f.service,
		without: (opts) => ({ ...opts, serviceName: undefined }),
	},
	{
		dimension: "spanName",
		facetType: "spanName",
		isActive: (f) => !!f.span,
		// Dropping the facet pick falls back to the toolbar search, if any.
		without: (opts, f) => ({
			...opts,
			spanName: f.search,
			matchModes: f.search ? { spanName: "contains" } : undefined,
		}),
	},
	{
		dimension: "httpMethod",
		facetType: "httpMethod",
		isActive: (f) => !!f.method,
		without: (opts) => ({ ...opts, httpMethod: undefined }),
	},
	{
		dimension: "httpStatus",
		facetType: "httpStatus",
		isActive: (f) => !!f.status,
		without: (opts) => ({ ...opts, httpStatusCode: undefined }),
	},
	{
		dimension: "deploymentEnv",
		facetType: "deploymentEnv",
		isActive: (f) => !!f.env,
		without: (opts) => ({ ...opts, deploymentEnv: undefined }),
	},
	{
		dimension: "serviceNamespace",
		facetType: "serviceNamespace",
		isActive: (f) => !!f.ns,
		without: (opts) => ({ ...opts, namespace: undefined }),
	},
]

function facetOpts(filters: TraceFilters): CH.TracesFacetsOpts {
	return {
		serviceName: filters.service,
		spanName: filters.span ?? filters.search,
		matchModes: !filters.span && filters.search ? { spanName: "contains" } : undefined,
		hasError: filters.errorsOnly || undefined,
		httpMethod: filters.method,
		httpStatusCode: filters.status,
		deploymentEnv: filters.env,
		namespace: filters.ns,
		minDurationMs: filters.minDurationMs,
		maxDurationMs: filters.maxDurationMs,
	}
}

/**
 * Facet counts + duration stats for the root-trace sidebar. Every section
 * counts under all the other filters but not its own (like Sessions), so a
 * pick never collapses its own list: one union for the unfiltered dimensions,
 * plus one single-branch query per dimension that has a value picked.
 */
export function useLocalTraceFacets(filters: TraceFilters, bounds: TimeBounds, enabled = true) {
	return useQuery<TraceFacets>({
		queryKey: ["local", "trace-facets", filters, boundsKey(bounds)],
		staleTime: 15_000,
		placeholderData: keepPreviousData,
		queryFn: !enabled
			? skipToken
			: async ({ signal }) => {
					const params = localParams(bounds)
					const opts = facetOpts(filters)
					const active = DIMENSIONS.filter((d) => d.isActive(filters))
					const [mainRows, statsRows, ...ownRows] = await Promise.all([
						executeLocalCompiledQuery(
							CH.compileUnion(CH.tracesFacetsQuery(opts), params),
							signal,
						),
						executeLocalCompiledQuery(
							CH.compile(
								CH.tracesDurationStatsQuery({
									...opts,
									minDurationMs: undefined,
									maxDurationMs: undefined,
								}),
								params,
							),
							signal,
						),
						...active.map((d) =>
							executeLocalCompiledQuery(
								CH.compileUnion(
									CH.tracesFacetsQuery({ ...d.without(opts, filters), facet: d.dimension }),
									params,
								),
								signal,
							),
						),
					])

					const rowsFor = (facetType: string): FilterOption[] => {
						const index = active.findIndex((d) => d.facetType === facetType)
						const rows = index === -1 ? mainRows : (ownRows[index] ?? [])
						return rows
							.filter((row) => row.facetType === facetType && row.name)
							.map((row) => ({ name: row.name, count: Number(row.count) }))
					}

					return {
						services: rowsFor("service"),
						spanNames: rowsFor("spanName"),
						httpMethods: rowsFor("httpMethod"),
						httpStatusCodes: rowsFor("httpStatus"),
						deploymentEnvs: rowsFor("deploymentEnv"),
						namespaces: rowsFor("serviceNamespace"),
						errorCount: Number(
							mainRows.find((row) => row.facetType === "errorCount")?.count ?? 0,
						),
						durationStats: toDurationStats(statsRows[0]),
					}
				},
	})
}

/**
 * An empty window yields a zero/NaN aggregate row (ClickHouse encodes NaN
 * quantiles as null in JSON); drop the stats instead of rendering bogus hints.
 */
function toDurationStats(row: CH.TracesDurationStatsOutput | undefined): DurationStats | undefined {
	if (!row) return undefined
	const stats = {
		minDurationMs: Number(row.minDurationMs),
		maxDurationMs: Number(row.maxDurationMs),
		p50DurationMs: Number(row.p50DurationMs),
		p95DurationMs: Number(row.p95DurationMs),
	}
	const values = Object.values(stats)
	if (values.some((v) => !Number.isFinite(v)) || stats.maxDurationMs <= 0) return undefined
	return stats
}
