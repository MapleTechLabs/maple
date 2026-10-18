import { Layer } from "effect"
import { BillingCustomerCache } from "../data/billing-customer"
import { OrgCollections } from "../data/collections/org-collections"
import { AnomalyServiceCounts } from "../data/anomaly-service-counts"
import { IntegrationStatuses } from "../data/integration-statuses"
import { ServicesFacetsProbe } from "../data/services-facets-probe"
import { SessionTenant } from "../data/session-tenant"
import { WarehouseLive } from "../data/warehouse"
import { ApiClientsLive, MapleApiV2Client, MapleInternalApiClient } from "./api-clients"

/**
 * The runtime's `resources`: built once, shared by every Command and Subscription. The warehouse
 * batcher and the org collections are here because their state (the batch window, the synced
 * rows) must be one instance for the whole app, like apps/web's module singletons.
 */
export const ResourcesLive = Layer.mergeAll(
	ApiClientsLive,
	WarehouseLive,
	OrgCollections.layer,
	SessionTenant.layer,
	BillingCustomerCache.layer,
	ServicesFacetsProbe.layer.pipe(Layer.provide(WarehouseLive)),
	AnomalyServiceCounts.layer.pipe(Layer.provide(MapleApiV2Client.layer)),
	IntegrationStatuses.layer.pipe(Layer.provide([MapleInternalApiClient.layer, MapleApiV2Client.layer])),
)
export type Resources = Layer.Success<typeof ResourcesLive>
