import { CostProvider } from "@maple/domain/cost"
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
import { Array as Arr, Option, Record as Rec, Schema, String as Str } from "effect"
import { COST_GROUP_BYS } from "../../route/search"
import type { Search } from "./model"
import { accountLabel } from "./marks"
import { COST_PROVIDERS } from "./providers"

// What the cost page reads off its URL and its answers: the grouping, the filters, money and days.

export type CostGroupBy = (typeof COST_GROUP_BYS)[number]

/** One value per dimension, keyed by it: the facets' reads, filters and answers. */
export const perDimension = <A>(of: (dimension: CostGroupBy) => A): Readonly<Record<CostGroupBy, A>> => ({
	cloud_service: of("cloud_service"),
	provider: of("provider"),
	service_category: of("service_category"),
	region: of("region"),
	resource: of("resource"),
	account: of("account"),
})

export const DEFAULT_GROUP_BY: CostGroupBy = "cloud_service"

/** Each dimension's name in the control, the chips and the table, and what an empty key reads as. */
export const DIMENSIONS = {
	cloud_service: { label: "Service", noun: "service", empty: "Unassigned" },
	provider: { label: "Provider", noun: "provider", empty: "No provider" },
	service_category: { label: "Category", noun: "category", empty: "Uncategorized" },
	region: { label: "Region", noun: "region", empty: "No region" },
	// What a charge is billed for, where the provider says: a Vercel project.
	resource: { label: "Resource", noun: "resource", empty: "No resource" },
	// The account the connection reads, which for a management account bills its members' cost too.
	account: { label: "Connected account", noun: "connected account", empty: "No account" },
} as const satisfies Record<CostGroupBy, Readonly<{ label: string; noun: string; empty: string }>>

export const groupByOf = (search: Search): CostGroupBy => search.groupBy ?? DEFAULT_GROUP_BY

export const sortOf = (search: Search): CostBreakdownSortBy => search.sort ?? "cost"

const decodeProvider = Schema.decodeUnknownOption(CostProvider)

/**
 * A key as the page shows it: the provider's own text, the dimension's placeholder for "", a
 * provider by its name, not by the id rows carry, and an account by the provider that reads it.
 */
export const keyLabel = (
	dimension: CostGroupBy,
	key: string,
	sources: ReadonlyArray<CostSourceSummary> = [],
): string => {
	if (key === "") return DIMENSIONS[dimension].empty
	if (dimension === "account") return accountLabel(key, sources)
	if (dimension !== "provider") return key
	return Option.match(decodeProvider(key), {
		onNone: () => key,
		onSome: (provider) => COST_PROVIDERS[provider].name,
	})
}

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

/**
 * Where a row's click goes next: the grouping that splits it further, skipping one already
 * narrowed. Grouped by service it moves to region, by anything else to service.
 */
const DRILL_ORDER = {
	cloud_service: ["region", "resource", "account"],
	provider: ["cloud_service", "account", "region", "resource"],
	service_category: ["cloud_service", "region", "resource"],
	region: ["cloud_service", "resource", "account"],
	resource: ["cloud_service", "region", "account"],
	account: ["cloud_service", "region", "resource"],
} as const satisfies Record<CostGroupBy, ReadonlyArray<CostGroupBy>>

/**
 * The dimensions the cost on the page does not split by, which the rail and a drill-down leave
 * out. Only resources can be missing: no provider names one for every charge, and some for none.
 */
export const unsplitDimensions = (
	facets: Readonly<Record<CostGroupBy, ReadonlyArray<Readonly<{ key: string }>>>> | undefined,
): ReadonlyArray<CostGroupBy> =>
	facets !== undefined && Arr.some(facets.resource, (row) => row.key !== "") ? [] : ["resource"]

/**
 * The grouping a row's click switches to, or the current one when every next step is narrowed.
 * `unsplit` are the dimensions with nothing to split by, which it passes over.
 */
export const drillTarget = (
	search: Search,
	dimension: CostGroupBy,
	unsplit: ReadonlyArray<CostGroupBy> = [],
): CostGroupBy =>
	Arr.findFirst(
		DRILL_ORDER[dimension],
		(next) => (search[next] ?? []).length === 0 && !Arr.contains(unsplit, next),
	).pipe(Option.getOrElse(() => dimension))

/** A row's click: the page narrowed to the row's key, then split by the next dimension. */
export const drilledInto = (
	search: Search,
	filter: ActiveFilter,
	unsplit: ReadonlyArray<CostGroupBy> = [],
): Search => {
	const narrowed = withFilter(search, filter)
	return narrowed === search
		? search
		: { ...narrowed, groupBy: drillTarget(narrowed, filter.dimension, unsplit) }
}

/** A rail checkbox: the value leaves the dimension's filter when it is in it, else joins it. */
export const toggledFilter = (search: Search, filter: ActiveFilter): Search =>
	hasFilter(search, filter) ? withoutFilter(search, filter) : withFilter(search, filter)

/** A rail row's Only: the dimension narrowed to the one value. */
export const onlyFilter = (search: Search, filter: ActiveFilter): Search =>
	filter.value.length > COST_FILTER_MAX_VALUE_LENGTH
		? search
		: withValues(search, filter.dimension, [filter.value])

/** What a dimension's facet reads under: every filter but its own, so its other values stay on offer. */
export const facetFilters = (search: Search, dimension: CostGroupBy): CostFilters | undefined =>
	requestFilters(withValues(search, dimension, []))

export const withoutFilter = (search: Search, filter: ActiveFilter): Search =>
	withValues(
		search,
		filter.dimension,
		Arr.filter(search[filter.dimension] ?? [], (value) => value !== filter.value),
	)

const DAY_SECONDS = 24 * 60 * 60
// A day picked whole in the custom tab runs 00:00 to 23:59, and an hour less where clocks go forward.
const SHORTEST_CUSTOM_DAY_SECONDS = 22 * 60 * 60

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
		parseWarehouseDateTime(range.endTime) - parseWarehouseDateTime(range.startTime) <
			SHORTEST_CUSTOM_DAY_SECONDS * 1000
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

type SeriesKey = Readonly<{ key: string; other: boolean }>

/** `name`, or its first marked form no taken name has: one of `taken.length + 2` forms is free. */
const freeName = (name: string, mark: string, taken: ReadonlyArray<string>): string =>
	Arr.findFirst(
		Arr.makeBy(taken.length + 2, (index) =>
			index === 0 ? name : index === 1 ? `${name} (${mark})` : `${name} (${mark} ${index})`,
		),
		(candidate) => !Arr.contains(taken, candidate),
	).pipe(Option.getOrElse(() => name))

/** The columns of a chart row that are not series: the day, and whether it is still open. */
const ROW_FIELDS: ReadonlyArray<string> = ["bucket", "partial"]

/**
 * Each series' name in the chart, in order: the folded tail reads "Other", an empty key its
 * placeholder. A name is a chart column, so one a real key or the row itself already has is
 * told apart from it.
 */
export const seriesLabels = (
	dimension: CostGroupBy,
	series: ReadonlyArray<SeriesKey>,
	sources: ReadonlyArray<CostSourceSummary> = [],
): ReadonlyArray<string> => {
	// A series reads by the name its table row shows.
	const nameOf = (key: string) => keyLabel(dimension, key, sources)
	const named = Arr.flatMap(series, (entry) => (entry.other || entry.key === "" ? [] : [nameOf(entry.key)]))
	const taken = [...named, ...ROW_FIELDS]
	const empty = freeName(DIMENSIONS[dimension].empty, "empty", taken)
	const other = freeName(OTHER_LABEL, "the rest", [...taken, empty])
	return Arr.map(series, (entry) =>
		entry.other
			? other
			: entry.key === ""
				? empty
				: Arr.contains(ROW_FIELDS, nameOf(entry.key))
					? freeName(nameOf(entry.key), "series", [...taken, empty, other])
					: nameOf(entry.key),
	)
}

/**
 * One row per UTC day for the bar chart: a column per series in the answer's order (largest
 * first, "Other" last), and `partial` from the first day the provider may still restate.
 */
export const chartRows = (
	response: CostTimeseriesResponse,
	dimension: CostGroupBy,
	sources: ReadonlyArray<CostSourceSummary> = [],
): ReadonlyArray<ChartRow> => {
	const labels = seriesLabels(dimension, response.series, sources)
	return Arr.map(response.days, (day, index) => ({
		bucket: `${day}T00:00:00Z`,
		...Rec.fromEntries(
			Arr.map(response.series, (series, position) => {
				// A fraction of a cent of credit would stretch the axis below zero for nothing.
				const point = series.points[index] ?? 0
				return [labels[position] ?? series.key, isNegligible(point) ? 0 : point]
			}),
		),
		...(response.estimatedFrom !== null && day >= response.estimatedFrom ? { partial: true } : undefined),
	}))
}

/** No day of the window has cost. */
export const isEmptySeries = (response: CostTimeseriesResponse): boolean =>
	!Arr.some(response.series, (series) => Arr.some(series.points, (point) => point !== 0))

const DAY_MS = 86_400_000

/** `synced`: comparable. `syncing`: a source still backfills it. `beyond`: older than the history read. */
export type PreviousPeriod = "synced" | "syncing" | "beyond"

/**
 * Whether every source with cost has history back to the start of the period before the window.
 * Short of that the period reads as cheaper than it was, so no change is shown against it: while
 * a source backfills, and for good once its history is complete or it is paused, which cannot
 * fill the gap. A paused source that never synced has no cost and holds nothing back. A view
 * filtered to some providers reads only their sources, so only those can hold it back.
 */
export const previousPeriodOf = (
	sources: ReadonlyArray<CostSourceSummary>,
	window: Readonly<{ startTime: string }> | null,
	days: number,
	search: Search,
): PreviousPeriod => {
	if (window === null) return "synced"
	const providers = search.provider ?? []
	const read =
		providers.length === 0
			? sources
			: Arr.filter(sources, (source) => Arr.contains(providers, source.provider))
	const firstDay = new Date(`${Str.slice(0, 10)(window.startTime)}T00:00:00Z`).getTime()
	if (!Number.isFinite(firstDay)) return "synced"
	const previousStart = Str.slice(0, 10)(new Date(firstDay - days * DAY_MS).toISOString())
	const short = Arr.filter(read, (source) =>
		source.backfillDate === null ? source.status !== "paused" : source.backfillDate > previousStart,
	)
	if (short.length === 0) return "synced"
	return Arr.some(short, (source) => source.status !== "paused" && !source.historyComplete)
		? "syncing"
		: "beyond"
}

/** What a source's provider requests cost its account this month, or null when the provider bills none. */
export const requestsCost = (provider: CostProvider, requests: number): string | null => {
	const { requestUsd } = COST_PROVIDERS[provider]
	return requestUsd === null ? null : `USD ${(requests * requestUsd).toFixed(2)}`
}
