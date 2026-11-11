// The port every cost provider implements. The sync owns sources, leases, versions and the
// warehouse write; a provider only turns a window of whole UTC days into rows.
import type { CostBasis, CostChargeCategory, CostProvider } from "@maple/domain/cost"
import type { OrgId } from "@maple/primitives"
import { CostProvider as CostProviderSchema } from "@maple/domain/cost"
import { type Effect, Schema } from "effect"

/** Whole UTC days, both inclusive, as `YYYY-MM-DD`. */
export interface CostPullWindow {
	readonly startDay: string
	readonly endDay: string
}

/** The source a pull reads: the provider's own connection row, by id. */
export interface CostPullSource {
	readonly orgId: OrgId
	readonly connectionRef: string
}

/** One `cost_daily` row, less what the sync stamps (org, source, provider, pull version). */
export interface CostPullRow {
	/** The usage day, `YYYY-MM-DD` UTC. */
	readonly day: string
	readonly accountId: string
	/** The provider's own service name. */
	readonly cloudService: string
	readonly serviceCategory: string
	readonly usageType: string
	/** '' or 'global' for a charge with no region. */
	readonly region: string
	readonly resourceId: string
	readonly resourceType: string
	/** The telemetry service the resource resolves to, '' when none. */
	readonly serviceName: string
	readonly chargeCategory: CostChargeCategory
	readonly basis: CostBasis
	readonly currency: string
	readonly billedCost: number
	readonly effectiveCost: number
	readonly listCost: number
	readonly consumedQuantity: number
	readonly consumedUnit: string
	readonly tags: Readonly<Record<string, string>>
	/** The provider can still restate this day. */
	readonly estimated: boolean
}

export interface CostPull {
	/**
	 * Every row of every day in the window: a day's rows replace that day's older pull, so a
	 * provider never returns part of a day.
	 */
	readonly rows: ReadonlyArray<CostPullRow>
	/** Billable provider API requests the pull made. */
	readonly requests: number
}

/**
 * A pull that returned nothing usable. `not_ready`: the customer's side is not set up for cost
 * (permission missing, billing data not enabled); retrying soon will not help. `auth`: Maple could
 * not act as the connection. `rate_limited` and `upstream` are worth a later retry.
 */
export class CostProviderError extends Schema.TaggedError<CostProviderError>()(
	"@maple/backend/cost/CostProviderError",
	{
		message: Schema.String,
		provider: CostProviderSchema,
		reason: Schema.Literals(["not_ready", "auth", "rate_limited", "upstream", "invalid_response"]),
		/** Billable requests made before it failed: they still count against the source. */
		requests: Schema.Number,
	},
) {}

export interface CostProviderAdapter {
	readonly provider: CostProvider
	readonly pull: (
		source: CostPullSource,
		window: CostPullWindow,
	) => Effect.Effect<CostPull, CostProviderError>
}
