import type { JsonValue } from "./model"
import type { SignalProjector } from "./registry"

/** The host owns the registry; extensions contribute implementations, not runtime services. */
export interface RegisterProjector {
	<TConfig, TData extends JsonValue>(projector: SignalProjector<TConfig, TData>): void
}

/**
 * Default export of a trusted, local projector module. Bundle runtime dependencies
 * into an ESM file; this type can be imported with `import type` by its author.
 * Registration finishes before saved projections are compiled and ingest starts.
 */
export interface ProjectorModule {
	readonly apiVersion: 1
	readonly register: (register: RegisterProjector) => void | Promise<void>
}
