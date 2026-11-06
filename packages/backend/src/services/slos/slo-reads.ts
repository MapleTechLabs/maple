// Warehouse reads behind an SLO: the window's totals, the burn windows and the budget chart.
// Shared by the SLO API and the burn-rate alert evaluator.
import { CH, formatWarehouseDateTime } from "@maple/query-engine"
import {
	budgetHistory,
	burnWindows,
	SLO_BURN_LOOKBACK_MINUTES,
	type SloBucket,
	type SloBurnWindow,
	type SloCounts,
	type SloHistoryPoint,
	type SloSli,
} from "@maple/domain/slo"
import type { OrgId } from "@maple/domain/primitives"
import { Array as Arr, DateTime, Effect } from "effect"
import type { TenantContext } from "@maple/backend/services/auth/AuthService"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/** What an SLO read needs from the stored SLO. */
export interface SloTarget {
	readonly orgId: OrgId
	readonly serviceName: string
	readonly environments: ReadonlyArray<string>
	readonly sli: SloSli
	readonly targetPercent: number
	readonly windowDays: number
}

const queryOpts = (slo: SloTarget) => ({
	serviceName: slo.serviceName,
	environments: slo.environments,
	sli: slo.sli,
})

const toBuckets = (rows: ReadonlyArray<CH.SloBucketsOutput>): ReadonlyArray<SloBucket> =>
	Arr.map(rows, (row) => ({
		startMs: DateTime.toEpochMillis(row.bucket),
		total: row.total,
		good: row.good,
	}))

/** Good and total events over the SLO window ending at `endMs`. */
export const readWindowTotals = Effect.fn("SloReads.windowTotals")(function* (
	tenant: TenantContext,
	slo: SloTarget,
	endMs: number,
) {
	const warehouse = yield* WarehouseQueryService
	const rows = yield* warehouse.compiledQuery(
		tenant,
		CH.compile(CH.sloTotalsQuery(queryOpts(slo)), {
			orgId: slo.orgId,
			startTime: formatWarehouseDateTime(endMs - slo.windowDays * DAY_MS),
			endTime: formatWarehouseDateTime(endMs),
		}),
		{ profile: "aggregation", context: "sloWindowTotals" },
	)
	const row = rows[0]
	return { total: row?.total ?? 0, good: row?.good ?? 0 } satisfies SloCounts
})

/** The burn of each alert window (5m to 6h) ending at `endMs`, from one minute-grain read. */
export const readBurnWindows = Effect.fn("SloReads.burnWindows")(function* (
	tenant: TenantContext,
	slo: SloTarget,
	endMs: number,
) {
	const warehouse = yield* WarehouseQueryService
	const rows = yield* warehouse.compiledQuery(
		tenant,
		CH.compile(CH.sloBucketsQuery(queryOpts(slo), "minute"), {
			orgId: slo.orgId,
			startTime: formatWarehouseDateTime(endMs - SLO_BURN_LOOKBACK_MINUTES * MINUTE_MS),
			endTime: formatWarehouseDateTime(endMs),
			bucketSeconds: 60,
		}),
		{ profile: "aggregation", context: "sloBurnWindows" },
	)
	return burnWindows(toBuckets(rows), endMs, slo.targetPercent) satisfies ReadonlyArray<SloBurnWindow>
})

/** Hourly points over the SLO window ending at `endMs`; reads two windows of hourly buckets. */
export const readBudgetHistory = Effect.fn("SloReads.budgetHistory")(function* (
	tenant: TenantContext,
	slo: SloTarget,
	endMs: number,
) {
	const warehouse = yield* WarehouseQueryService
	const windowMs = slo.windowDays * DAY_MS
	const rows = yield* warehouse.compiledQuery(
		tenant,
		CH.compile(CH.sloBucketsQuery(queryOpts(slo), "hour"), {
			orgId: slo.orgId,
			startTime: formatWarehouseDateTime(Math.ceil(endMs / HOUR_MS) * HOUR_MS - 2 * windowMs),
			endTime: formatWarehouseDateTime(endMs),
			bucketSeconds: 3600,
		}),
		{ profile: "aggregation", context: "sloBudgetHistory" },
	)
	return budgetHistory({
		buckets: toBuckets(rows),
		bucketMs: HOUR_MS,
		windowMs,
		endMs,
		targetPercent: slo.targetPercent,
	}) satisfies ReadonlyArray<SloHistoryPoint>
})
