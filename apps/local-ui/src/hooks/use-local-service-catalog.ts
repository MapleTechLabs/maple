import { useMemo } from "react"
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { CH } from "@maple/query-engine"
import { boundsKey, executeLocalCompiledQuery, localParams } from "@/lib/query"
import type { TimeBounds } from "../lib/time"

export interface ServiceCatalogFilters {
	/** Exact `deployment.environment` resource attribute. */
	env?: string
	/** Exact `service.namespace` resource attribute. */
	ns?: string
	/** Substring match on the service name (client-side). */
	search?: string
}

export interface ServiceCatalogEntry {
	serviceName: string
	serviceNamespaces: readonly string[]
	deploymentEnvironments: readonly string[]
	spanCount: number
	errorCount: number
	errorRate: number
	p50LatencyMs: number
	p95LatencyMs: number
	p99LatencyMs: number
	/** Log volume from the usage rollup (0 when the service has none). */
	logCount: number
}

export function toCatalogEntry(row: CH.ServiceCatalogOutput, logCount: number): ServiceCatalogEntry {
	const spanCount = Number(row.estimatedSpanCount) || Number(row.spanCount)
	const errorCount = Number(row.estimatedErrorCount) || Number(row.errorCount)
	return {
		serviceName: row.serviceName,
		serviceNamespaces: row.serviceNamespaces,
		deploymentEnvironments: row.deploymentEnvironments,
		spanCount,
		errorCount,
		errorRate: spanCount > 0 ? errorCount / spanCount : 0,
		p50LatencyMs: Number(row.p50LatencyMs),
		p95LatencyMs: Number(row.p95LatencyMs),
		p99LatencyMs: Number(row.p99LatencyMs),
		logCount,
	}
}

function useCatalog(env: string | undefined, ns: string | undefined, bounds: TimeBounds) {
	return useQuery({
		queryKey: ["local", "services", "catalog", env ?? null, ns ?? null, boundsKey(bounds)],
		placeholderData: keepPreviousData,
		queryFn: async ({ signal }): Promise<ReadonlyArray<ServiceCatalogEntry>> => {
			const params = localParams(bounds)
			const [catalogRows, usageRows] = await Promise.all([
				executeLocalCompiledQuery(
					CH.compile(
						CH.serviceCatalogQuery({
							deploymentEnvironment: env,
							serviceNamespace: ns,
							limit: 200,
						}),
						params,
					),
					signal,
				),
				executeLocalCompiledQuery(CH.compile(CH.serviceUsageQuery({}), params), signal),
			])
			const logsByService = new Map(
				usageRows.map((row) => [row.serviceName, Number(row.totalLogCount)]),
			)
			return catalogRows.map((row) => toCatalogEntry(row, logsByService.get(row.serviceName) ?? 0))
		},
	})
}

function countBy(
	entries: ReadonlyArray<ServiceCatalogEntry>,
	pick: (e: ServiceCatalogEntry) => readonly string[],
) {
	const counts = new Map<string, number>()
	for (const entry of entries) for (const name of pick(entry)) counts.set(name, (counts.get(name) ?? 0) + 1)
	return [...counts.entries()]
		.map(([name, count]) => ({ name, count }))
		.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}

/**
 * Service catalog for the services list. Rows come from the env/ns-filtered
 * query (its numbers are for that slice); facets come from the unfiltered one,
 * each counted under the other facet only. With no filter both are one query.
 */
export function useLocalServiceCatalog(filters: ServiceCatalogFilters, bounds: TimeBounds) {
	const { env, ns, search } = filters
	const filtered = useCatalog(env, ns, bounds)
	const unfiltered = useCatalog(undefined, undefined, bounds)

	const entries = useMemo(() => {
		const all = filtered.data ?? []
		const needle = search?.toLowerCase()
		return needle ? all.filter((e) => e.serviceName.toLowerCase().includes(needle)) : all
	}, [filtered.data, search])

	const facets = useMemo(() => {
		const all = unfiltered.data ?? []
		return {
			envFacets: countBy(
				ns ? all.filter((e) => e.serviceNamespaces.includes(ns)) : all,
				(e) => e.deploymentEnvironments,
			),
			nsFacets: countBy(
				env ? all.filter((e) => e.deploymentEnvironments.includes(env)) : all,
				(e) => e.serviceNamespaces,
			),
		}
	}, [unfiltered.data, env, ns])

	return {
		query: filtered,
		facetsFetching: unfiltered.isFetching,
		entries,
		...facets,
		totalErrorCount: entries.reduce((sum, e) => sum + e.errorCount, 0),
	}
}
