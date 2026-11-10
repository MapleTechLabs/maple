// What each connected integration is and whether it is working, as reported on the wire. The
// inventory is built in `@maple/backend/services/integrations/integration-inventory`.

import { SOURCE_HEALTH_STATUSES, type SourceHealthStatus } from "./source-health"

export const INTEGRATION_PROVIDERS = [
	"github",
	"cloudflare",
	"railway",
	"planetscale",
	"prometheus",
	"chat",
	"search_console",
] as const
export type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number]

/** Worst first: a provider takes the worst status of its sources and resources. Same as a source's. */
export const INTEGRATION_STATUSES = SOURCE_HEALTH_STATUSES
export type IntegrationStatus = SourceHealthStatus

export interface IntegrationResource {
	readonly kind: string
	readonly name: string
	readonly status: IntegrationStatus
	readonly lastSuccessAt: number | null
	readonly lastError: string | null
	readonly note: string | null
}

export interface IntegrationEntry {
	readonly provider: IntegrationProvider
	readonly status: IntegrationStatus
	readonly account: string | null
	readonly connectedAt: number | null
	/** One line on why the provider is not healthy; null when it is. */
	readonly problem: string | null
	/** The Maple data and tools this integration feeds. */
	readonly feeds: ReadonlyArray<string>
	readonly resources: ReadonlyArray<IntegrationResource>
}

export interface IntegrationInventory {
	readonly integrations: ReadonlyArray<IntegrationEntry>
	/** Providers with nothing connected, and what connecting them would feed. */
	readonly available: ReadonlyArray<{
		readonly provider: IntegrationProvider
		readonly feeds: ReadonlyArray<string>
	}>
}
