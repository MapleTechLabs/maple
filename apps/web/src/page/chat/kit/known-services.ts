import { formatWarehouseDateTime, snapRangeForCache } from "@maple/query-engine"
import { Clock, Effect } from "effect"
import { loadServicesFacets } from "../../../data/services-facets-probe"

/**
 * `KnownServicesProvider`: the org's service names from the snapped 24 h services facets probe the
 * overview also runs (shared, so one request). A failure leaves table cells as plain text.
 */
export const loadKnownServices = Effect.gen(function* () {
	const end = yield* Clock.currentTimeMillis
	const range = snapRangeForCache({
		startTime: formatWarehouseDateTime(end - 24 * 60 * 60 * 1000),
		endTime: formatWarehouseDateTime(end),
	})
	const response = yield* loadServicesFacets(range)
	return response.data.services.map((service) => service.name).filter((name) => name !== "")
}).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))
