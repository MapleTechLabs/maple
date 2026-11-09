import { CH } from "@maple/query-engine"
import type { TimeBounds } from "../../lib/time"
import { Effect, Array as Arr } from "effect"
import { localParams, queryRows } from "../../data/local-query"
import type { ServiceCatalogEntry } from "./model"
import { nonZeroOr } from "@maple/ui/lib/number"

// The service catalog query and `toCatalogEntry`.

/** Sampled counts win when the store estimated them. */
export const toCatalogEntry = (row: CH.ServiceCatalogOutput, logCount: number): ServiceCatalogEntry => {
	const spanCount = nonZeroOr(row.estimatedSpanCount, row.spanCount)
	const errorCount = nonZeroOr(row.estimatedErrorCount, row.errorCount)
	return {
		serviceName: row.serviceName,
		serviceNamespaces: row.serviceNamespaces,
		deploymentEnvironments: row.deploymentEnvironments,
		spanCount,
		errorCount,
		errorRate: spanCount > 0 ? errorCount / spanCount : 0,
		p50LatencyMs: row.p50LatencyMs,
		p95LatencyMs: row.p95LatencyMs,
		p99LatencyMs: row.p99LatencyMs,
		logCount,
	}
}

/** The catalog for one env/ns slice, with log volume from the usage rollup. */
export const fetchCatalog = (
	env: string | undefined,
	ns: string | undefined,
	bounds: TimeBounds,
	apiBase: string,
) =>
	Effect.gen(function* () {
		const params = localParams(bounds)
		const [catalogRows, usageRows] = yield* Effect.all(
			[
				queryRows(
					CH.compile(
						CH.serviceCatalogQuery({
							deploymentEnvironment: env,
							serviceNamespace: ns,
							limit: 200,
						}),
						params,
					),
					apiBase,
				),
				queryRows(CH.compile(CH.serviceUsageQuery({}), params), apiBase),
			],
			{ concurrency: "unbounded" },
		)
		const logsByService = new Map(Arr.map(usageRows, (row) => [row.serviceName, row.totalLogCount]))
		return Arr.map(catalogRows, (row) => toCatalogEntry(row, logsByService.get(row.serviceName) ?? 0))
	})
