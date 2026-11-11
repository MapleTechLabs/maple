import {
	COST_FILTER_MAX_VALUE_LENGTH,
	COST_FILTER_MAX_VALUES,
	type CostBreakdownSortBy,
	type CostFilters,
	type CostSourceSummary,
	type CostTimeseriesResponse,
} from "@maple/domain/http"
import { parseWarehouseDateTime, relativeRangeSeconds } from "@maple/query-engine/datetime"
import { EMPTY_VALUE } from "@maple/ui/lib/format"
import { OTHER_LABEL } from "@maple/views/charts/series/bucket-series"
import { Array as Arr, Record as Rec, String as Str } from "effect"
import { COST_GROUP_BYS } from "../../route/search"
import type { Search } from "./model"

// What the cost page reads off its URL and its answers: the grouping, the filters, money and days.

export type CostGroupBy = (typeof COST_GROUP_BYS)[number]

export const DEFAULT_GROUP_BY: CostGroupBy = "cloud_service"

/** Each dimension's name in the control, the chips and the table, and what an empty key reads as. */
export const DIMENSIONS = {
	cloud_service: { label: "Service", noun: "service", empty: "Unassigned" },
	service_category: { label: "Category", noun: "category", empty: "Uncategorized" },
	region: { label: "Region", noun: "region", empty: "No region" },
	usage_type: { label: "Usage type", noun: "usage type", empty: "No usage type" },
	account: { label: "Account", noun: "account", empty: "No account" },
} as const satisfies Record<CostGroupBy, Readonly<{ label: string; noun: string; empty: string }>>

export const groupByOf = (search: Search): CostGroupBy => search.groupBy ?? DEFAULT_GROUP_BY

export const sortOf = (search: Search): CostBreakdownSortBy => search.sort ?? "cost"

/** A key as the page shows it: the provider's own text, or the dimension's placeholder for "". */
export const keyLabel = (dimension: CostGroupBy, key: string): string =>
	key === "" ? DIMENSIONS[dimension].empty : key

export type ActiveFilter = Readonly<{ dimension: CostGroupBy; value: string }>

/** Every filter in the URL, one per value, in the control's dimension order. */
export const activeFilters = (search: Search): ReadonlyArray<ActiveFilter> =>
	Arr.flatMap(COST_GROUP_BYS, (dimension) =>
		Arr.map(search[dimension] ?? [], (value) => ({ dimension, value })),
	)

export const hasFilter = (search: Search, filter: ActiveFilter): boolean =>
	Arr.contains(search[filter.dimension] ?? [], filter.value)

/** What the API takes of a dimension's values: the first `COST_FILTER_MAX_VALUES`, none too long to send. */
const sendable = (values: ReadonlyArray<string>): ReadonlyArray<string> =>
	Arr.take(
		Arr.filter(values, (value) => value.length <= COST_FILTER_MAX_VALUE_LENGTH),
		COST_FILTER_MAX_VALUES,
	)

/** An emptied dimension leaves the URL. */
const withValues = (search: Search, dimension: CostGroupBy, values: ReadonlyArray<string>): Search => ({
	...search,
	[dimension]: values.length === 0 ? undefined : values,
})

// The API refuses a longer list or value with a 400, which would fail every read of the page:
// a filter past the cap is not added, so the writer and the reader agree on the limit.
export const withFilter = (search: Search, filter: ActiveFilter): Search => {
	const values = search[filter.dimension] ?? []
	return hasFilter(search, filter) ||
		values.length >= COST_FILTER_MAX_VALUES ||
		filter.value.length > COST_FILTER_MAX_VALUE_LENGTH
		? search
		: withValues(search, filter.dimension, Arr.append(values, filter.value))
}

export const withoutFilter = (search: Search, filter: ActiveFilter): Search =>
	withValues(
		search,
		filter.dimension,
		Arr.filter(search[filter.dimension] ?? [], (value) => value !== filter.value),
	)

const DAY_SECONDS = 24 * 60 * 60

type TimeRange = Pick<Search, "startTime" | "endTime" | "timePreset">

/**
 * Whether the range is shorter than a day. Cost is read per whole day, so a range of hours would
 * show the days it touches under a label that says hours. "today" is a whole day.
 */
export const isUnderADay = (range: TimeRange): boolean => {
	if (range.timePreset !== undefined) {
		const seconds = relativeRangeSeconds(range.timePreset)
		return seconds !== null && seconds < DAY_SECONDS
	}
	return (
		range.startTime !== undefined &&
		range.endTime !== undefined &&
		parseWarehouseDateTime(range.endTime) - parseWarehouseDateTime(range.startTime) < DAY_SECONDS * 1000
	)
}

/** The search without a range under a day, which a hand-edited URL can carry: the default range then. */
export const wholeDaySearch = (search: Search): Search =>
	isUnderADay(search)
		? { ...search, startTime: undefined, endTime: undefined, timePreset: undefined }
		: search

/** The range, grouping and order stay; the filters go. */
export const withoutFilters = (search: Search): Search => ({
	startTime: search.startTime,
	endTime: search.endTime,
	timePreset: search.timePreset,
	groupBy: search.groupBy,
	sort: search.sort,
})

/** The filters as a read carries them, or undefined with none (the key then stays out of the body). */
export const requestFilters = (search: Search): CostFilters | undefined => {
	const entries = Arr.flatMap(COST_GROUP_BYS, (dimension) => {
		// A hand-edited URL can carry more than the API takes: send what it accepts.
		const values = sendable(search[dimension] ?? [])
		return values.length === 0 ? [] : [[dimension, values] as const]
	})
	return entries.length === 0 ? undefined : Rec.fromEntries(entries)
}

/** A source has cost to read once its first pull landed. */
export const hasSynced = (sources: ReadonlyArray<CostSourceSummary>): boolean =>
	Arr.some(sources, (source) => source.watermarkDate !== null)

const PLAIN_MONEY = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const moneyFormats = new Map<string, Intl.NumberFormat>()

/** `Intl.NumberFormat` throws on a malformed code, so only a three-letter one is passed to it. */
const moneyFormatOf = (currency: string): Intl.NumberFormat => {
	if (!/^[A-Za-z]{3}$/u.test(currency)) return PLAIN_MONEY
	const cached = moneyFormats.get(currency)
	if (cached !== undefined) return cached
	const format = new Intl.NumberFormat("en-US", { style: "currency", currency })
	moneyFormats.set(currency, format)
	return format
}

/** Under half a cent either way is no amount: it reads and plots as zero, never as "-$0.00". */
const isNegligible = (amount: number): boolean => Math.abs(amount) < 0.005

/** An amount in the rows' billing currency, to the cent; a plain number when there is no currency. */
export const formatMoney = (amount: number, currency: string): string =>
	Number.isFinite(amount) ? moneyFormatOf(currency).format(isNegligible(amount) ? 0 : amount) : EMPTY_VALUE

/** A change with its sign; under half a cent either way reads as zero, unsigned. */
export const formatMoneyChange = (amount: number, currency: string): string => {
	if (!Number.isFinite(amount)) return EMPTY_VALUE
	if (isNegligible(amount)) return formatMoney(0, currency)
	return amount > 0 ? `+${formatMoney(amount, currency)}` : formatMoney(amount, currency)
}

const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
const DAY_WITH_YEAR = new Intl.DateTimeFormat("en-US", {
	month: "short",
	day: "numeric",
	year: "numeric",
	timeZone: "UTC",
})

/** A UTC day (`YYYY-MM-DD`) as "Nov 9", with its year when asked; unreadable text is shown as is. */
export const formatDay = (day: string, withYear = false): string => {
	const date = new Date(`${day}T00:00:00Z`)
	if (Number.isNaN(date.getTime())) return day
	return (withYear ? DAY_WITH_YEAR : DAY).format(date)
}

export type ChartRow = Readonly<Record<string, string | number | boolean>>

/** A series' name in the chart: the folded tail reads "Other", an empty key its placeholder. */
export const seriesLabel = (
	dimension: CostGroupBy,
	series: Readonly<{ key: string; other: boolean }>,
): string => (series.other ? OTHER_LABEL : keyLabel(dimension, series.key))

/**
 * One row per UTC day for the bar chart: a column per series in the answer's order (largest
 * first, "Other" last), and `partial` from the first day the provider may still restate.
 */
export const chartRows = (
	response: CostTimeseriesResponse,
	dimension: CostGroupBy,
): ReadonlyArray<ChartRow> =>
	Arr.map(response.days, (day, index) => ({
		bucket: `${day}T00:00:00Z`,
		...Rec.fromEntries(
			Arr.map(response.series, (series) => {
				// A fraction of a cent of credit would stretch the axis below zero for nothing.
				const point = series.points[index] ?? 0
				return [seriesLabel(dimension, series), isNegligible(point) ? 0 : point]
			}),
		),
		...(response.estimatedFrom !== null && day >= response.estimatedFrom ? { partial: true } : undefined),
	}))

/** No day of the window has cost. */
export const isEmptySeries = (response: CostTimeseriesResponse): boolean =>
	!Arr.some(response.series, (series) => Arr.some(series.points, (point) => point !== 0))

const DAY_MS = 86_400_000

/**
 * Whether every syncing source has history back to the start of the period before the window.
 * While one is still backfilling, that period reads as cheaper than it was, so the change against
 * it is not shown. A paused source no longer syncs and does not hold the comparison back.
 */
export const isPreviousPeriodSynced = (
	sources: ReadonlyArray<CostSourceSummary>,
	window: Readonly<{ startTime: string }> | null,
	days: number,
): boolean => {
	if (window === null) return true
	const firstDay = new Date(`${Str.slice(0, 10)(window.startTime)}T00:00:00Z`).getTime()
	if (!Number.isFinite(firstDay)) return true
	const previousStart = Str.slice(0, 10)(new Date(firstDay - days * DAY_MS).toISOString())
	return Arr.every(
		Arr.filter(sources, (source) => source.status !== "paused"),
		(source) =>
			source.historyComplete || (source.backfillDate !== null && source.backfillDate <= previousStart),
	)
}

/** AWS bills each Cost Explorer request USD 0.01. */
const REQUEST_COST_USD = 0.01

/** What a source's provider requests cost its account this month. */
export const requestsCost = (requests: number): string => `USD ${(requests * REQUEST_COST_USD).toFixed(2)}`
