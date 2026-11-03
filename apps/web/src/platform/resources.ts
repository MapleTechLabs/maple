import { Layer } from "effect"
import * as SecureRandom from "effect/crypto/SecureRandom"
import { BillingCustomerCache } from "../data/billing-customer"
import { OrgCollections } from "../data/collections/org-collections"
import { ReadCache } from "../data/read-cache"
import { IntegrationStatuses } from "../data/integration-statuses"
import { LogSourceLive } from "../data/log-source"
import { SessionTenant } from "../data/session-tenant"
import { TraceSourceLive } from "../data/trace-source"
import { WarehouseLive } from "../data/warehouse"
import { ApiClientsLive, MapleApiV2Client, MapleInternalApiClient } from "./api-clients"

/**
 * The runtime's `resources`: built once, shared by every Command and Subscription. The warehouse
 * batcher and the org collections are here because their state (the batch window, the synced
 * rows) must be one instance for the whole app.
 */
export const ResourcesLive = Layer.mergeAll(
	ApiClientsLive,
	// The trace and log views' sources share the one warehouse batcher.
	Layer.mergeAll(TraceSourceLive, LogSourceLive).pipe(Layer.provideMerge(WarehouseLive)),
	OrgCollections.layer,
	SessionTenant.layer,
	ReadCache.layer,
	BillingCustomerCache.layer,
	IntegrationStatuses.layer.pipe(Layer.provide([MapleInternalApiClient.layer, MapleApiV2Client.layer])),
	SecureRandom.layerWebCrypto,
)
export type Resources = Layer.Success<typeof ResourcesLive>
