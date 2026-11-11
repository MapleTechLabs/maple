// Cloud cost reads for the dashboard: the registry queries over `cost_daily`, narrowed to the
// org's connected sources and shaped for the wire, and the sources' own sync state from Postgres.
import * as PG from "@maple-dev/effect-orm/postgres"
import { CostSources, type CostSourceRow } from "@maple/db/tables"
import {
	CloudCostDisabledError,
	CloudCostPersistenceError,
	COST_BREAKDOWN_DEFAULT_LIMIT,
	COST_TIMESERIES_DEFAULT_LIMIT,
	type CostBreakdownRequest,
	type CostSourceSummary,
	type CostTimeseriesRequest,
	type CostTotalsRequest,
	type OrgId,
	type TenantContext,
} from "@maple/domain/http"
import * as CH from "@maple/query-engine/ch"
import { Queries } from "@maple/query-engine/registry"
import {
	Clock,
	DateTime,
	Effect,
	Number as Num,
	Option,
	Order,
	Array as Arr,
	Record as Rec,
	String as Str,
} from "effect"
import type { DatabaseApi } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute, makePersistenceErrorMapper } from "@maple/backend/platform/db-execute"
import { makeQueryRunners, type QueryRunnerDeps } from "@maple/backend/queries/query-runner"
import { daysOfWindow, historyFloor, utcMonth, utcToday } from "@maple/backend/services/cost/sync-plan"
import type { OrganizationFeatureFlagsServiceApi } from "@maple/backend/services/org/OrganizationFeatureFlagsService"

export interface CostReadsDeps extends QueryRunnerDeps {
	readonly database: DatabaseApi
	readonly featureFlags: OrganizationFeatureFlagsServiceApi
}

type CostWindowRequest = CostTotalsRequest | CostTimeseriesRequest | CostBreakdownRequest

interface TimeseriesRow {
	readonly date: DateTime.Utc
	readonly key: string
	readonly cost: number
	readonly estimated: number
}

const toPersistenceError = makePersistenceErrorMapper(CloudCostPersistenceError, "Cost sources read failed")

/** The `YYYY-MM-DD` of a `YYYY-MM-DD HH:mm:ss` day bound. */
const dayOf = (date: string) => Str.slice(0, 10)(date)

/** Every day of the request's window, oldest first. */
const windowDays = (payload: CostWindowRequest) => {
	const window = Queries.wholeDayWindow(payload)
	return daysOfWindow({ startDay: dayOf(window.startDate), endDay: dayOf(window.endDate) })
}

interface Ranked {
	readonly key: string
	readonly total: number
}

const byTotalThenKey = Order.combine(
	Order.mapInput(Order.flip(Order.Number), (series: Ranked) => series.total),
	Order.mapInput(Order.String, (series: Ranked) => series.key),
)

/**
 * Rows as one zero-filled series per key over `days`, largest total first. With `split`, the
 * folded `COST_OTHER_KEY` series goes last and is left out when it is all zero; without it there
 * is always the one series with key "".
 */
const toSeries = (days: ReadonlyArray<string>, rows: ReadonlyArray<TimeseriesRow>, split: boolean) => {
	const seriesOf = (key: string, keyRows: ReadonlyArray<TimeseriesRow>) => {
		const costByDay = Rec.fromEntries(
			Arr.map(keyRows, (row) => [DateTime.formatIsoDateUtc(row.date), row.cost] as const),
		)
		const points = Arr.map(days, (day) => costByDay[day] ?? 0)
		return { key, other: split && key === CH.COST_OTHER_KEY, total: Num.sumAll(points), points }
	}
	const all = Arr.map(Rec.toEntries(Arr.groupBy(rows, (row) => row.key)), ([key, keyRows]) =>
		seriesOf(key, keyRows),
	)
	if (!split) return all.length === 0 ? [seriesOf("", [])] : all
	return Arr.appendAll(
		Arr.sort(
			Arr.filter(all, (series) => !series.other),
			byTotalThenKey,
		),
		Arr.filter(all, (series) => series.other && Arr.some(series.points, (point) => point !== 0)),
	)
}

/** The first day the provider may still restate, or null when every day is final. */
const estimatedFromOf = (rows: ReadonlyArray<TimeseriesRow>) =>
	Option.getOrNull(
		Arr.head(
			Arr.sort(
				Arr.map(
					Arr.filter(rows, (row) => row.estimated === 1),
					(row) => DateTime.formatIsoDateUtc(row.date),
				),
				Order.String,
			),
		),
	)

const toSourceSummary = (row: CostSourceRow, nowMs: number): CostSourceSummary => {
	const historyComplete = row.backfillDate !== null && row.backfillDate <= historyFloor(utcToday(nowMs))
	return {
		id: row.id,
		provider: row.provider,
		accountId: row.accountId,
		status: !row.enabled
			? "paused"
			: row.lastError !== null
				? "error"
				: row.watermarkDate === null
					? "pending"
					: historyComplete
						? "ok"
						: "syncing",
		watermarkDate: row.watermarkDate,
		backfillDate: row.backfillDate,
		historyComplete,
		lastSyncedAt: row.lastSyncedAt,
		lastError: row.lastError,
		lastErrorReason: row.lastErrorReason,
		// The count belongs to `requestsMonth`: a new month starts from zero before the next sync.
		requestsThisMonth: row.requestsMonth === utcMonth(nowMs) ? row.requestsCount : 0,
	}
}

export const makeCostReads = (deps: CostReadsDeps) => {
	const { runQuery, runQueryFirst } = makeQueryRunners(deps)
	const dbExecute = makeDbExecute(deps.database, "CostReads", toPersistenceError)

	/** The org's cost sources, once the org is in the `cloudCost` rollout. */
	const sourcesInRollout = (orgId: OrgId) =>
		Effect.gen(function* () {
			yield* Effect.annotateCurrentSpan({ orgId })
			const flags = yield* deps.featureFlags.flags(orgId)
			if (!flags.cloudCost) {
				return yield* new CloudCostDisabledError({
					message: "Cloud cost is not enabled for this organization.",
				})
			}
			return yield* dbExecute((db) =>
				db.run(
					PG.from(CostSources)
						.select()
						.where(($) => [$.orgId.eq(orgId)])
						.orderBy(["createdAt", "asc"], ["id", "asc"]),
				),
			)
		})

	/**
	 * What every warehouse read carries, or null for an org with no source: the query does not
	 * narrow on an empty id list, and a disconnected source keeps its rows.
	 */
	const windowOf = (tenant: TenantContext, payload: CostWindowRequest) =>
		Effect.map(sourcesInRollout(tenant.orgId), (sources) =>
			sources.length === 0
				? null
				: {
						startTime: payload.startTime,
						endTime: payload.endTime,
						metric: payload.metric,
						filters: payload.filters,
						sourceIds: Arr.map(sources, (source) => source.id),
					},
		)

	const totals = Effect.fn("CostReads.totals")(function* (
		tenant: TenantContext,
		payload: CostTotalsRequest,
	) {
		const window = yield* windowOf(tenant, payload)
		const days = Queries.wholeDayWindow(payload).days
		const row = window === null ? null : yield* runQueryFirst(Queries.costTotals, tenant, window)
		if (row === null) {
			return { cost: 0, previousCost: 0, estimatedDays: 0, currency: "", mixedCurrencies: false, days }
		}
		return {
			cost: row.cost,
			previousCost: row.previousCost,
			estimatedDays: row.estimatedDays,
			currency: row.currency,
			mixedCurrencies: row.currencies > 1,
			days,
		}
	})

	/**
	 * Daily cost. Split by a dimension it is two reads: the top keys by cost in the window, then
	 * the days with every other key folded into one series.
	 */
	const timeseries = Effect.fn("CostReads.timeseries")(function* (
		tenant: TenantContext,
		payload: CostTimeseriesRequest,
	) {
		const window = yield* windowOf(tenant, payload)
		const days = windowDays(payload)
		const empty = { days, series: [], estimatedFrom: null }
		if (window === null) return empty
		const groupBy = payload.groupBy
		if (groupBy === undefined) {
			const rows = yield* runQuery(Queries.costTimeseries, tenant, window)
			return { days, series: toSeries(days, rows, false), estimatedFrom: estimatedFromOf(rows) }
		}
		const top = yield* runQuery(Queries.costBreakdown, tenant, {
			...window,
			groupBy,
			sortBy: "cost",
			limit: payload.limit ?? COST_TIMESERIES_DEFAULT_LIMIT,
		})
		yield* Effect.annotateCurrentSpan({ "maple.cost.series_keys": top.length })
		// No key in the window or the period before it: there is nothing to draw, and no key to name.
		if (top.length === 0) return empty
		const rows = yield* runQuery(Queries.costTimeseries, tenant, {
			...window,
			groupBy,
			keys: Arr.map(top, (row) => row.key),
		})
		return { days, series: toSeries(days, rows, true), estimatedFrom: estimatedFromOf(rows) }
	})

	const breakdown = Effect.fn("CostReads.breakdown")(function* (
		tenant: TenantContext,
		payload: CostBreakdownRequest,
	) {
		const window = yield* windowOf(tenant, payload)
		if (window === null) return { rows: [] }
		const rows = yield* runQuery(Queries.costBreakdown, tenant, {
			...window,
			groupBy: payload.groupBy,
			sortBy: payload.sortBy,
			limit: payload.limit ?? COST_BREAKDOWN_DEFAULT_LIMIT,
		})
		return {
			rows: Arr.map(rows, (row) => ({ key: row.key, cost: row.cost, previousCost: row.previousCost })),
		}
	})

	/** Each connected source and how far its sync is. Postgres only. */
	const sources = Effect.fn("CostReads.sources")(function* (tenant: TenantContext) {
		const rows = yield* sourcesInRollout(tenant.orgId)
		const nowMs = yield* Clock.currentTimeMillis
		return { sources: Arr.map(rows, (row) => toSourceSummary(row, nowMs)) }
	})

	return { totals, timeseries, breakdown, sources } as const
}
