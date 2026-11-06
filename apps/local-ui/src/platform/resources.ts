import { Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { LocalQueryCache } from "../data/query-cache"
import { LogSourceLocal } from "../data/log-source"
import { TraceSourceLocal } from "../data/trace-source"

/**
 * The runtime's `resources`: the HTTP client every `/local/*` Command runs on, the result cache,
 * and the trace and log views' sources over both.
 */
export const ResourcesLive = Layer.mergeAll(TraceSourceLocal, LogSourceLocal).pipe(
	Layer.provideMerge(Layer.mergeAll(FetchHttpClient.layer, LocalQueryCache.layer)),
)
export type Resources = Layer.Success<typeof ResourcesLive>
