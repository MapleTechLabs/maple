// Cloud cost from `cost_daily`. Every read keeps only the newest pull of each (source, day): rows
// whose IngestedAt is that day's max, since a provider restates recent days and can drop keys an
// older pull still holds. Pinned to the managed route: written through `ingest` only.

import { Array as Arr, type DateTime } from "effect"
import * as CH from "@maple-dev/effect-orm/expr"
import { from, fromQuery } from "@maple-dev/effect-orm/clickhouse"
import type { ColumnAccessor } from "@maple-dev/effect-orm/clickhouse"
import { COST_EMPTY_DAY_CATEGORY, type CostDimension, type CostMetric } from "@maple/domain/cost"
import * as Datasources from "@maple/domain/tinybird/datasources"
import { orgIdParam, utcSecondsParam } from "../tables"

/** The key a split series folds every value outside its named keys into. */
export const COST_OTHER_KEY = "__other__"

/**
 * Narrowing for a cost read: the values a dimension may take, inlined as escaped literals. An
 * empty or missing list does not narrow. `sourceIds` are the org's active sources: a disconnected
 * source keeps its rows, so a read that omits them counts those too.
 */
export interface CostFilters {
	readonly sourceIds?: ReadonlyArray<string>
	readonly values?: Partial<Record<CostDimension, ReadonlyArray<string>>>
}

type DailyAccessor = ColumnAccessor<typeof Datasources.costDaily.columns>
type StartParam = "startDate" | "previousStartDate"

/** One field per `CostDimension`, on the raw table or on the collapsed rows. */
type ByDimension<T> = Readonly<
	Record<
		| "provider"
		| "account"
		| "cloudService"
		| "serviceCategory"
		| "usageType"
		| "region"
		| "resource"
		| "service",
		T
	>
>

const pickDimension = (fields: ByDimension<CH.Expr<string>>, dimension: CostDimension): CH.Expr<string> => {
	switch (dimension) {
		case "provider":
			return fields.provider
		case "account":
			return fields.account
		case "cloud_service":
			return fields.cloudService
		case "service_category":
			return fields.serviceCategory
		case "usage_type":
			return fields.usageType
		case "region":
			return fields.region
		case "resource":
			return fields.resource
		case "service":
			return fields.service
	}
}

const dailyDimensions = ($: DailyAccessor) => ({
	provider: $.Provider,
	account: $.AccountId,
	cloudService: $.CloudService,
	serviceCategory: $.ServiceCategory,
	usageType: $.UsageType,
	region: $.Region,
	resource: $.ResourceId,
	service: $.ServiceName,
})

const DIMENSIONS: ReadonlyArray<CostDimension> = [
	"provider",
	"account",
	"cloud_service",
	"service_category",
	"usage_type",
	"region",
	"resource",
	"service",
]

const nonEmpty = (values: ReadonlyArray<string> | undefined) =>
	values !== undefined && values.length > 0 ? values : undefined

/** Tenant, sources and whole days (inclusive bounds on the midnight-UTC `Date`). */
function windowWhere($: DailyAccessor, filters: CostFilters, startParam: StartParam) {
	return [
		$.OrgId.eq(orgIdParam),
		$.Date.gte(utcSecondsParam(startParam)),
		$.Date.lte(utcSecondsParam("endDate")),
		CH.when(nonEmpty(filters.sourceIds), (ids) => CH.inList($.SourceId, ids)),
	]
}

/** Each (source, day)'s newest pull, before any dimension filter: a pull replaces the whole day. */
function newestPulls(filters: CostFilters, startParam: StartParam) {
	return from(Datasources.costDaily)
		.select(($) => ({ sourceId: $.SourceId, date: $.Date, ingestedAt: CH.max_($.IngestedAt) }))
		.where(($) => windowWhere($, filters, startParam))
		.groupBy("sourceId", "date")
}

/** The rows of each day's newest pull; copies of one row (an ingest retry) collapse in the GROUP BY. */
function latestRows(filters: CostFilters, metric: CostMetric, startParam: StartParam = "startDate") {
	return from(Datasources.costDaily)
		.innerJoinQuery(newestPulls(filters, startParam), "newest", (row, newest) =>
			row.SourceId.eq(newest.sourceId)
				.and(row.Date.eq(newest.date))
				.and(row.IngestedAt.eq(newest.ingestedAt)),
		)
		.select(($) => ({
			date: $.Date,
			sourceId: $.SourceId,
			...dailyDimensions($),
			chargeCategory: $.ChargeCategory,
			currency: $.Currency,
			cost: CH.max_(metric === "billed" ? $.BilledCost : $.EffectiveCost),
			estimated: CH.max_($.Estimated),
		}))
		.where(($) => [
			...windowWhere($, filters, startParam),
			// The empty-day row counts as a pull above, so it supersedes the day, and is no cost row here.
			$.ChargeCategory.neq(COST_EMPTY_DAY_CATEGORY),
			...Arr.map(DIMENSIONS, (dimension) =>
				CH.when(nonEmpty(filters.values?.[dimension]), (values) =>
					CH.inList(pickDimension(dailyDimensions($), dimension), values),
				),
			),
		])
		.groupBy(
			"date",
			"sourceId",
			"provider",
			"account",
			"cloudService",
			"serviceCategory",
			"usageType",
			"region",
			"resource",
			"service",
			"chargeCategory",
			"currency",
		)
}

const costLatest = (filters: CostFilters, metric: CostMetric, startParam: StartParam) =>
	fromQuery(latestRows(filters, metric, startParam), "latest")

/** A sum that reads 0, not NULL, so the row decodes as plain numbers. */
const total = (sum: CH.Expr<number | null>): CH.Expr<number> => CH.ifNull(sum, CH.lit(0))

export interface CostReadOpts extends CostFilters {
	/** Defaults to `billed`. */
	readonly metric?: CostMetric
}

export interface CostTotalsOutput {
	readonly cost: number
	readonly previousCost: number
	/** Days in the window the provider has not finalized yet. */
	readonly estimatedDays: number
	/** One billing currency of the rows; `currencies` above 1 means the sum mixes several. */
	readonly currency: string
	readonly currencies: number
}

/**
 * The window's total and the equal-length period before it, in one scan. Params: orgId,
 * previousStartDate, startDate, endDate.
 */
export function costTotalsQuery(opts: CostReadOpts = {}) {
	return costLatest(opts, opts.metric ?? "billed", "previousStartDate")
		.select(($) => {
			const current = $.date.gte(utcSecondsParam("startDate"))
			return {
				cost: total(CH.sumIf($.cost, current)),
				previousCost: total(CH.sumIf($.cost, CH.not(current))),
				estimatedDays: CH.uniqIf($.date, CH.and(current, $.estimated.eq(1))),
				currency: CH.any_($.currency),
				currencies: CH.uniqIf($.currency, current),
			}
		})
		.format("JSON")
		.route("ingest")
}

export interface CostTimeseriesOpts extends CostReadOpts {
	/** Splits each day by this dimension. Without it every day is one row with key ''. */
	readonly dimension?: CostDimension
	/** With `dimension`: the keys to keep as their own series; the rest fold into `COST_OTHER_KEY`. */
	readonly keys?: ReadonlyArray<string>
}

export interface CostTimeseriesOutput {
	/** Midnight UTC of the usage day. */
	readonly date: DateTime.Utc
	readonly key: string
	readonly cost: number
	/** 1 while the provider may still restate the day. */
	readonly estimated: number
}

/** Daily cost, optionally split by one dimension. Params: orgId, startDate, endDate. */
export function costTimeseriesQuery(opts: CostTimeseriesOpts = {}) {
	const { dimension, keys } = opts
	return costLatest(opts, opts.metric ?? "billed", "startDate")
		.select(($) => {
			const value = dimension === undefined ? CH.lit("") : pickDimension($, dimension)
			return {
				date: $.date,
				key:
					dimension === undefined || keys === undefined
						? value
						: CH.if_(CH.inList(value, keys), value, CH.lit(COST_OTHER_KEY)),
				cost: total(CH.sum($.cost)),
				estimated: CH.max_($.estimated),
			}
		})
		.groupBy("date", "key")
		.orderBy(["date", "asc"], ["key", "asc"])
		.format("JSON")
		.route("ingest")
}

export const COST_BREAKDOWN_SORT_KEYS = ["cost", "change"] as const
export type CostBreakdownSortKey = (typeof COST_BREAKDOWN_SORT_KEYS)[number]

export interface CostBreakdownOpts extends CostReadOpts {
	readonly dimension: CostDimension
	/** `cost`: largest in the window first. `change`: largest move against the period before, either way. */
	readonly sortBy?: CostBreakdownSortKey
	readonly limit?: number
}

export interface CostBreakdownOutput {
	readonly key: string
	readonly cost: number
	readonly previousCost: number
	/** |cost - previousCost|, what `sortBy: "change"` orders by. */
	readonly changeSize: number
}

/**
 * Cost per value of one dimension, with the equal-length period before it, so a value that
 * stopped costing anything still shows. Params: orgId, previousStartDate, startDate, endDate.
 */
export function costBreakdownQuery(opts: CostBreakdownOpts) {
	return costLatest(opts, opts.metric ?? "billed", "previousStartDate")
		.select(($) => {
			const current = $.date.gte(utcSecondsParam("startDate"))
			const cost = total(CH.sumIf($.cost, current))
			const previousCost = total(CH.sumIf($.cost, CH.not(current)))
			return {
				key: pickDimension($, opts.dimension),
				cost,
				previousCost,
				changeSize: CH.greatest_(cost.sub(previousCost), previousCost.sub(cost)),
			}
		})
		.groupBy("key")
		.orderBy([opts.sortBy === "change" ? "changeSize" : "cost", "desc"], ["key", "asc"])
		.limit(opts.limit ?? 50)
		.format("JSON")
		.route("ingest")
}

export interface CostSourceCoverageOutput {
	readonly sourceId: string
	/** First and last usage day stored for the source, at midnight UTC. */
	readonly firstDate: DateTime.Utc
	readonly lastDate: DateTime.Utc
	readonly lastPulledAt: DateTime.Utc
}

/** The span of days each source has stored, over every pull. Params: orgId, startDate, endDate. */
export function costSourceCoverageQuery(opts: CostFilters = {}) {
	return from(Datasources.costDaily)
		.select(($) => ({
			sourceId: $.SourceId,
			firstDate: CH.min_($.Date),
			lastDate: CH.max_($.Date),
			lastPulledAt: CH.max_($.IngestedAt),
		}))
		.where(($) => windowWhere($, opts, "startDate"))
		.groupBy("sourceId")
		.orderBy(["sourceId", "asc"])
		.format("JSON")
		.route("ingest")
}
