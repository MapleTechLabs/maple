// A stored row's Prometheus label set, computed the same way in TypeScript (`seriesLabels`)
// and in ClickHouse (`labelValueExpr`), so label matchers can run in the WHERE clause.
// An empty value is a missing label, as in Prometheus.

import type { LabelMatcher } from "@maple/promql"
import * as CH from "@maple-dev/effect-orm/expr"
import { map as chMap, sql, string as chString } from "@maple-dev/effect-orm/clickhouse"
import { Array as Arr, Option, pipe, Record as Rec, String as Str } from "effect"
import { matchesValue } from "./names"

export interface StoredSeries {
	readonly promName: string
	readonly serviceName: string
	readonly attributes: Readonly<Record<string, string>>
	readonly resourceAttributes: Readonly<Record<string, string>>
	/** The bucket's upper bound, for `_bucket` series only. */
	readonly le: number | undefined
}

/** Label name rule: characters outside `[a-zA-Z0-9_]` become `_`, runs collapse, a leading digit gets `_`. */
export const normalizeLabelName = (key: string): string => {
	const cleaned = pipe(key, Str.replace(/[^a-zA-Z0-9_]/g, "_"), Str.replace(/_+/g, "_"))
	return /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned
}

/** Resource attributes that are identity or bookkeeping, not labels. */
const EXCLUDED_RESOURCE_PREFIXES = ["maple_", "maple.", "telemetry.", "service.", "process.command"]

export const isExcludedResourceKey = (key: string): boolean =>
	Arr.some(EXCLUDED_RESOURCE_PREFIXES, (prefix) => Str.startsWith(prefix)(key))

const lookup = (
	attrs: Readonly<Record<string, string>>,
	name: string,
	allowed: (key: string) => boolean,
): string => {
	if (Rec.has(attrs, name) && allowed(name)) return attrs[name] ?? ""
	return pipe(
		Rec.toEntries(attrs),
		Arr.findFirst(([key]) => allowed(key) && normalizeLabelName(key) === name),
		Option.match({ onNone: () => "", onSome: ([, value]) => value }),
	)
}

const always = () => true
const notExcluded = (key: string) => !isExcludedResourceKey(key)

/** One label's value; `""` when the series does not have it. */
export const labelValue = (row: StoredSeries, name: string): string => {
	if (name === "__name__") return row.promName
	if (name === "le" && row.le !== undefined) return formatLe(row.le)
	const datapoint = lookup(row.attributes, name, always)
	if (datapoint !== "") return datapoint
	if (name === "job") {
		const declared = row.resourceAttributes["service.name"] ?? ""
		const service = declared === "" ? row.serviceName : declared
		const namespace = row.resourceAttributes["service.namespace"] ?? ""
		return namespace === "" ? service : `${namespace}/${service}`
	}
	if (name === "instance") return row.resourceAttributes["service.instance.id"] ?? ""
	return lookup(row.resourceAttributes, name, notExcluded)
}

/** Go `strconv.FormatFloat(f, 'g', -1, 64)`, with `.0` on integers as Prometheus 3 writes `le`. */
export const formatLe = (le: number): string => {
	if (le === Infinity) return "+Inf"
	if (le === -Infinity) return "-Inf"
	if (Number.isNaN(le)) return "NaN"
	const [mantissa, exponentText = "0"] = Str.split(le.toExponential(), "e")
	const exponent = Number(exponentText)
	const text =
		exponent < -4 || exponent >= 6
			? `${mantissa}e${exponent < 0 ? "-" : "+"}${Str.padStart(2, "0")(String(Math.abs(exponent)))}`
			: String(le)
	return /[.e]/.test(text) ? text : `${text}.0`
}

/** Every label of a stored series. */
export const seriesLabels = (row: StoredSeries): Readonly<Record<string, string>> => {
	const names = new Set<string>(["__name__", "job", "instance"])
	if (row.le !== undefined) names.add("le")
	for (const key of Rec.keys(row.attributes)) names.add(normalizeLabelName(key))
	for (const key of Rec.keys(row.resourceAttributes)) {
		if (notExcluded(key)) names.add(normalizeLabelName(key))
	}
	// fromEntries defines own properties, so a label called __proto__ stays a label.
	return Rec.fromEntries(
		Arr.filter(
			Arr.map([...names].sort(), (name) => [name, labelValue(row, name)] as const),
			([, value]) => value !== "",
		),
	)
}

/** Whether a series' labels satisfy every matcher (a missing label is `""`). */
export const matchesAll = (labels: Readonly<Record<string, string>>, matchers: ReadonlyArray<LabelMatcher>) =>
	Arr.every(matchers, (m) =>
		matchesValue(
			m,
			Option.getOrElse(Rec.get(labels, m.name), () => ""),
		),
	)

/** The columns a label value reads. */
export interface LabelColumns {
	readonly Attributes: CH.Expr<Record<string, string>>
	readonly ResourceAttributes: CH.Expr<Record<string, string>>
	readonly ServiceName: CH.Expr<string>
}

/** `normalizeLabelName` of the lambda variable `_k`, in ClickHouse. */
const NORMALIZED_KEY = sql.raw(
	"concat(if(match(_k, '^[0-9]'), '_', ''), replaceRegexpAll(replaceRegexpAll(_k, '[^a-zA-Z0-9_]', '_'), '_+', '_'))",
)

/** Whether resource key `_k` is left out of the labels, in ClickHouse. */
export const EXCLUDED_KEY = sql.raw(
	`(${Arr.join(
		Arr.map(EXCLUDED_RESOURCE_PREFIXES, (prefix) => `startsWith(_k, '${prefix}')`),
		" OR ",
	)})`,
)

/** The exact key first; only a missing key pays for normalizing every key of the map. */
const mapLookupExpr = (map: CH.Expr<Record<string, string>>, name: string, filterExcluded: boolean) => {
	// Normalizing writes `_` for every change, so a name without one (job, instance) comes only from
	// that exact key, never an excluded one: skip the per-row regex over every key.
	if (!Str.includes("_")(name)) return sql(chString)`${map}[${name}]`
	const fallback = filterExcluded
		? sql(
				chString,
			)`mapValues(${map})[arrayFirstIndex(_k -> NOT ${EXCLUDED_KEY} AND ${NORMALIZED_KEY} = ${name}, mapKeys(${map}))]`
		: sql(
				chString,
			)`mapValues(${map})[arrayFirstIndex(_k -> ${NORMALIZED_KEY} = ${name}, mapKeys(${map}))]`
	if (filterExcluded && isExcludedResourceKey(name)) return fallback
	return sql(chString)`if(mapContains(${map}, ${name}), ${map}[${name}], ${fallback})`
}

/**
 * The value `labelValue` gives a label, as a ClickHouse expression; `undefined` for `__name__`
 * and `le`, which come from the resolved name and the bucket and are checked after the fetch.
 */
export const labelValueExpr = ($: LabelColumns, name: string): CH.Expr<string> | undefined => {
	if (name === "__name__" || name === "le") return undefined
	if (name === "job") return jobExpr($)
	if (name === "instance") return instanceExpr($)
	const datapoint = mapLookupExpr($.Attributes, name, false)
	const fromResource = mapLookupExpr($.ResourceAttributes, name, true)
	return sql(chString)`if(${datapoint} != '', ${datapoint}, ${fromResource})`
}

const jobExpr = ($: LabelColumns): CH.Expr<string> => {
	const datapoint = mapLookupExpr($.Attributes, "job", false)
	const resource = $.ResourceAttributes
	const service = sql(
		chString,
	)`if(${resource}['service.name'] != '', ${resource}['service.name'], ${$.ServiceName})`
	const namespace = sql(chString)`${resource}['service.namespace']`
	return sql(
		chString,
	)`if(${datapoint} != '', ${datapoint}, if(${namespace} != '', concat(${namespace}, '/', ${service}), ${service}))`
}

const instanceExpr = ($: LabelColumns): CH.Expr<string> => {
	const datapoint = mapLookupExpr($.Attributes, "instance", false)
	return sql(chString)`if(${datapoint} != '', ${datapoint}, ${$.ResourceAttributes}['service.instance.id'])`
}

/** Label names a map entry never sets: the name, job, instance, and `le` on a bucket. */
const computedNames = (bucket: boolean) =>
	sql.raw(bucket ? "['__name__', 'job', 'instance', 'le']" : "['__name__', 'job', 'instance']")

/** A map's `(label name, value)` pairs, resolved as `lookup` does, empty values dropped. */
const mapLabelPairs = (map: CH.Expr<Record<string, string>>, bucket: boolean) => {
	const names = sql`arrayMap(_k -> ${NORMALIZED_KEY}, mapKeys(${map}))`
	return sql`arrayFilter(_p -> _p.2 != '' AND NOT has(${computedNames(bucket)}, _p.1), arrayDistinct(arrayMap(_n -> (_n, if(mapContains(${map}, _n), ${map}[_n], mapValues(${map})[indexOf(${names}, _n)])), ${names})))`
}

/**
 * The labels `seriesLabels` gives a row, minus `__name__` and a bucket's `le`, as a ClickHouse
 * value that is equal exactly when they are: what the series key hashes.
 */
export const labelSetExpr = ($: LabelColumns, bucket: boolean) => {
	const datapoint = mapLabelPairs($.Attributes, bucket)
	const resource = mapLabelPairs(
		sql(chMap(chString, chString))`mapFilter((_k, _v) -> NOT ${EXCLUDED_KEY}, ${$.ResourceAttributes})`,
		bucket,
	)
	const shown = sql`arrayMap(_s -> _s.1, ${datapoint})`
	return sql`${jobExpr($)}, ${instanceExpr($)}, arraySort(arrayConcat(${datapoint}, arrayFilter(_r -> NOT has(${shown}, _r.1), ${resource})))`
}

/** A matcher as a WHERE condition, Prometheus semantics; `undefined` when it cannot be pushed down. */
export const matcherCondition = ($: LabelColumns, matcher: LabelMatcher): CH.Condition | undefined => {
	const value = labelValueExpr($, matcher.name)
	if (value === undefined) return undefined
	// The anchoring Prometheus uses; ClickHouse's `match` is RE2 like Prometheus'.
	const pattern = `^(?s:${matcher.value})$`
	switch (matcher.op) {
		case "=":
			return sql.cond`${value} = ${matcher.value}`
		case "!=":
			return sql.cond`${value} != ${matcher.value}`
		case "=~":
			return sql.cond`match(${value}, ${pattern})`
		case "!~":
			return sql.cond`NOT match(${value}, ${pattern})`
	}
}

/** The bound an `le` value names, when `formatLe` writes that bound exactly so; else none can match. */
const parseFormattedLe = (text: string): number | undefined => {
	if (text === "+Inf") return Infinity
	if (text === "-Inf") return -Infinity
	if (text === "NaN") return Number.NaN
	const value = Number(text)
	return Number.isFinite(value) && formatLe(value) === text ? value : undefined
}

/**
 * An equality matcher on a bucket's `le` as a condition on the bound, so it runs before the
 * series cap; `undefined` for a regex, which is checked after the fetch.
 */
export const leCondition = (le: CH.Expr<number>, matcher: LabelMatcher): CH.Condition | undefined => {
	if (matcher.op !== "=" && matcher.op !== "!=") return undefined
	const equal = boundEquals(le, parseFormattedLe(matcher.value))
	return matcher.op === "=" ? equal : sql.cond`NOT (${equal})`
}

const boundEquals = (le: CH.Expr<number>, bound: number | undefined): CH.Condition => {
	if (bound === undefined) return sql.cond`0`
	if (Number.isNaN(bound)) return sql.cond`isNaN(${le})`
	if (bound === Infinity) return sql.cond`${le} = inf`
	if (bound === -Infinity) return sql.cond`${le} = -inf`
	return sql.cond`${le} = ${bound}`
}
