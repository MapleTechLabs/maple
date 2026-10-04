import * as Context from "effect/Context"
import * as Layer from "effect/Layer"

declare global {
	// The DOM lib omits `caches.default`; this matches workers-types' declaration exactly so
	// it merges cleanly under both configs.
	interface CacheStorage {
		readonly default: Cache
	}
}

/** `caches.default` as a service, or `null` outside a Workers runtime. */
export class WorkersCache extends Context.Service<WorkersCache, Cache | null>()("@maple/infra/WorkersCache") {
	static readonly layer: Layer.Layer<WorkersCache> = Layer.sync(this, () =>
		typeof caches !== "undefined" ? caches.default : null,
	)
}
