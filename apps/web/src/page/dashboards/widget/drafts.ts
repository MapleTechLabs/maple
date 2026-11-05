import {
	createQueryDraft,
	formatFiltersAsWhereClause,
	formulaLabel,
	queryLabel,
	type QueryBuilderMetricType,
} from "@maple/query-engine/query-builder"
import {
	type QueryBuilderFormulaPayload,
	type QueryBuilderQueryDraftPayload,
	toQueryBuilderDataSource,
	toQueryBuilderMetricType,
} from "@maple/query-model"
import { Option, Schema, Array as Arr, String as Str } from "effect"
import type { FormulaDraft, QueryDraft } from "./editor-state"

// Stored query sets read back into editor drafts, and the predicates over them
// (`loadQueryDrafts`, `inferDefaultUnitForQueries`, `deriveDefaultWidgetTitle`, ...).

/** `toQueryGroupByArray`: a stored draft with no group-by list groups by service. */
const groupByOf = (groupBy: ReadonlyArray<string> | undefined): Array<string> =>
	groupBy === undefined ? ["service.name"] : Arr.filter(groupBy, (item) => Str.trim(item).length > 0)

/** `normalizeLoadedQuery`: every field filled from the stored draft or the defaults. */
const normalizeLoadedQuery = (raw: QueryBuilderQueryDraftPayload, index: number): QueryDraft => {
	// The template only supplies defaults; its random id is always replaced or discarded.
	const base = createQueryDraft(index)
	const source = toQueryBuilderDataSource(raw.dataSource) ?? base.dataSource
	const shared = {
		id: raw.id || base.id,
		name: raw.name || queryLabel(index),
		enabled: raw.enabled ?? base.enabled,
		hidden: raw.hidden ?? base.hidden,
		whereClause: raw.whereClause ?? base.whereClause,
		aggregation: raw.aggregation || base.aggregation,
		stepInterval: raw.stepInterval ?? base.stepInterval,
		orderByDirection: raw.orderByDirection ?? base.orderByDirection,
		addOns: {
			groupBy: raw.addOns?.groupBy ?? base.addOns.groupBy,
			having: raw.addOns?.having ?? base.addOns.having,
			orderBy: raw.addOns?.orderBy ?? base.addOns.orderBy,
			limit: raw.addOns?.limit ?? base.addOns.limit,
			legend: raw.addOns?.legend ?? base.addOns.legend,
		},
		groupBy: groupByOf(raw.groupBy),
		having: raw.having ?? base.having,
		orderBy: raw.orderBy ?? base.orderBy,
		limit: raw.limit ?? base.limit,
		legend: raw.legend ?? base.legend,
	}
	if (source === "metrics") {
		const metrics = raw.dataSource === "metrics" ? raw : undefined
		const metricType: QueryBuilderMetricType = toQueryBuilderMetricType(metrics?.metricType) ?? "gauge"
		return {
			...shared,
			dataSource: "metrics",
			signalSource: metrics?.signalSource === "meter" ? "meter" : "default",
			metricName: metrics?.metricName ?? "",
			metricType,
			isMonotonic: metrics?.isMonotonic ?? metrics?.metricType === "sum",
			...(metrics?.spaceAggregation === undefined ? undefined : { spaceAggregation: metrics.spaceAggregation }),
		}
	}
	if (source === "logs") return { ...shared, dataSource: "logs" }
	if (source === "product_events") return { ...shared, dataSource: "product_events" }
	return { ...shared, dataSource: "traces" }
}

/** `loadQueryDrafts`: a stored draft without a where clause string is dropped. */
export const loadQueryDrafts = (set: {
	readonly queries: ReadonlyArray<QueryBuilderQueryDraftPayload>
	readonly formulas?: ReadonlyArray<QueryBuilderFormulaPayload> | undefined
}): { queries: ReadonlyArray<QueryDraft>; formulas: ReadonlyArray<FormulaDraft> } => ({
	queries: Arr.map(
		Arr.filter(
			set.queries,
			(query) => typeof query.id === "string" && typeof query.whereClause === "string",
		),
		normalizeLoadedQuery,
	),
	formulas: Arr.map(set.formulas ?? [], (formula, index) => ({
		...formula,
		name: formula.name || formulaLabel(index),
		hidden: formula.hidden ?? false,
	})),
})

export const isVisibleQuery = (query: QueryDraft): boolean => query.enabled !== false && !query.hidden

export const hasActiveGroupBy = (query: QueryDraft): boolean =>
	query.addOns.groupBy &&
	Arr.some(query.groupBy, (g) => Str.trim(g) !== "" && Str.toLowerCase(Str.trim(g)) !== "none")

/** `inferDisplayUnitForQuery`: from the source, aggregation and metric name alone. */
export const inferDisplayUnitForQuery = (
	query: Readonly<{ dataSource: string; aggregation: string; metricName?: string | undefined }>,
): string | undefined => {
	if (query.dataSource === "traces") {
		if (query.aggregation === "error_rate") return "percent"
		if (["avg_duration", "p50_duration", "p95_duration", "p99_duration"].includes(query.aggregation))
			return "duration_ms"
		return query.aggregation === "count" ? "number" : undefined
	}
	if (query.dataSource === "logs" || query.dataSource === "product_events") return "number"
	const lower = Str.toLowerCase(query.metricName ?? "")
	if (/\b(error[._ -]?rate|percentage|percent)\b/.test(lower)) return "percent"
	if (/[._](seconds|s)$/.test(lower) || /\b(duration[._]seconds)\b/.test(lower)) return "duration_s"
	if (/\b(duration|latency|response[._]time)\b/.test(lower)) return "duration_ms"
	if (/\b(bytes|memory|size)\b/.test(lower)) return "bytes"
	if (query.aggregation === "rate") return "requests_per_sec"
	return ["count", "sum", "avg", "min", "max", "latest", "increase"].includes(query.aggregation)
		? "number"
		: undefined
}

/** `inferDefaultUnitForQueries`: the unit every visible query agrees on, if any. */
export const inferDefaultUnitForQueries = (queries: ReadonlyArray<QueryDraft>): string | undefined => {
	const units = Arr.map(Arr.filter(queries, isVisibleQuery), inferDisplayUnitForQuery)
	const [first] = units
	return first !== undefined && Arr.every(units, (unit) => unit === first) ? first : undefined
}

const TRACES_AGGREGATION_TITLES = new Map([
	["count", "Count of traces"],
	["avg_duration", "Avg duration"],
	["p50_duration", "P50 duration"],
	["p95_duration", "P95 duration"],
	["p99_duration", "P99 duration"],
	["error_rate", "Error rate"],
	["apdex", "Apdex"],
])

const PRODUCT_EVENTS_AGGREGATION_TITLES = new Map([
	["count", "Count of events"],
	["sessions", "Sessions with events"],
	["persons", "Persons with events"],
	["users", "Users with events"],
	["visitors", "Visitors with events"],
])

/** `deriveDefaultWidgetTitle`: "Error rate by service.name" for a widget saved untitled. */
export const deriveDefaultWidgetTitle = (queries: ReadonlyArray<QueryDraft>): string => {
	const query = Option.getOrElse(Arr.findFirst(queries, isVisibleQuery), () => queries[0])
	if (query === undefined) return "Untitled"
	const groupBy = hasActiveGroupBy(query)
		? Arr.join(
				Arr.filter(
					Arr.map(query.groupBy, (g) => Str.trim(g)),
					(g) => g !== "" && Str.toLowerCase(g) !== "none",
				),
				", ",
			)
		: ""
	const bySuffix = groupBy === "" ? "" : ` by ${groupBy}`
	if (query.dataSource === "metrics") {
		const metric = Str.trim(query.metricName)
		return metric === "" ? "Metric" : `${query.aggregation} of ${metric}${bySuffix}`
	}
	if (query.dataSource === "logs") return `Count of logs${bySuffix}`
	if (query.dataSource === "product_events")
		return `${PRODUCT_EVENTS_AGGREGATION_TITLES.get(query.aggregation) ?? query.aggregation}${bySuffix}`
	const base = TRACES_AGGREGATION_TITLES.get(query.aggregation) ?? `${query.aggregation} of traces`
	return `${base}${bySuffix}`
}

const uniqueName = (taken: ReadonlyArray<string>, base: string): string => {
	if (!taken.includes(base)) return base
	const suffix = Option.getOrElse(
		Arr.findFirst(
			Array.from({ length: taken.length + 1 }, (_, index) => index + 2),
			(candidate) => !taken.includes(`${base} (${candidate})`),
		),
		() => taken.length + 2,
	)
	return `${base} (${suffix})`
}

/** `toSeriesFieldOptions`: the enabled, visible series a stat can reduce, named as the chart names them. */
export const toSeriesFieldOptions = (
	state: Readonly<{ queries: ReadonlyArray<QueryDraft>; formulas: ReadonlyArray<FormulaDraft> }>,
): ReadonlyArray<string> =>
	Arr.reduce<string, ReadonlyArray<string>>(
		Arr.map(
			[
				...Arr.filter(state.queries, isVisibleQuery),
				...Arr.filter(state.formulas, (formula) => !formula.hidden),
			],
			(entry) => Str.trim(entry.legend) || entry.name,
		),
		[],
		(options, base) => [...options, uniqueName(options, base)],
	)

/** A pre-query-builder widget's route params, the fields `legacyQueryDraft` reads. */
const LegacyParams = Schema.Struct({
	source: Schema.optional(Schema.Unknown),
	metric: Schema.optional(Schema.Unknown),
	bucketSeconds: Schema.optional(Schema.Unknown),
	groupBy: Schema.optional(Schema.Unknown),
	filters: Schema.optional(
		Schema.Struct({
			metricName: Schema.optional(Schema.Unknown),
			metricType: Schema.optional(Schema.Unknown),
		}),
	),
})
const decodeLegacyParams = Schema.decodeUnknownOption(LegacyParams)
const NO_PARAMS: typeof LegacyParams.Type = {}

/** `legacyQueryDraft`: query A read out of a route widget's params (`custom_timeseries` and friends). */
export const legacyQueryDraft = (raw: Readonly<Record<string, unknown>>): QueryDraft => {
	const params = Option.getOrElse(decodeLegacyParams(raw), () => NO_PARAMS)
	const fallback = createQueryDraft(0)
	const groupBy = Arr.isArray(params.groupBy)
		? Arr.filter(
				params.groupBy,
				(item): item is string => typeof item === "string" && Str.trim(item).length > 0,
			)
		: ["service.name"]
	const base = {
		...fallback,
		whereClause: formatFiltersAsWhereClause({ ...raw }),
		// No metric reads as a count, never the new-query default (error rate).
		aggregation: typeof params.metric === "string" ? params.metric : "count",
		stepInterval:
			typeof params.bucketSeconds === "number" ? String(params.bucketSeconds) : fallback.stepInterval,
		addOns: { ...fallback.addOns, groupBy: Arr.isArray(params.groupBy) && params.groupBy.length > 0 },
		groupBy,
	}
	if (params.source === "metrics") {
		const metricName = params.filters?.metricName
		return {
			...base,
			dataSource: "metrics",
			signalSource: "default",
			metricName: typeof metricName === "string" ? metricName : "",
			metricType: toQueryBuilderMetricType(params.filters?.metricType) ?? "gauge",
			isMonotonic: false,
		}
	}
	return params.source === "logs" ? { ...base, dataSource: "logs" } : { ...base, dataSource: "traces" }
}

/** `toHiddenSeriesBaseNames`: hidden queries and formulas, by their legend or name. */
export const hiddenSeriesBaseNames = (
	queries: ReadonlyArray<QueryDraft>,
	formulas: ReadonlyArray<FormulaDraft>,
): Array<string> => [
	...new Set(
		Arr.map(
			Arr.filter([...queries, ...formulas], (entry) => entry.hidden),
			(entry) => Str.trim(entry.legend) || entry.name,
		),
	),
]
