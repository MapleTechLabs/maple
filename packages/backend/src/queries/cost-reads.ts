// Cloud cost reads for the dashboard: the registry queries over `cost_daily`, narrowed to the
// org's connected sources and shaped for the wire, and the sources' own sync state from Postgres.
import * as PG from "@maple-dev/effect-orm/postgres"
import { CostSources, type CostSourceRow } from "@maple/db/tables"
import {
	CloudCostDisabledError,
	CloudCostPersistenceError,
	COST_BREAKDOWN_DEFAULT_LIMIT,
	COST_MAX_WINDOW_DAYS,
	COST_TIMESERIES_DEFAULT_LIMIT,
	type CostBreakdownRequest,
	type CostSourceSummary,
	type CostTimeseriesRequest,
	type CostTotalsRequest,
	type OrgId,
	QueryEngineValidationError,
	type TenantContext,
} from "@maple/domain/http"
import { parseWarehouseDateTime } from "@maple/query-engine"
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
import {
	daysFrom,
	historyFloor,
	isCostHold,
	requestsThisMonth,
	utcToday,
} from "@maple/backend/services/cost/sync-plan"
import type { OrganizationFeatureFlagsServiceApi } from "@maple/backend/services/org/OrganizationFeatureFlagsService"

export interface CostReadsDeps extends QueryRunnerDeps {
	readonly database: DatabaseApi
	readonly featureFlags: OrganizationFeatureFlagsServiceApi
}

type CostWindowRequest = CostTotalsRequest | CostTimeseriesRequest | CostBreakdownRequest

interface TimeseriesRow {
	readonly date: DateTime.Utc
	readonly key: string
	/** 1 for the rows of every value folded together, whatever `key` says. */
	readonly other: number
	readonly cost: number
	readonly estimated: number
}

const toPersistenceError = makePersistenceErrorMapper(CloudCostPersistenceError, "Cost sources read failed")

/** The `YYYY-MM-DD` of a `YYYY-MM-DD HH:mm:ss` day bound. */
const dayOf = (date: string) => Str.slice(0, 10)(date)

/** Every day of the request's window, oldest first: as many as the window counts, from its first. */
const windowDays = (payload: CostWindowRequest) => {
	const window = Queries.wholeDayWindow(payload)
	return daysFrom(dayOf(window.startDate), window.days)
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
 * folded series goes last and is left out when it is all zero; without it there is always the one
 * series with key "". A value named like the folded key is a series of its own: `other` tells.
 */
const toSeries = (days: ReadonlyArray<string>, rows: ReadonlyArray<TimeseriesRow>, split: boolean) => {
	const seriesOf = (key: string, other: boolean, keyRows: ReadonlyArray<TimeseriesRow>) => {
		const costByDay = Rec.fromEntries(
			Arr.map(keyRows, (row) => [DateTime.formatIsoDateUtc(row.date), row.cost] as const),
		)
		const points = Arr.map(days, (day) => costByDay[day] ?? 0)
		return { key, other, total: Num.sumAll(points), points }
	}
	const all = Arr.map(Rec.values(Arr.groupBy(rows, (row) => `${row.other}:${row.key}`)), (keyRows) => {
		const first = Arr.headNonEmpty(keyRows)
		return seriesOf(first.key, first.other === 1, keyRows)
	})
	if (!split) return all.length === 0 ? [seriesOf("", false, [])] : all
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
	const historyComplete =
		row.backfillDate !== null && row.backfillDate <= historyFloor(row.provider, utcToday(nowMs))
	return {
		id: row.id,
		provider: row.provider,
		connectionRef: row.connectionRef,
		accountId: row.accountId,
		status: !row.enabled
			? "paused"
			: row.lastError !== null
				? isCostHold(row.lastErrorReason)
					? "held"
					: "error"
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
		requestsThisMonth: requestsThisMonth(row, nowMs),
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
	 * The window over the org's sources, or null for an org with no source, which needs no read.
	 * A disconnected source keeps its rows, so a read always names the org's own sources.
	 */
	const windowOf = (tenant: TenantContext, payload: CostWindowRequest) =>
		Effect.gen(function* () {
			const sources = yield* sourcesInRollout(tenant.orgId)
			// Flooring moves a reversed window's end up to its start day: it would read as that one day.
			if (parseWarehouseDateTime(payload.startTime) > parseWarehouseDateTime(payload.endTime)) {
				return yield* new QueryEngineValidationError({
					message: "A cost window must not start after it ends.",
					details: [],
				})
			}
			// Every day of the window is a point of every series: an unbounded range is not a read.
			if (Queries.wholeDayWindow(payload).days > COST_MAX_WINDOW_DAYS) {
				return yield* new QueryEngineValidationError({
					message: `A cost window covers at most ${COST_MAX_WINDOW_DAYS} days.`,
					details: [],
				})
			}
			return sources.length === 0
				? null
				: {
						startTime: payload.startTime,
						endTime: payload.endTime,
						metric: payload.metric,
						filters: payload.filters,
						sourceIds: Arr.map(sources, (source) => source.id),
						// A sync stamps its source at every step it writes.
						written: Arr.reduce(sources, 0, (latest, source) =>
							Math.max(latest, source.updatedAt),
						),
					}
		})

	/**
	 * The window narrowed to the one currency a read sums, or null for an org with no source.
	 * Nothing converts, so every warehouse read of money carries `window.currency`: the one asked
	 * for, else the window's largest. One nobody bills in reads zeros; "" is no cost at all.
	 */
	const inOneCurrency = (tenant: TenantContext, payload: CostWindowRequest) =>
		Effect.gen(function* () {
			const window = yield* windowOf(tenant, payload)
			if (window === null) return null
			const rows = yield* runQuery(Queries.costCurrencies, tenant, window)
			const found = Arr.map(rows, (row) => row.currency)
			const currency = payload.currency ?? Option.getOrElse(Arr.head(found), () => "")
			yield* Effect.annotateCurrentSpan({
				"maple.cost.currency": currency,
				"maple.cost.currencies": found.length,
			})
			return {
				window: { ...window, currency },
				currency,
				/** What the warehouse holds, the read's own first when it is one of them. */
				currencies: Arr.appendAll(
					Arr.filter(found, (other) => other === currency),
					Arr.filter(found, (other) => other !== currency),
				),
			}
		})

	const totals = Effect.fn("CostReads.totals")(function* (
		tenant: TenantContext,
		payload: CostTotalsRequest,
	) {
		const read = yield* inOneCurrency(tenant, payload)
		const days = Queries.wholeDayWindow(payload).days
		const row = read === null ? null : yield* runQueryFirst(Queries.costTotals, tenant, read.window)
		return {
			cost: row?.cost ?? 0,
			previousCost: row?.previousCost ?? 0,
			estimatedDays: row?.estimatedDays ?? 0,
			currency: read?.currency ?? "",
			currencies: read?.currencies ?? [],
			days,
		}
	})

	/**
	 * Daily cost. Split by a dimension it is two reads in the one currency: the top keys by cost
	 * in the window, then the days with every other key folded into one series.
	 */
	const timeseries = Effect.fn("CostReads.timeseries")(function* (
		tenant: TenantContext,
		payload: CostTimeseriesRequest,
	) {
		const read = yield* inOneCurrency(tenant, payload)
		const days = windowDays(payload)
		if (read === null) return { currency: "", days, series: [], estimatedFrom: null }
		const { window, currency } = read
		const groupBy = payload.groupBy
		if (groupBy === undefined) {
			const rows = yield* runQuery(Queries.costTimeseries, tenant, window)
			return {
				currency,
				days,
				series: toSeries(days, rows, false),
				estimatedFrom: estimatedFromOf(rows),
			}
		}
		const top = yield* runQuery(Queries.costBreakdown, tenant, {
			...window,
			groupBy,
			sortBy: "cost",
			limit: payload.limit ?? COST_TIMESERIES_DEFAULT_LIMIT,
		})
		yield* Effect.annotateCurrentSpan({ "maple.cost.series_keys": top.length })
		// No key in the window or the period before it: there is nothing to draw, and no key to name.
		if (top.length === 0) return { currency, days, series: [], estimatedFrom: null }
		const rows = yield* runQuery(Queries.costTimeseries, tenant, {
			...window,
			groupBy,
			keys: Arr.map(top, (row) => row.key),
		})
		return { currency, days, series: toSeries(days, rows, true), estimatedFrom: estimatedFromOf(rows) }
	})

	const breakdown = Effect.fn("CostReads.breakdown")(function* (
		tenant: TenantContext,
		payload: CostBreakdownRequest,
	) {
		const read = yield* inOneCurrency(tenant, payload)
		if (read === null) return { currency: "", rows: [] }
		const rows = yield* runQuery(Queries.costBreakdown, tenant, {
			...read.window,
			groupBy: payload.groupBy,
			sortBy: payload.sortBy,
			limit: payload.limit ?? COST_BREAKDOWN_DEFAULT_LIMIT,
		})
		return {
			currency: read.currency,
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
