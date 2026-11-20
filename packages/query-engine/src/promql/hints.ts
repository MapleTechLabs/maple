// Why a PromQL selector matched nothing, as Prometheus-style warnings: the nearest metric names
// in the catalog and the nearest label names its series carry. Pure.

import type { LabelMatcher } from "@maple/promql"
import { Array as Arr, Order, String as Str } from "effect"
import { canonicalPromNames } from "./discovery"
import { type CatalogMetric, matchesValue, normalizeMetricName, promNamesOf } from "./names"

/** Names one warning suggests at most. */
const SUGGESTIONS = 3
/** Candidates scored by edit distance at most; the rest are ranked out by shared tokens first. */
const POOL = 2_000
/** Below this similarity a name is noise, not a suggestion. */
const MIN_SIMILARITY = 0.35

const tokensOf = (name: string): ReadonlyArray<string> =>
	Arr.filter(Str.split(Str.toLowerCase(name), /[^a-z0-9]+/), (token) => token !== "")

/** Levenshtein distance over two rolling rows. */
export const editDistance = (a: string, b: string): number => {
	const bChars = Arr.fromIterable(b)
	const last = Arr.reduce(
		Arr.fromIterable(a),
		Arr.makeBy(bChars.length + 1, (j) => j),
		(previous: ReadonlyArray<number>, aChar, i) => {
			const first: Array<number> = [i + 1]
			return Arr.reduce(bChars, first, (row, bChar, j) => {
				row.push(
					Math.min(
						(previous[j + 1] ?? 0) + 1,
						(row[j] ?? 0) + 1,
						(previous[j] ?? 0) + (aChar === bChar ? 0 : 1),
					),
				)
				return row
			})
		},
	)
	return last[bChars.length] ?? 0
}

const sharedTokens = (a: ReadonlyArray<string>, b: ReadonlySet<string>): number =>
	Arr.filter(Arr.dedupe(a), (token) => b.has(token)).length

/** 0 to 1: shared tokens (Jaccard) weighted over normalized edit distance. */
const similarity = (target: string, targetTokens: ReadonlyArray<string>, candidate: string): number => {
	const tokens = tokensOf(candidate)
	const shared = sharedTokens(targetTokens, new Set(tokens))
	const union = new Set([...targetTokens, ...tokens]).size
	const maxLength = Math.max(target.length, candidate.length, 1)
	const lower = Str.toLowerCase(target)
	return (
		0.6 * (union === 0 ? 0 : shared / union) +
		0.4 * (1 - editDistance(lower, Str.toLowerCase(candidate)) / maxLength)
	)
}

/** The `limit` candidates closest to `target`, best first; none when nothing is close. */
export const nearestNames = (
	target: string,
	candidates: ReadonlyArray<string>,
	limit: number = SUGGESTIONS,
): ReadonlyArray<string> => {
	const targetTokens = tokensOf(target)
	const targetSet = new Set(targetTokens)
	const unique = Arr.filter(Arr.dedupe(candidates), (name) => name !== target)
	const pool = Arr.take(
		Arr.sort(
			unique,
			Order.mapInput(Order.flip(Order.Number), (name: string) =>
				sharedTokens(tokensOf(name), targetSet),
			),
		),
		POOL,
	)
	const scored = Arr.filter(
		Arr.map(pool, (name) => [similarity(target, targetTokens, name), name] as const),
		([score]) => score >= MIN_SIMILARITY,
	)
	const byScore = Order.combine(
		Order.mapInput(Order.flip(Order.Number), ([score]: readonly [number, string]) => score),
		Order.mapInput(Order.String, ([, name]: readonly [number, string]) => name),
	)
	return Arr.map(Arr.take(Arr.sort(scored, byScore), limit), ([, name]) => name)
}

const SUFFIX = /_(total|bucket|count|sum|seconds|milliseconds|microseconds|nanoseconds|bytes|ratio|percent)$/

/** A name without its type and unit suffixes, so `foo_seconds_total` and `foo` meet. */
const stem = (name: string): string => {
	const next = Str.replace(SUFFIX, "")(name)
	return next === name ? name : stem(next)
}

/** The first name of each component: the one a bare selector reads the metric by. */
const canonicalOf = (metric: CatalogMetric): ReadonlyArray<string> =>
	Arr.map(
		Arr.dedupeWith(promNamesOf(metric), (a, b) => a.component === b.component),
		(name) => name.promName,
	)

const isCounter = (metric: CatalogMetric) => metric.metricType === "sum" && metric.isMonotonic

/** Why the typed name missed a metric it is close to, when that is a known translation slip. */
const slipOf = (name: string, related: ReadonlyArray<CatalogMetric>): string | undefined => {
	if (Str.includes(".")(name)) return "PromQL names use underscores and the unit as a suffix"
	if (Arr.some(related, (m) => m.metricType === "histogram") && !/_(bucket|count|sum)$/.test(name))
		return "a histogram reads as _bucket, _count and _sum"
	if (Str.endsWith("_bucket")(name) && Arr.some(related, (m) => m.metricType === "exponential_histogram"))
		return "an exponential histogram has no _bucket series; use _count and _sum"
	if (Str.endsWith("_total")(name) && related.length > 0 && !Arr.some(related, isCounter))
		return "only monotonic sums end in _total"
	return undefined
}

const quoted = (names: ReadonlyArray<string>) =>
	Arr.join(
		Arr.map(names, (name) => `"${name}"`),
		", ",
	)

/** The warning for a metric name no stored metric answers to in the window. */
export const unknownMetricWarning = (name: string, catalog: ReadonlyArray<CatalogMetric>): string => {
	if (catalog.length === 0) return `no metric named "${name}": no metrics were received in the query window`
	const target = stem(normalizeMetricName(name))
	const related = Arr.filter(
		catalog,
		(metric) =>
			stem(normalizeMetricName(metric.metricName)) === target ||
			Arr.some(promNamesOf(metric), (n) => stem(n.promName) === target),
	)
	const suggestions = Arr.take(
		Arr.dedupe([
			...Arr.flatMap(related, canonicalOf),
			...nearestNames(name, canonicalPromNames(catalog)),
		]),
		SUGGESTIONS,
	)
	const slip = slipOf(name, related)
	const mean = suggestions.length === 0 ? "" : `; did you mean ${quoted(suggestions)}?`
	return `no metric named "${name}" in the query window${mean}${slip === undefined ? "" : ` (${slip})`}`
}

/** Labels Maple derives from OTel attributes, under the name a user often types instead. */
const LABEL_ALIASES = new Map([
	["service", "job"],
	["service_name", "job"],
	["service_namespace", "job"],
	["service_instance_id", "instance"],
])

/** Matchers that need a label present (they reject ""), whose label no matching series has. */
export const missingLabelMatchers = (
	matchers: ReadonlyArray<LabelMatcher>,
	present: ReadonlySet<string>,
): ReadonlyArray<LabelMatcher> =>
	Arr.filter(
		matchers,
		(matcher) => matcher.name !== "__name__" && !present.has(matcher.name) && !matchesValue(matcher, ""),
	)

/** The warning for a label matcher no sampled series of `metric` can satisfy, with the nearest label names. */
export const unknownLabelWarning = (
	metric: string,
	label: string,
	present: ReadonlyArray<string>,
): string => {
	const alias = LABEL_ALIASES.get(label)
	const names = Arr.filter(present, (name) => name !== "__name__")
	const suggestions = Arr.take(
		Arr.dedupe([
			...(alias !== undefined && names.includes(alias) ? [alias] : []),
			...nearestNames(label, names),
		]),
		SUGGESTIONS,
	)
	const mean = suggestions.length === 0 ? "" : `; did you mean ${quoted(suggestions)}?`
	return `no sampled series of "${metric}" in the query window has a label "${label}"${mean}`
}
