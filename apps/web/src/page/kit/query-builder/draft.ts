import {
	QUERY_BUILDER_METRIC_TYPES,
	QUERY_BUILDER_SIGNAL_SOURCES,
	QUERY_BUILDER_SPACE_AGGREGATIONS,
	QueryBuilderAddOnsSchema,
} from "@maple/query-model"
import { Schema } from "effect"

// `QueryBuilderQueryDraft` (@maple/query-engine/query-builder) as a Schema: the query one
// `QueryPanel` edits, shared by the widget editor and the alert rule editor.

/** `QueryBuilderQueryDraftBase`: every field filled, unlike the stored draft. */
const draftFields = {
	id: Schema.String,
	name: Schema.String,
	enabled: Schema.Boolean,
	hidden: Schema.Boolean,
	whereClause: Schema.String,
	aggregation: Schema.String,
	stepInterval: Schema.String,
	orderByDirection: Schema.Literals(["desc", "asc"]),
	addOns: QueryBuilderAddOnsSchema,
	groupBy: Schema.mutable(Schema.Array(Schema.String)),
	having: Schema.String,
	orderBy: Schema.String,
	limit: Schema.String,
	legend: Schema.String,
}

export const QueryDraft = Schema.Union([
	Schema.Struct({ ...draftFields, dataSource: Schema.Literal("traces") }),
	Schema.Struct({ ...draftFields, dataSource: Schema.Literal("logs") }),
	Schema.Struct({
		...draftFields,
		dataSource: Schema.Literal("metrics"),
		signalSource: Schema.Literals(QUERY_BUILDER_SIGNAL_SOURCES),
		metricName: Schema.String,
		metricType: Schema.Literals(QUERY_BUILDER_METRIC_TYPES),
		isMonotonic: Schema.Boolean,
		/** "Aggregate across time series": absent is the aggregation's own default. */
		spaceAggregation: Schema.optional(Schema.Literals(QUERY_BUILDER_SPACE_AGGREGATIONS)),
	}),
	Schema.Struct({ ...draftFields, dataSource: Schema.Literal("product_events") }),
])
export type QueryDraft = typeof QueryDraft.Type

/** The group-by chips a query shows (never the `none` sentinel); a metrics query's are off until its breakdown is on. */
export const groupBySelectionOf = (query: QueryDraft): ReadonlyArray<string> =>
	query.dataSource === "metrics" && !query.addOns.groupBy
		? []
		: query.groupBy.filter((field) => field !== "none")
