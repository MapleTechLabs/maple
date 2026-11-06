// Warehouse reads behind an SLO: the window's totals, the burn windows and the budget chart.
// Shared by the SLO API and the burn-rate alert evaluator.
import { CH, formatWarehouseDateTime } from "@maple/query-engine"
import {
	budgetHistory,
	burnRate,
	burnWindows,
	SLO_BURN_WINDOWS_MINUTES,
	SLO_BURN_LOOKBACK_MINUTES,
	type SloBucket,
	type SloBurnWindow,
	type SloCounts,
	type SloHistoryPoint,
	type SloSli,
} from "@maple/domain/slo"
import type { OrgId } from "@maple/domain/primitives"
import { Array as Arr, DateTime, Effect, Record as Rec } from "effect"
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
			startTime: formatWarehouseDateTime(Math.ceil(endMs / HOUR_MS) * HOUR_MS - 2 * windowMs + HOUR_MS),
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

/** An SLO the batch read covers, keyed by its id. */
export interface SloBatchTarget extends SloTarget {
	readonly id: string
}

export interface SloBatchStatus {
	readonly totals: SloCounts
	readonly windows: ReadonlyArray<SloBurnWindow>
}

const sliKey = (sli: SloSli) => (sli._tag === "availability" ? "availability" : `latency:${sli.thresholdMs}`)

/** The rows of one (service, environment) breakdown that an SLO counts. */
const counted = <Row extends { readonly serviceName: string; readonly environment: string }>(
	rows: ReadonlyArray<Row>,
	slo: SloTarget,
) =>
	Arr.filter(
		rows,
		(row) =>
			row.serviceName === slo.serviceName &&
			(slo.environments.length === 0 || Arr.contains(slo.environments, row.environment)),
	)

/**
 * Every SLO's window totals and burn windows ending at `endMs`, in one read per (SLI, window)
 * and one per SLI, each broken down by service and environment and summed per SLO here.
 */
export const readStatuses = Effect.fn("SloReads.statuses")(function* (
	tenant: TenantContext,
	slos: ReadonlyArray<SloBatchTarget>,
	endMs: number,
) {
	const warehouse = yield* WarehouseQueryService
	const orgId = tenant.orgId
	const services = (group: ReadonlyArray<SloBatchTarget>) =>
		Arr.dedupe(Arr.map(group, (slo) => slo.serviceName))
	const bySli = Arr.groupBy(slos, (slo) => sliKey(slo.sli))
	const byWindow = Arr.groupBy(slos, (slo) => `${sliKey(slo.sli)}|${slo.windowDays}`)
	yield* Effect.annotateCurrentSpan({
		"maple.slo.count": slos.length,
		"maple.slo.reads": Rec.keys(bySli).length + Rec.keys(byWindow).length,
	})

	const totalsReads = Effect.forEach(
		Rec.values(byWindow),
		(group) => {
			const first = Arr.headNonEmpty(group)
			return warehouse
				.compiledQuery(
					tenant,
					CH.compile(
						CH.sloTotalsByServiceQuery({ serviceNames: services(group), sli: first.sli }),
						{
							orgId,
							startTime: formatWarehouseDateTime(endMs - first.windowDays * DAY_MS),
							endTime: formatWarehouseDateTime(endMs),
						},
					),
					{ profile: "aggregation", context: "sloStatusTotals" },
				)
				.pipe(
					Effect.map((rows) =>
						Arr.map(group, (slo) => [slo.id, sumCounts(counted(rows, slo))] as const),
					),
				)
		},
		{ concurrency: 4 },
	)
	const burnReads = Effect.forEach(
		Rec.values(bySli),
		(group) => {
			const first = Arr.headNonEmpty(group)
			return warehouse
				.compiledQuery(
					tenant,
					CH.compile(CH.sloBurnByServiceQuery({ serviceNames: services(group), sli: first.sli }), {
						orgId,
						startTime: formatWarehouseDateTime(endMs - SLO_BURN_LOOKBACK_MINUTES * MINUTE_MS),
						endTime: formatWarehouseDateTime(endMs),
					}),
					{ profile: "aggregation", context: "sloStatusBurn" },
				)
				.pipe(
					Effect.map((rows) =>
						Arr.map(
							group,
							(slo) => [slo.id, burnWindowsOf(counted(rows, slo), slo.targetPercent)] as const,
						),
					),
				)
		},
		{ concurrency: 4 },
	)
	const [totals, burns] = yield* Effect.all([totalsReads, burnReads], { concurrency: 2 })
	const totalsById = new Map<string, SloCounts>(Arr.flatten(totals))
	const burnsById = new Map<string, ReadonlyArray<SloBurnWindow>>(Arr.flatten(burns))
	return new Map(
		Arr.map(slos, (slo): readonly [string, SloBatchStatus] => [
			slo.id,
			{
				totals: totalsById.get(slo.id) ?? { total: 0, good: 0 },
				windows: burnsById.get(slo.id) ?? burnWindowsOf([], slo.targetPercent),
			},
		]),
	)
})

const sumCounts = (rows: ReadonlyArray<SloCounts>): SloCounts =>
	Arr.reduce(rows, { total: 0, good: 0 }, (acc, row) => ({
		total: acc.total + row.total,
		good: acc.good + row.good,
	}))

/** One SLO's four burn windows from its breakdown rows. */
const burnWindowsOf = (
	rows: ReadonlyArray<CH.SloBurnByServiceOutput>,
	targetPercent: number,
): ReadonlyArray<SloBurnWindow> =>
	Arr.map(SLO_BURN_WINDOWS_MINUTES, (windowMinutes) => {
		const counts = sumCounts(
			Arr.map(rows, (row) => ({
				total: row[`total${windowMinutes}`],
				good: row[`good${windowMinutes}`],
			})),
		)
		return { windowMinutes, ...counts, burnRate: burnRate(counts, targetPercent) }
	})
