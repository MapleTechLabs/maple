// Wiring an SDK preset (Foldkit) hands to `MapleFlush.make`, kept off its public signature.
import type { SpanLink } from "@maple/sdk-core"
import type { MapleClientFlushableConfig } from "./flushable.js"

export interface FlushableIntegration {
	/** The page load's span, which web vitals link to. */
	readonly pageloadLink?: (() => SpanLink | undefined) | undefined
}

const integrations = new WeakMap<MapleClientFlushableConfig, FlushableIntegration>()

/** Returns `config` itself, tagged with `integration` for `MapleFlush.make` to read. */
export const withIntegration = (
	config: MapleClientFlushableConfig,
	integration: FlushableIntegration,
): MapleClientFlushableConfig => {
	integrations.set(config, integration)
	return config
}

export const integrationOf = (config: MapleClientFlushableConfig): FlushableIntegration =>
	integrations.get(config) ?? {}
