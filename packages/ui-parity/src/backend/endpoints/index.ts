import { Effect } from "effect"
import type { EndpointHandler } from "../../fixtures/dataset.ts"
import type { FixtureWarehouse } from "../warehouse.ts"
import { errorIssueEndpoints } from "./error-issues.ts"
import { infraEndpoints } from "./infra.ts"
import { operationEndpoints } from "./operations.ts"
import { serviceEndpoints } from "./services.ts"
import { signalEndpoints } from "./signals.ts"
import { traceEndpoints } from "./traces.ts"

/**
 * Integration reads use `@maple/query-engine-integrations` SQL over `cloudflare.*`, `planetscale_*`
 * and `railway.*` metrics, which no fixture dataset carries, so they answer the empty result.
 */
const noIntegrationRows: EndpointHandler = () => Effect.succeed({ data: [] })

/** Every dedicated warehouse endpoint, keyed `"<group>.<endpoint>"` like the defaults. */
export const warehouseEndpoints = (warehouse: FixtureWarehouse): ReadonlyMap<string, EndpointHandler> =>
	new Map(
		Object.entries({
			...serviceEndpoints(warehouse),
			...operationEndpoints(warehouse),
			...traceEndpoints(warehouse),
			...signalEndpoints(warehouse),
			...errorIssueEndpoints(warehouse),
			...infraEndpoints(warehouse),
			"queryEngine.serviceCloudflareStats": noIntegrationRows,
			"queryEngine.servicePlanetScaleStats": noIntegrationRows,
			"queryEngine.railwayInfraServices": noIntegrationRows,
			// `gcpInfraPresence` reads `gcp.*` poller metrics, which no dataset carries.
			"queryEngine.gcpInfraPresence": () => Effect.succeed({ services: [] }),
			"queryEngine.cloudflareInfraZones": () => Effect.succeed({ data: [], ignoredFilters: [] }),
		}),
	)
