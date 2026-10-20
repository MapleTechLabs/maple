import { getServicesFacets } from "@maple/web-data/warehouse/services"
import { Effect, Schema } from "effect"
import { IdleTtl } from "./idle-ttl"
import { ReadCache } from "./read-cache"
import type { RequestKey } from "./request-key"
import type { TimeWindow } from "./time-range"

/** The operation the pages key the facets slot under: `requestKey(org, SERVICES_FACETS, { data })`. */
export const SERVICES_FACETS = "getServicesFacets"

const FacetItem = Schema.Struct({ name: Schema.String, count: Schema.Number })

/** `ServicesFacetsResponse` (`@maple/web-data/warehouse/services`), as the cache checks it. */
export const ServicesFacetsResponse = Schema.Struct({
	data: Schema.Struct({
		environments: Schema.Array(FacetItem),
		namespaces: Schema.Array(FacetItem),
		commitShas: Schema.Array(FacetItem),
		services: Schema.Array(FacetItem),
	}),
})

/**
 * `getServicesFacetsResultAtom({ data: window })`, which the Overview, the services list, the shell's
 * namespace list and the chat read: through the read cache, so one window is requested once.
 */
export const loadServicesFacets = (
	window: TimeWindow,
	options?: { readonly refresh?: boolean; readonly key?: RequestKey; readonly orgId?: string },
) =>
	Effect.flatMap(Effect.service(ReadCache), (cache) => {
		const spec = {
			idleTtlMs: IdleTtl.servicesFacets,
			schema: ServicesFacetsResponse,
			refresh: options?.refresh === true,
		}
		const load = getServicesFacets({ data: window })
		// A page passes its slot key (its org); the shell and the chat read under the open org.
		return options?.key === undefined
			? cache.readInOrg(
					{
						...spec,
						operation: SERVICES_FACETS,
						input: { data: window },
						orgId: options?.orgId,
					},
					load,
				)
			: cache.read({ ...spec, key: options.key }, load)
	})
