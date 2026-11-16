// Prometheus names for OTel metrics, after the OpenTelemetry-to-Prometheus translation
// ("UnderscoreEscapingWithSuffixes"), plus the stored name itself so scraped data matches as-is.

import { anchoredRegex, type LabelMatcher, type LabelRegex } from "@maple/promql"
import { Array as Arr, Option, pipe, String as Str } from "effect"

export type OtelMetricType = "sum" | "gauge" | "histogram" | "exponential_histogram"

export type MetricTable =
	| "metrics_sum"
	| "metrics_gauge"
	| "metrics_histogram"
	| "metrics_exponential_histogram"

/** Which value of a stored metric a Prometheus name reads. */
export type MetricComponent = "value" | "bucket" | "count" | "sum"

export interface CatalogMetric {
	readonly metricName: string
	readonly metricType: OtelMetricType
	readonly isMonotonic: boolean
	readonly unit: string
}

export interface PromNameTarget {
	readonly table: MetricTable
	/** The stored OTel name. */
	readonly metricName: string
	readonly component: MetricComponent
	readonly promName: string
	/** The stored unit: one name may be stored in two units, which are two metrics. */
	readonly unit: string
}

const TABLES = {
	sum: "metrics_sum",
	gauge: "metrics_gauge",
	histogram: "metrics_histogram",
	exponential_histogram: "metrics_exponential_histogram",
} satisfies Record<OtelMetricType, MetricTable>

export const tableOf = (type: OtelMetricType): MetricTable => TABLES[type]

/** Replace characters outside `[a-zA-Z0-9_:]`, collapse and trim underscores, guard a leading digit. */
export const normalizeMetricName = (name: string): string => {
	const cleaned = pipe(
		name,
		Str.replace(/[^a-zA-Z0-9_:]/g, "_"),
		Str.replace(/_+/g, "_"),
		Str.replace(/^_+|_+$/g, ""),
	)
	return /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned
}

const UNITS = new Map<string, string>([
	["d", "days"],
	["h", "hours"],
	["min", "minutes"],
	["s", "seconds"],
	["ms", "milliseconds"],
	["us", "microseconds"],
	["ns", "nanoseconds"],
	["By", "bytes"],
	["KiBy", "kibibytes"],
	["MiBy", "mebibytes"],
	["GiBy", "gibibytes"],
	["TiBy", "tebibytes"],
	["KBy", "kilobytes"],
	["MBy", "megabytes"],
	["GBy", "gigabytes"],
	["TBy", "terabytes"],
	["m", "meters"],
	["V", "volts"],
	["A", "amperes"],
	["J", "joules"],
	["W", "watts"],
	["g", "grams"],
	["Cel", "celsius"],
	["Hz", "hertz"],
	["%", "percent"],
])

const PER_UNITS = new Map<string, string>([
	["s", "second"],
	["m", "minute"],
	["h", "hour"],
	["d", "day"],
	["w", "week"],
	["mo", "month"],
	["y", "year"],
])

const unitTokens = (unit: string): ReadonlyArray<string> =>
	Arr.filter(Str.split(normalizeMetricName(unit), "_"), (token) => token !== "")

/** The unit's Prometheus suffix tokens: `{...}` annotations dropped, `x/y` as `x_per_y`. */
export const unitSuffix = (unit: string, metricType: OtelMetricType): ReadonlyArray<string> => {
	const stripped = pipe(unit, Str.replace(/\{[^}]*\}/g, ""), Str.trim)
	if (stripped === "1") return metricType === "gauge" ? ["ratio"] : []
	if (stripped === "") return []
	const [main, per] = Option.match(Str.indexOf("/")(stripped), {
		onNone: () => [stripped, ""] as const,
		onSome: (slash) =>
			[Str.trim(Str.slice(0, slash)(stripped)), Str.trim(Str.slice(slash + 1)(stripped))] as const,
	})
	const mainTokens = main === "" || main === "1" ? [] : unitTokens(UNITS.get(main) ?? main)
	const perTokens = per === "" ? [] : unitTokens(PER_UNITS.get(per) ?? per)
	return perTokens.length === 0 ? mainTokens : [...mainTokens, "per", ...perTokens]
}

/** Appends the suffix unless the name already holds it as whole tokens (`node_cpu_seconds_total`). */
const withSuffix = (base: string, suffix: ReadonlyArray<string>): string => {
	if (suffix.length === 0) return base
	const tail = Arr.join(suffix, "_")
	return Str.includes(`_${tail}_`)(`_${base}_`) ? base : `${base}_${tail}`
}

const withTotal = (base: string): string => withSuffix(Str.replace(/_total(?=_|$)/g, "")(base), ["total"])

const unique = (names: ReadonlyArray<string>): ReadonlyArray<string> =>
	Arr.dedupe(Arr.filter(names, (name) => name !== ""))

/** The base names a stored metric answers to, the canonical (suffixed) one first. */
const baseNames = (metric: CatalogMetric): ReadonlyArray<string> => {
	const normalized = normalizeMetricName(metric.metricName)
	const withUnit = withSuffix(normalized, unitSuffix(metric.unit, metric.metricType))
	return unique([withUnit, normalized])
}

export interface PromName {
	readonly promName: string
	readonly component: MetricComponent
}

/** Every Prometheus name of a stored metric, in preference order (canonical first, stored name last). */
export const promNamesOf = (metric: CatalogMetric): ReadonlyArray<PromName> => {
	const bases = baseNames(metric)
	switch (metric.metricType) {
		case "sum":
		case "gauge": {
			const counter = metric.metricType === "sum" && metric.isMonotonic
			const names = counter ? [...Arr.map(bases, withTotal), ...bases] : bases
			return Arr.map(unique([...names, metric.metricName]), (promName) => ({
				promName,
				component: "value",
			}))
		}
		case "histogram":
		case "exponential_histogram": {
			const suffixed = (suffix: string, component: MetricComponent): ReadonlyArray<PromName> =>
				Arr.map(bases, (base) => ({ promName: `${base}_${suffix}`, component }))
			return [
				...(metric.metricType === "histogram" ? suffixed("bucket", "bucket") : []),
				...suffixed("count", "count"),
				...suffixed("sum", "sum"),
			]
		}
	}
}

const regexCache = new Map<string, Option.Option<LabelRegex>>()

const regexOf = (pattern: string): Option.Option<LabelRegex> => {
	const cached = regexCache.get(pattern)
	if (cached !== undefined) return cached
	const compiled = anchoredRegex(pattern)
	if (regexCache.size > 512) regexCache.clear()
	regexCache.set(pattern, compiled)
	return compiled
}

/** Prometheus matcher semantics on one value; regexes are fully anchored. */
export const matchesValue = (matcher: LabelMatcher, value: string): boolean => {
	switch (matcher.op) {
		case "=":
			return value === matcher.value
		case "!=":
			return value !== matcher.value
		case "=~":
			return Option.match(regexOf(matcher.value), {
				onNone: () => false,
				onSome: (re) => re.test(value),
			})
		case "!~":
			return Option.match(regexOf(matcher.value), {
				onNone: () => true,
				onSome: (re) => !re.test(value),
			})
	}
}

/**
 * The stored metrics a selector's `__name__` matchers select. Each stored metric and component
 * answers to one name: the first of its names, in preference order, that every matcher accepts.
 */
// One query resolves up to MAX_SELECTORS selectors against the same catalog: derive each metric's
// names once, and index them so an exact `__name__` reads only its candidates.
const namesByMetric = new WeakMap<CatalogMetric, ReadonlyArray<PromName>>()
const metricsByName = new WeakMap<
	ReadonlyArray<CatalogMetric>,
	ReadonlyMap<string, ReadonlyArray<CatalogMetric>>
>()

const cachedPromNames = (metric: CatalogMetric): ReadonlyArray<PromName> => {
	const known = namesByMetric.get(metric)
	if (known !== undefined) return known
	const names = promNamesOf(metric)
	namesByMetric.set(metric, names)
	return names
}

const nameIndex = (
	catalog: ReadonlyArray<CatalogMetric>,
): ReadonlyMap<string, ReadonlyArray<CatalogMetric>> => {
	const known = metricsByName.get(catalog)
	if (known !== undefined) return known
	const index = new Map<string, Array<CatalogMetric>>()
	for (const metric of catalog) {
		for (const name of unique(Arr.map(cachedPromNames(metric), (n) => n.promName))) {
			const metrics = index.get(name)
			if (metrics === undefined) index.set(name, [metric])
			else metrics.push(metric)
		}
	}
	metricsByName.set(catalog, index)
	return index
}

export const resolveSelectorName = (
	nameMatchers: ReadonlyArray<LabelMatcher>,
	catalog: ReadonlyArray<CatalogMetric>,
): ReadonlyArray<PromNameTarget> => {
	const exact = Arr.findFirst(nameMatchers, (m) => m.op === "=")
	const candidates = Option.isSome(exact) ? (nameIndex(catalog).get(exact.value.value) ?? []) : catalog
	return Arr.flatMap(candidates, (metric) => {
		const picked = new Map<MetricComponent, string>()
		for (const { promName, component } of cachedPromNames(metric)) {
			if (picked.has(component)) continue
			if (Arr.every(nameMatchers, (m) => matchesValue(m, promName))) picked.set(component, promName)
		}
		return Arr.map([...picked], ([component, promName]) => ({
			table: tableOf(metric.metricType),
			metricName: metric.metricName,
			component,
			promName,
			unit: metric.unit,
		}))
	})
}
