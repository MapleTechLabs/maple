import { CH } from "@maple/query-engine"
import type { TimeBounds } from "../../lib/time"
import { Effect, Option } from "effect"
import { localParams, queryRows } from "../../data/local-query"
import type { TraceFilters } from "./filters"
import type { DurationStats, FacetOption, TraceFacets } from "./model"

// The trace facets: every section counts under all the other
// filters but not its own: one union for the rest, one single-branch query per picked dimension.

type FacetDimension = NonNullable<CH.TracesFacetsOpts["facet"]>

const DIMENSIONS: ReadonlyArray<{
	readonly dimension: FacetDimension
	readonly facetType: string
	readonly isActive: (filters: TraceFilters) => boolean
	readonly without: (opts: CH.TracesFacetsOpts, filters: TraceFilters) => CH.TracesFacetsOpts
}> = [
	{ dimension: "service", facetType: "service", isActive: (f) => !!f.service, without: (opts) => ({ ...opts, serviceName: undefined }) },
	{
		dimension: "spanName",
		facetType: "spanName",
		isActive: (f) => !!f.span,
		// Dropping the facet pick falls back to the toolbar search, if any.
		without: (opts, f) => ({ ...opts, spanName: f.search, matchModes: f.search ? { spanName: "contains" } : undefined }),
	},
	{ dimension: "httpMethod", facetType: "httpMethod", isActive: (f) => !!f.method, without: (opts) => ({ ...opts, httpMethod: undefined }) },
	{ dimension: "httpStatus", facetType: "httpStatus", isActive: (f) => !!f.status, without: (opts) => ({ ...opts, httpStatusCode: undefined }) },
	{ dimension: "deploymentEnv", facetType: "deploymentEnv", isActive: (f) => !!f.env, without: (opts) => ({ ...opts, deploymentEnv: undefined }) },
	{ dimension: "serviceNamespace", facetType: "serviceNamespace", isActive: (f) => !!f.ns, without: (opts) => ({ ...opts, namespace: undefined }) },
]

const facetOpts = (filters: TraceFilters): CH.TracesFacetsOpts => ({
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
})

/** An empty window yields a zero/NaN aggregate row; drop the stats instead of bogus hints. */
const toDurationStats = (row: CH.TracesDurationStatsOutput | undefined): Option.Option<DurationStats> => {
	if (!row) return Option.none()
	const stats = {
		minDurationMs: row.minDurationMs,
		maxDurationMs: row.maxDurationMs,
		p50DurationMs: row.p50DurationMs,
		p95DurationMs: row.p95DurationMs,
	}
	const values = Object.values(stats)
	return values.some((v) => !Number.isFinite(v)) || stats.maxDurationMs <= 0 ? Option.none() : Option.some(stats)
}

export const fetchTraceFacets = (filters: TraceFilters, bounds: TimeBounds, apiBase: string) =>
	Effect.gen(function* () {
		const params = localParams(bounds)
		const opts = facetOpts(filters)
		const active = DIMENSIONS.filter((d) => d.isActive(filters))
		const [mainRows, statsRows, ownRows] = yield* Effect.all(
			[
				queryRows(CH.compileUnion(CH.tracesFacetsQuery(opts), params), apiBase),
				queryRows(
					CH.compile(
						CH.tracesDurationStatsQuery({ ...opts, minDurationMs: undefined, maxDurationMs: undefined }),
						params,
					),
					apiBase,
				),
				Effect.forEach(
					active,
					(d) =>
						queryRows(
							CH.compileUnion(CH.tracesFacetsQuery({ ...d.without(opts, filters), facet: d.dimension }), params),
							apiBase,
						),
					{ concurrency: "unbounded" },
				),
			],
			{ concurrency: "unbounded" },
		)
		const rowsFor = (facetType: string): Array<FacetOption> => {
			const index = active.findIndex((d) => d.facetType === facetType)
			const rows = index === -1 ? mainRows : (ownRows[index] ?? [])
			return rows
				.filter((row) => row.facetType === facetType && row.name)
				.map((row) => ({ name: row.name, count: row.count }))
		}
		const facets: TraceFacets = {
			services: rowsFor("service"),
			spanNames: rowsFor("spanName"),
			httpMethods: rowsFor("httpMethod"),
			httpStatusCodes: rowsFor("httpStatus"),
			deploymentEnvs: rowsFor("deploymentEnv"),
			namespaces: rowsFor("serviceNamespace"),
			errorCount: mainRows.find((row) => row.facetType === "errorCount")?.count ?? 0,
			maybeDurationStats: toDurationStats(statsRows[0]),
		}
		return facets
	})
