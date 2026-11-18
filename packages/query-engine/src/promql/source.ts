// The Maple source for the PromQL evaluator: a selector request becomes one warehouse query per
// (table, component) of the stored metrics its name resolves to, and their rows become SelectorData.
// Pure: the caller runs the compiled queries.

import type { LabelMatcher, SampleBucket, SelectorData, SelectorRequest, SeriesData } from "@maple/promql"
import { Array as Arr, Order } from "effect"
import { compile } from "@maple-dev/effect-orm/clickhouse"
import type { OrgId } from "@maple/primitives"
import {
	METRIC_UNIT_SEPARATOR,
	type PromqlCatalogRow,
	type PromqlSelectorRow,
	promqlCatalogQuery,
	promqlSelectorQuery,
} from "../ch/queries/promql"
import { leCondition, matchesAll, matcherCondition, seriesLabels } from "./labels"
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
