import { QueryEngineExecuteRequest } from "@maple/query-engine"
import { Effect, Schema } from "effect"
import type { TimeWindow } from "../time-range"
import { extractFacets, WarehouseExecutor } from "../warehouse"

// copied from apps/web/src/api/warehouse/services.ts (`getServicesFacets`): that module cannot be
// imported (effect-utils pulls in the React atom registry). Phase 1 extracts it; see s6-data.md.

const FacetCount = Schema.Struct({ name: Schema.String, count: Schema.Number })

export const ServicesFacets = Schema.Struct({
	environments: Schema.Array(FacetCount),
	namespaces: Schema.Array(FacetCount),
	commitShas: Schema.Array(FacetCount),
	services: Schema.Array(FacetCount),
})
export type ServicesFacets = typeof ServicesFacets.Type

const groupOf = (facetType: string): keyof ServicesFacets | undefined => {
	switch (facetType) {
		case "environment":
			return "environments"
		case "namespace":
			return "namespaces"
		case "commitSha":
		case "commit_sha":
			return "commitShas"
		case "service":
			return "services"
		default:
			return undefined
	}
}

export const servicesFacets = (window: TimeWindow) =>
	Effect.gen(function* () {
		const warehouse = yield* WarehouseExecutor
		const response = yield* warehouse.execute(
			"queryEngine.getServicesFacets",
			new QueryEngineExecuteRequest({
				startTime: window.startTime,
				endTime: window.endTime,
				query: { kind: "facets", source: "services" },
			}),
		)
		const rows = extractFacets(response)
		const pick = (group: keyof ServicesFacets) =>
			rows
				.filter((row) => groupOf(row.facetType) === group)
				.map((row) => ({ name: row.name, count: Number(row.count) }))
		return {
			environments: pick("environments"),
			namespaces: pick("namespaces"),
			commitShas: pick("commitShas"),
			services: pick("services"),
		} satisfies ServicesFacets
	})
