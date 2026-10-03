import { Effect, Schema } from "effect"
import { QueryEngineService } from "@maple/backend/services/warehouse/QueryEngineService"
import { exploreAttributeKeys } from "@maple/query-engine/observability"
import { QuerySpec } from "@maple/query-engine"
import { CurrentMcpTenant, queryWarehouse, withTenantExecutor } from "./query-warehouse"
import { missingFilterHints, type KnownValues, type RequestedFilters } from "./filter-suggestions"

// services_facets caps each facet at 50 rows.
const FACET_CAP = 50
const decodeQuerySpec = Schema.decodeUnknownEffect(QuerySpec)

interface Window {
	readonly startTime: string
	readonly endTime: string
}

interface FacetRow {
	readonly facetType: string
	readonly name: string
}

const facets = (window: Window) =>
	queryWarehouse<FacetRow>("services_facets", { start_time: window.startTime, end_time: window.endTime }).pipe(
		Effect.map(({ data }): KnownValues => {
			const of = (type: string) => data.filter((r) => r.facetType === type).map((r) => String(r.name))
			const services = of("service")
			const environments = of("environment")
			return {
				services,
				servicesComplete: services.length < FACET_CAP,
				environments,
				environmentsComplete: environments.length < FACET_CAP,
			}
		}),
	)

const attributeKeys = (window: Window, service: string | undefined) =>
	Effect.forEach(["span", "resource"] as const, (scope) =>
		withTenantExecutor(
			exploreAttributeKeys({
				source: "traces",
				scope,
				service,
				timeRange: window,
				limit: 500,
			}),
		),
	).pipe(Effect.map((lists): KnownValues => ({ attributeKeys: lists.flat().map((k) => k.key) })))

const spanNames = (window: Window, service: string | undefined) =>
	Effect.gen(function* () {
		const query = yield* decodeQuerySpec({
			kind: "breakdown",
			source: "traces",
			metric: "count",
			groupBy: "span_name",
			limit: 100,
			...(service === undefined ? undefined : { filters: { serviceName: service } }),
		})
		const tenant = yield* CurrentMcpTenant
		const engine = yield* QueryEngineService
		const response = yield* engine.execute(tenant, { ...window, query })
		const names = response.result.kind === "breakdown" ? response.result.data.map((d) => d.name) : []
		return { spanNames: names } satisfies KnownValues
	})

/**
 * Hints for the filters of an empty result whose value does not exist in the
 * window. Best effort: a lookup that fails contributes no hint, never an error.
 */
export const emptyResultHints = (
	requested: RequestedFilters,
	window: Window,
	options: { readonly traceKeys?: boolean } = {},
) =>
	Effect.gen(function* () {
		const soft = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
			effect.pipe(Effect.orElseSucceed((): KnownValues => ({})))
		const needsFacets = requested.service !== undefined || (requested.environments?.length ?? 0) > 0
		const lookups = [
			needsFacets ? soft(facets(window)) : undefined,
			requested.attributeKey !== undefined && options.traceKeys !== false
				? soft(attributeKeys(window, undefined))
				: undefined,
			requested.spanName !== undefined ? soft(spanNames(window, requested.service)) : undefined,
		].filter((lookup) => lookup !== undefined)
		const known = yield* Effect.all(lookups, { concurrency: "unbounded" })
		return missingFilterHints(
			requested,
			known.reduce<KnownValues>((acc, values) => ({ ...acc, ...values }), {}),
		)
	}).pipe(Effect.withSpan("McpTool.emptyResultHints"))
