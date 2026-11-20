// The Maple source for the PromQL evaluator: a selector request becomes one warehouse query per
// (table, component) of the stored metrics its name resolves to, and their rows become SelectorData.
// Pure: the caller runs the compiled queries.

import type {
	LabelMatcher,
	PushdownData,
	PushdownRequest,
	SampleBucket,
	SelectorData,
	SelectorRequest,
	SeriesData,
} from "@maple/promql"
import { Array as Arr, Order, Record as Rec } from "effect"
import { compile } from "@maple-dev/effect-orm/clickhouse"
import type { OrgId } from "@maple/primitives"
import {
	METRIC_UNIT_SEPARATOR,
	type PromqlCatalogRow,
	type PromqlSelectorRow,
	type PromqlSeriesLabelsRow,
	type PromqlStoredMetric,
	type PromqlStoredMetrics,
	type PromqlPushdownRow,
	promqlCatalogQuery,
	type PromqlPushdownOpts,
	promqlPushdownGroupQuery,
	promqlPushdownSeriesQuery,
	promqlSelectorQuery,
	promqlSeriesLabelsQuery,
} from "../ch/queries/promql"
import {
	attributeLeCondition,
	formatLe,
	labelValueExpr,
	leCondition,
	matcherCondition,
	seriesLabels,
	seriesMatchesAll,
} from "./labels"
import {
	type CatalogMetric,
	type MetricComponent,
	type MetricTable,
	type OtelMetricType,
	type PromNameTarget,
	resolveSelectorName,
} from "./names"

export interface SelectorPlanOptions {
	readonly orgId: OrgId
	/** The evaluator's series cap; each query returns at most one more so overflow shows. */
	readonly maxSeries: number
}

export interface SelectorPlan {
	readonly table: MetricTable
	readonly component: MetricComponent
	/** Stored name to the Prometheus name its series carry. */
	readonly promNames: ReadonlyMap<string, string>
	readonly compiled: ReturnType<typeof compileSelector>
}

const compileSelector = (
	request: SelectorRequest,
	group: {
		readonly table: MetricTable
		readonly component: MetricComponent
		readonly targets: ReadonlyArray<PromNameTarget>
	},
	options: SelectorPlanOptions,
) => {
	const labelMatchers = Arr.filter(request.matchers, (m) => m.name !== "__name__")
	return compile(
		promqlSelectorQuery({
			table: group.table,
			component: group.component,
			targets: group.targets,
			widthMs: request.widthMs,
			needsValues: request.needsValues,
			accumulateDeltas: request.accumulateDeltas === true,
			limit: options.maxSeries + 1,
			conditions: ($) => Arr.map(labelMatchers, (m) => matcherCondition($, m)),
			boundConditions: (le) =>
				Arr.map(
					Arr.filter(labelMatchers, (m) => m.name === "le"),
					(m) => leCondition(le, m),
				),
		}),
		{
			orgId: options.orgId,
			startMs: request.startMs,
			endMs: request.endMs,
			originMs: request.originMs,
			timeOriginMs: request.startMs,
		},
	)
}

/** The identity a selector row reports for a target: its stored name and unit. */
const targetKey = (target: Pick<PromNameTarget, "metricName" | "unit">): string =>
	`${target.metricName}${METRIC_UNIT_SEPARATOR}${target.unit}`

const nameMatchersOf = (request: SelectorRequest): ReadonlyArray<LabelMatcher> =>
	Arr.filter(request.matchers, (m) => m.name === "__name__")

/** The targets of a request, grouped by the table and component one query reads. */
export const groupTargets = (
	targets: ReadonlyArray<PromNameTarget>,
): ReadonlyArray<{
	readonly table: MetricTable
	readonly component: MetricComponent
	readonly targets: ReadonlyArray<PromNameTarget>
}> => {
	const groups = new Map<
		string,
		{ table: MetricTable; component: MetricComponent; targets: PromNameTarget[] }
	>()
	for (const target of targets) {
		const key = `${target.table}/${target.component}`
		const group = groups.get(key)
		if (group === undefined)
			groups.set(key, { table: target.table, component: target.component, targets: [target] })
		else group.targets.push(target)
	}
	return [...groups.values()]
}

/** One compiled query per (table, component) the selector's name resolves to; none when nothing matches. */
export const buildSelectorQueries = (
	request: SelectorRequest,
	catalog: ReadonlyArray<CatalogMetric>,
	options: SelectorPlanOptions,
): ReadonlyArray<SelectorPlan> =>
	Arr.map(groupTargets(resolveSelectorName(nameMatchersOf(request), catalog)), (group) => {
		const promNames = new Map(Arr.map(group.targets, (t) => [targetKey(t), t.promName] as const))
		return {
			table: group.table,
			component: group.component,
			promNames,
			compiled: compileSelector(request, group, options),
		}
	})

/** ClickHouse prints the bucket bound with `toString`: `inf` for +Inf. */
export const parseLe = (text: string): number => {
	if (text === "inf" || text === "+inf") return Infinity
	if (text === "-inf") return -Infinity
	return Number(text)
}

const bucketsOf = (row: PromqlSelectorRow, needsValues: boolean): ReadonlyArray<SampleBucket> => {
	const at = (values: ReadonlyArray<number>, i: number) => values[i] ?? 0
	const buckets = Arr.map(row.end, (end, i): SampleBucket => {
		const bucket: SampleBucket = {
			end,
			firstT: at(row.firstT, i),
			firstV: at(row.firstV, i),
			lastT: at(row.lastT, i),
			lastV: at(row.lastV, i),
			prevT: at(row.prevT, i),
			prevV: at(row.prevV, i),
			count: at(row.count, i),
			sum: at(row.sum, i),
			min: at(row.min, i),
			max: at(row.max, i),
			sumSquares: at(row.sumSquares, i),
			resetSum: at(row.resetSum, i),
			resets: at(row.resets, i),
			changes: at(row.changes, i),
			sumT: at(row.sumT, i),
			sumTT: at(row.sumTT, i),
			sumTV: at(row.sumTV, i),
			staleT: at(row.staleT, i),
		}
		return needsValues ? { ...bucket, values: row.values[i] ?? [] } : bucket
	})
	return Arr.sort(
		buckets,
		Order.mapInput(Order.Number, (b: SampleBucket) => b.end),
	)
}

/**
 * The rows of every plan as the evaluator's SelectorData. Labels are recomputed and every matcher
 * re-checked here; series whose label sets collide are all returned (the evaluator reports them).
 */
export const toSelectorData = (
	request: SelectorRequest,
	results: ReadonlyArray<{ readonly plan: SelectorPlan; readonly rows: ReadonlyArray<PromqlSelectorRow> }>,
): SelectorData => ({
	timeOriginMs: request.startMs,
	series: Arr.flatMap(results, ({ plan, rows }) =>
		Arr.flatMap(rows, (row): ReadonlyArray<SeriesData> => {
			const promName = plan.promNames.get(row.metricName)
			if (promName === undefined) return []
			const labels = seriesLabels({
				promName,
				serviceName: row.serviceName,
				attributes: row.attributes,
				resourceAttributes: row.resourceAttributes,
				le: plan.component === "bucket" ? parseLe(row.le) : undefined,
			})
			if (!seriesMatchesAll(row, labels, request.matchers)) return []
			const buckets = bucketsOf(row, request.needsValues)
			return buckets.length === 0 ? [] : [{ labels, buckets }]
		}),
	),
})

const METRIC_TYPES: ReadonlySet<string> = new Set<OtelMetricType>([
	"sum",
	"gauge",
	"histogram",
	"exponential_histogram",
])

const isMetricType = (value: string): value is OtelMetricType => METRIC_TYPES.has(value)

/** The catalog query over `[startTime, endTime]`; feed its rows to `catalogFromRows`. */
export const catalogQuery = (limit = 50_000) => promqlCatalogQuery({ limit })

export const catalogFromRows = (rows: ReadonlyArray<PromqlCatalogRow>): ReadonlyArray<CatalogMetric> =>
	Arr.flatMap(rows, (row) =>
		isMetricType(row.metricType)
			? [
					{
						metricName: row.metricName,
						metricType: row.metricType,
						isMonotonic: row.isMonotonic > 0,
						unit: row.unit,
					},
				]
			: [],
	)

export interface PushdownPlan {
	readonly promName: string
	readonly component: MetricComponent
	readonly compiled: ReturnType<typeof compilePushdown>
}

const compilePushdown = (
	request: PushdownRequest,
	target: PromNameTarget,
	labelMatchers: ReadonlyArray<LabelMatcher>,
	byLabels: ReadonlyArray<string>,
	options: SelectorPlanOptions,
) => {
	const originMs = request.startMs - request.offsetMs
	const lastEnd = originMs + (request.steps - 1) * request.stepMs
	const params = {
		orgId: options.orgId,
		startMs: originMs - request.rangeMs,
		endMs: lastEnd,
		originMs,
		timeOriginMs: originMs,
	}
	const opts: PromqlPushdownOpts = {
		table: target.table,
		component: target.component,
		targets: [target],
		widthMs: request.widthMs,
		func: request.func,
		rangeMs: request.rangeMs,
		steps: request.steps,
		stepBuckets: request.steps === 1 ? 1 : request.stepMs / request.widthMs,
		rangeBuckets: request.rangeMs / request.widthMs,
		limit: options.maxSeries + 1,
		conditions: ($) => Arr.map(labelMatchers, (m) => matcherCondition($, m)),
		boundConditions: (le) =>
			Arr.map(
				Arr.filter(labelMatchers, (m) => m.name === "le"),
				(m) => leCondition(le, m),
			),
	}
	const aggregation = request.aggregation
	if (aggregation === undefined) return compile(promqlPushdownSeriesQuery(opts), params)
	return compile(
		promqlPushdownGroupQuery(opts, {
			op: aggregation.op,
			labels: ($) =>
				Arr.flatMap(byLabels, (name) => {
					const expr = labelValueExpr($, name)
					return expr === undefined ? [] : [expr]
				}),
			byLe: aggregation.by.includes("le"),
		}),
		params,
	)
}

/**
 * The warehouse query for a pushdown, or undefined when it cannot be exact: the selector must
 * resolve to one stored metric, and every label matcher must run in SQL (an `le` matcher is
 * only checked after the fetch). The evaluator then reads the selector instead.
 */
export const buildPushdownQuery = (
	request: PushdownRequest,
	catalog: ReadonlyArray<CatalogMetric>,
	options: SelectorPlanOptions,
): PushdownPlan | undefined => {
	const targets = resolveSelectorName(
		Arr.filter(request.matchers, (m) => m.name === "__name__"),
		catalog,
	)
	const target = targets[0]
	if (targets.length !== 1 || target === undefined) return undefined
	const labelMatchers = Arr.filter(request.matchers, (m) => m.name !== "__name__")
	if (Arr.some(labelMatchers, (m) => m.name === "le")) return undefined
	// Grouping reads `le` from the bucket bound; an `le` attribute on other data is not supported.
	if (request.aggregation?.by.includes("le") === true && target.component !== "bucket") return undefined
	if (request.widthMs <= 0 || request.rangeMs % request.widthMs !== 0) return undefined
	if (request.steps > 1 && request.stepMs % request.widthMs !== 0) return undefined
	const byLabels = Arr.filter(request.aggregation?.by ?? [], (name) => name !== "le" && name !== "__name__")
	return {
		promName: target.promName,
		component: target.component,
		compiled: compilePushdown(request, target, labelMatchers, byLabels, options),
	}
}

/** The pushdown's rows as the evaluator reads them. */
export const toPushdownData = (
	request: PushdownRequest,
	plan: PushdownPlan,
	rows: ReadonlyArray<PromqlPushdownRow>,
): PushdownData => {
	const by = request.aggregation?.by
	const byLabels = Arr.filter(by ?? [], (name) => name !== "le" && name !== "__name__")
	return {
		series: Arr.map(rows, (row) => {
			if (by === undefined) {
				const labels = seriesLabels({
					promName: plan.promName,
					serviceName: row.serviceName,
					attributes: row.attributes,
					resourceAttributes: row.resourceAttributes,
					le: plan.component === "bucket" ? parseLe(row.le) : undefined,
				})
				return { labels, steps: row.steps, values: row.values }
			}
			const entries: Array<readonly [string, string]> = Arr.map(byLabels, (name, i) => [
				name,
				row.groups[i] ?? "",
			])
			if (by.includes("le") && plan.component === "bucket")
				entries.push(["le", formatLe(parseLe(row.le))])
			// Every pushed function but last_over_time drops the name before aggregating.
			if (by.includes("__name__") && (request.func === "last" || request.func === "last_over_time")) {
				entries.push(["__name__", plan.promName])
			}
			// fromEntries defines own properties, so `by (__proto__)` stays a label.
			const labels = Rec.fromEntries(Arr.filter(entries, ([, value]) => value !== ""))
			return { labels, steps: row.steps, values: row.values }
		}),
	}
}

export interface SeriesLabelsPlan {
	readonly table: MetricTable
	/** Stored identity (name and unit) to the targets its rows become. */
	readonly targets: ReadonlyMap<string, ReadonlyArray<PromNameTarget>>
	readonly compiled: ReturnType<typeof compileSeriesLabels>
}

export interface SeriesLabelsOptions {
	readonly orgId: OrgId
	/** Rows one table read returns at most. */
	readonly limit: number
	/** Stored metrics one read filters on; more are split over several reads. */
	readonly maxNameFilter: number
	/** Reads per table at most; metrics past them (in name order) are left out, like rows past the limit. */
	readonly maxNameReads: number
}

const storedMetrics = (targets: ReadonlyArray<PromNameTarget>): ReadonlyArray<PromqlStoredMetric> =>
	Arr.dedupeWith(
		Arr.map(targets, (t) => ({ metricName: t.metricName, unit: t.unit })),
		(a, b) => targetKey(a) === targetKey(b),
	)

/** Every stored metric when the read is unfiltered, else the listed ones; `undefined` for none. */
const metricsOf = (targets: ReadonlyArray<PromNameTarget>, all: boolean): PromqlStoredMetrics | undefined => {
	if (targets.length === 0) return undefined
	return all ? "all" : storedMetrics(targets)
}

const compileSeriesLabels = (
	table: MetricTable,
	targets: ReadonlyArray<PromNameTarget>,
	all: boolean,
	matchers: ReadonlyArray<LabelMatcher>,
	window: { readonly startMs: number; readonly endMs: number },
	options: SeriesLabelsOptions,
) => {
	const labelMatchers = Arr.filter(matchers, (m) => m.name !== "__name__")
	const leMatchers = Arr.filter(labelMatchers, (m) => m.name === "le")
	const buckets = Arr.filter(targets, (t) => t.component === "bucket")
	const others = Arr.filter(targets, (t) => t.component !== "bucket")
	return compile(
		promqlSeriesLabelsQuery({
			table,
			metrics: all ? "all" : storedMetrics(targets),
			conditions: ($) => Arr.map(labelMatchers, (m) => matcherCondition($, m)),
			le:
				leMatchers.length === 0
					? undefined
					: {
							buckets: metricsOf(buckets, all),
							others: metricsOf(others, all),
							boundConditions: (le) => Arr.map(leMatchers, (m) => leCondition(le, m)),
							otherConditions: ($) => Arr.map(leMatchers, (m) => attributeLeCondition($, m)),
						},
			limit: options.limit,
		}),
		{ orgId: options.orgId, startMs: window.startMs, endMs: window.endMs },
	)
}

const byTargetKey = (
	targets: ReadonlyArray<PromNameTarget>,
): ReadonlyMap<string, ReadonlyArray<PromNameTarget>> => {
	const byKey = new Map<string, Array<PromNameTarget>>()
	for (const target of targets) {
		const key = targetKey(target)
		byKey.set(key, [...(byKey.get(key) ?? []), target])
	}
	return byKey
}

/**
 * Series discovery for one selector: per table, one unfiltered read when it keeps every metric, else
 * up to `maxNameReads` reads of `maxNameFilter` (name, unit) pairs. All but a regex on a bucket's
 * `le` run in SQL, and every matcher is checked again on the rows (`toSeriesLabels`).
 */
export const buildSeriesLabelsQueries = (
	matchers: ReadonlyArray<LabelMatcher>,
	window: { readonly startMs: number; readonly endMs: number },
	catalog: ReadonlyArray<CatalogMetric>,
	options: SeriesLabelsOptions,
): ReadonlyArray<SeriesLabelsPlan> => {
	const resolved = resolveSelectorName(
		Arr.filter(matchers, (m) => m.name === "__name__"),
		catalog,
	)
	// Each stored metric and component resolves at most once, so equal counts mean every one.
	const everything = resolveSelectorName([], catalog)
	const tables = Arr.dedupe(Arr.map(resolved, (target) => target.table))
	return Arr.flatMap(tables, (table): ReadonlyArray<SeriesLabelsPlan> => {
		const targets = Arr.filter(resolved, (target) => target.table === table)
		const all = targets.length === Arr.filter(everything, (target) => target.table === table).length
		if (all) {
			return [
				{
					table,
					targets: byTargetKey(targets),
					compiled: compileSeriesLabels(table, targets, true, matchers, window, options),
				},
			]
		}
		const keys = Arr.sort(Arr.dedupe(Arr.map(targets, targetKey)), Order.String)
		const batches = Arr.take(Arr.chunksOf(keys, Math.max(1, options.maxNameFilter)), options.maxNameReads)
		return Arr.map(batches, (batch) => {
			const inBatch = new Set(batch)
			const batchTargets = Arr.filter(targets, (t) => inBatch.has(targetKey(t)))
			return {
				table,
				targets: byTargetKey(batchTargets),
				compiled: compileSeriesLabels(table, batchTargets, false, matchers, window, options),
			}
		})
	})
}

/** The label sets of a selector's discovery rows: every target of each row, one per bucket bound. */
export const toSeriesLabels = (
	matchers: ReadonlyArray<LabelMatcher>,
	results: ReadonlyArray<{
		readonly plan: SeriesLabelsPlan
		readonly rows: ReadonlyArray<PromqlSeriesLabelsRow>
	}>,
): ReadonlyArray<Readonly<Record<string, string>>> =>
	Arr.flatMap(results, ({ plan, rows }) =>
		Arr.flatMap(rows, (row) =>
			Arr.flatMap(plan.targets.get(row.metricName) ?? [], (target) => {
				const bounds: ReadonlyArray<number | undefined> =
					target.component === "bucket" ? Arr.map(row.bounds, parseLe) : [undefined]
				return Arr.filter(
					Arr.map(bounds, (le) =>
						seriesLabels({
							promName: target.promName,
							serviceName: row.serviceName,
							attributes: row.attributes,
							resourceAttributes: row.resourceAttributes,
							le,
						}),
					),
					(labels) => seriesMatchesAll(row, labels, matchers),
				)
			}),
		),
	)
