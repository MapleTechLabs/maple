import { Layer } from "effect"
import { OrgCollections } from "../data/collections/org-collections"
import { WarehouseLive } from "../data/warehouse"
import { ApiClientsLive } from "./api-clients"

/**
 * The runtime's `resources`: built once, shared by every Command and Subscription. The warehouse
 * batcher and the org collections are here because their state (the batch window, the synced
 * rows) must be one instance for the whole app, like apps/web's module singletons.
 */
export const ResourcesLive = Layer.mergeAll(ApiClientsLive, WarehouseLive, OrgCollections.layer)
export type Resources = Layer.Success<typeof ResourcesLive>
