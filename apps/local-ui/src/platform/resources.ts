import { Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { LocalQueryCache } from "../data/query-cache"

/** The runtime's `resources`: the HTTP client every `/local/*` Command runs on, and the result cache. */
export const ResourcesLive = Layer.mergeAll(FetchHttpClient.layer, LocalQueryCache.layer)
export type Resources = Layer.Success<typeof ResourcesLive>
