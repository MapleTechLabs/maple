import {
	type QueryBuilderDataSource,
	type QueryBuilderQueryDraft,
	resetAggregationForMetricType,
	resetQueryForDataSource,
} from "@maple/query-engine/query-builder"
import {
	QUERY_BUILDER_DATA_SOURCES,
	QUERY_BUILDER_METRIC_TYPES,
	QUERY_BUILDER_SPACE_AGGREGATIONS,
} from "@maple/query-model"
import { Schema, String as Str } from "effect"
import { defineMessageUnion } from "foldkit/message"
import type { QueryDraft } from "./draft"

// One edit a `QueryPanel` makes to its draft (its `onUpdate`, `onAggregationChange` and
// `onDataSourceChange` callbacks), as data the host applies.

/** A query's free-text fields under the add-on toggles. */
export const QueryTextField = Schema.Literals([
	"whereClause",
	"stepInterval",
	"having",
	"orderBy",
	"limit",
	"legend",
])
export type QueryTextField = typeof QueryTextField.Type

export const AddOnKey = Schema.Literals(["groupBy", "having", "orderBy", "limit", "legend"])
export type AddOnKey = typeof AddOnKey.Type

export const QueryChange = defineMessageUnion({
	SetSource: { source: Schema.Literals(QUERY_BUILDER_DATA_SOURCES) },
	SetRootOnly: { isRootOnly: Schema.Boolean },
	SetAggregation: { aggregation: Schema.String },
	SetOrderDirection: { direction: Schema.Literals(["desc", "asc"]) },
	SetText: { field: QueryTextField, value: Schema.String },
	ToggledAddOn: { key: AddOnKey },
	ToggledHidden: {},
	SetGroupBy: { groupBy: Schema.Array(Schema.String) },
	/** `onMetricSelectionChange`: a picked metric, its aggregation reset to one its type has. */
	SetMetric: {
		metricName: Schema.String,
		metricType: Schema.Literals(QUERY_BUILDER_METRIC_TYPES),
		isMonotonic: Schema.Boolean,
	},
	/** `MetricsBody`'s "Aggregate across time series" select. */
	SetSpaceAggregation: { aggregation: Schema.Literals(QUERY_BUILDER_SPACE_AGGREGATIONS) },
})
export type QueryChange = typeof QueryChange.Type

const ROOT_ONLY = /\s*AND\s*root_only\s*=\s*\w+/gi
const ROOT_ONLY_LEADING = /root_only\s*=\s*\w+\s*AND\s*/gi
const ROOT_ONLY_ALONE = /root_only\s*=\s*\w+/gi

/** The All / Root Spans select: rewrites `root_only = true` in the where clause. */
export const withRootOnly = (whereClause: string, isRootOnly: boolean): string => {
	const stripped = Str.trim(
		Str.replace(
			ROOT_ONLY_ALONE,
			"",
		)(Str.replace(ROOT_ONLY_LEADING, "")(Str.replace(ROOT_ONLY, "")(whereClause))),
	)
	if (!isRootOnly) return stripped
	return stripped === "" ? "root_only = true" : `${stripped} AND root_only = true`
}

/** A draft moved to another source; `root_only` is a traces filter, so other sources drop it. */
export const switchDataSource = (
	query: QueryBuilderQueryDraft,
	source: QueryBuilderDataSource,
): QueryBuilderQueryDraft => {
	const reset = resetQueryForDataSource(query, source)
	return source === "traces" ? reset : { ...reset, whereClause: withRootOnly(reset.whereClause, false) }
}

/** The change applied to one draft, as `QueryPanel`'s callbacks do. */
export const applyQueryChange = (query: QueryDraft, change: QueryChange): QueryDraft =>
	QueryChange.match<QueryDraft>(change, {
		SetSource: ({ source }) => switchDataSource(query, source),
		SetRootOnly: ({ isRootOnly }) => ({
			...query,
			whereClause: withRootOnly(query.whereClause, isRootOnly),
		}),
		SetAggregation: ({ aggregation }) => ({ ...query, aggregation }),
		SetOrderDirection: ({ direction }) => ({ ...query, orderByDirection: direction }),
		SetText: ({ field, value }) => ({ ...query, [field]: value }),
		ToggledAddOn: ({ key }) => ({ ...query, addOns: { ...query.addOns, [key]: !query.addOns[key] } }),
		ToggledHidden: () => ({ ...query, hidden: !query.hidden }),
		// A metrics query has no Group-by add-on toggle: picking a field is turning it on.
		SetGroupBy: ({ groupBy }) =>
			query.dataSource === "metrics"
				? {
						...query,
						groupBy: [...groupBy],
						addOns: { ...query.addOns, groupBy: groupBy.length > 0 },
					}
				: { ...query, groupBy: [...groupBy] },
		SetMetric: ({ metricName, metricType, isMonotonic }) =>
			query.dataSource !== "metrics"
				? query
				: {
						...query,
						metricName,
						metricType,
						isMonotonic,
						aggregation: resetAggregationForMetricType(
							query.aggregation,
							metricType,
							isMonotonic,
						),
					},
		SetSpaceAggregation: ({ aggregation }) =>
			query.dataSource === "metrics" ? { ...query, spaceAggregation: aggregation } : query,
	})
