import { rawSqlIssue } from "@maple/domain/raw-sql"
import { rawSqlDisplayTypeFor, widgetTypeByVisualization } from "@maple/domain/http"
import type { RawSqlDisplayType, WidgetDataSourceSchema } from "@maple/domain/http"
import {
	dataSourcePromql,
	dataSourceQuerySet,
	dataSourceTransform,
	makeRawSqlDataSource,
} from "@maple/widgets/dashboard"

// MCP-side mirror of the web's raw-SQL widget builder so agents can create
// raw-SQL widgets without hand-crafting the dataSource JSON. The display type
// comes from the shared `rawSqlDisplayTypeFor`; `buildRawSqlDataSource` mirrors
// its twin in apps/web/src/page/dashboards/widget/raw-sql.ts.

type WidgetDataSource = typeof WidgetDataSourceSchema.Type

export { rawSqlDisplayTypeFor as visualizationToDisplayType }

export function buildRawSqlDataSource(args: {
	visualization: string
	sql: string
	displayType: RawSqlDisplayType
	granularitySeconds?: number
}): WidgetDataSource {
	return makeRawSqlDataSource({
		sql: args.sql,
		displayType: args.displayType,
		...(!(args.granularitySeconds == null) ? { granularitySeconds: args.granularitySeconds } : undefined),
		// A scalar widget needs a reduceToValue transform so the tile reads
		// `data[0].value`. Mirrors buildRawSqlDataSource in the web app.
		...(widgetTypeByVisualization(args.visualization)?.isScalar === true
			? {
					transform: { reduceToValue: { field: "value", aggregate: "first" } },
				}
			: undefined),
	})
}

/**
 * Give a scalar panel the `reduceToValue` transform it needs, if it has none.
 *
 * A stat or gauge reads `data[0].value`; handed a query result it renders
 * `[object Object]`. The raw-SQL path has always injected this (above); the
 * structured-query path never did, so every MCP-authored stat and gauge built
 * from a query set was broken unless the caller happened to know about a
 * transform no tool description mentioned.
 *
 * `first` matches the raw-SQL injection: it reads the leading row rather than
 * aggregating across buckets, which is what a "current value" tile means. A
 * caller that wants a sum over the window sets `reduceToValue` explicitly, and
 * this leaves it alone.
 */
export function withScalarReduction(dataSource: WidgetDataSource, isScalar: boolean): WidgetDataSource {
	if (!isScalar) return dataSource
	// A PromQL scalar needs its rows newest first, which only a stat or gauge display type gives;
	// any other (absent, or a line chart's) is oldest first, and `first` would read the oldest.
	if (
		"kind" in dataSource &&
		dataSource.kind === "promql" &&
		dataSource.displayType !== "stat" &&
		dataSource.displayType !== "gauge"
	) {
		return withScalarReduction({ ...dataSource, displayType: "stat" }, isScalar)
	}
	if (dataSourceTransform(dataSource)?.reduceToValue !== undefined) return dataSource
	const querySet = dataSourceQuerySet(dataSource)
	// Only the query and PromQL arms: a route source owns its own response shape, and a
	// static source has no response at all.
	if (querySet === null && dataSourcePromql(dataSource) === null) return dataSource

	const existing = dataSourceTransform(dataSource)
	return {
		...dataSource,
		transform: { ...existing, reduceToValue: { field: "value", aggregate: "first" } },
	}
}

/**
 * Static raw-SQL validation for the widget tools, through the shared `rawSqlIssue`, so
 * deny-listed, SETTINGS or multi-statement SQL fails on save, not when the dashboard opens.
 */
export function validateRawSql(sql: string): string | null {
	const issue = rawSqlIssue(sql, { workload: "dashboard" })
	if (issue === null) return null
	return issue.code === "MissingOrgFilter"
		? `${issue.message} Add \`WHERE $__orgFilter\` (or \`AND $__orgFilter\`) to the query.`
		: issue.message
}
