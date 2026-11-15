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
import { Array as Arr, Order } from "effect"
import { compile } from "@maple-dev/effect-orm/clickhouse"
import type { OrgId } from "@maple/primitives"
import {
	type PromqlCatalogRow,
	type PromqlSelectorRow,
	type PromqlPushdownRow,
	promqlCatalogQuery,
	type PromqlPushdownOpts,
	promqlPushdownGroupQuery,
	promqlPushdownSeriesQuery,
	promqlSelectorQuery,
} from "../ch/queries/promql"
import { formatLe, labelValueExpr, matchesAll, matcherCondition, seriesLabels } from "./labels"
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
		readonly metricNames: ReadonlyArray<string>
	},
	options: SelectorPlanOptions,
) => {
	const labelMatchers = Arr.filter(request.matchers, (m) => m.name !== "__name__")
	return compile(
		promqlSelectorQuery({
			table: group.table,
			component: group.component,
			metricNames: group.metricNames,
			widthMs: request.widthMs,
			needsValues: request.needsValues,
			limit: options.maxSeries + 1,
			conditions: ($) => Arr.map(labelMatchers, (m) => matcherCondition($, m)),
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
		const promNames = new Map(Arr.map(group.targets, (t) => [t.metricName, t.promName] as const))
		return {
			table: group.table,
			component: group.component,
			promNames,
			compiled: compileSelector(request, { ...group, metricNames: [...promNames.keys()] }, options),
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
			increase: at(row.increase, i),
			resets: at(row.resets, i),
			changes: at(row.changes, i),
			sumT: at(row.sumT, i),
			sumTT: at(row.sumTT, i),
			sumTV: at(row.sumTV, i),
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
			if (!matchesAll(labels, request.matchers)) return []
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
		metricNames: [target.metricName],
		widthMs: request.widthMs,
		func: request.func,
		rangeMs: request.rangeMs,
		steps: request.steps,
		stepBuckets: request.steps === 1 ? 1 : request.stepMs / request.widthMs,
		rangeBuckets: request.rangeMs / request.widthMs,
		limit: options.maxSeries + 1,
		conditions: ($) => Arr.map(labelMatchers, (m) => matcherCondition($, m)),
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
			const labels: Record<string, string> = {}
			Arr.forEach(byLabels, (name, i) => {
				const value = row.groups[i] ?? ""
				if (value !== "") labels[name] = value
			})
			if (by.includes("le") && plan.component === "bucket") labels.le = formatLe(parseLe(row.le))
			if (by.includes("__name__")) labels.__name__ = plan.promName
			return { labels, steps: row.steps, values: row.values }
		}),
	}
}
