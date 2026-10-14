/** Output schemas for the live Google Cloud Monitoring tools (PromQL through Google's API). */
import { Schema } from "effect"
import { GcpMetricDescriptor, GcpPromQlFailure, GcpPromQlSeries } from "../http/gcp-promql"
import { GcpProjectId } from "../primitives"
import { OutputTimeRange } from "./shared"

// find_gcp_metrics

export const GcpMetricDescription = Schema.Struct({
	...GcpMetricDescriptor.fields,
	/** A query for query_gcp_promql. Absent for a value type PromQL cannot read (STRING). */
	starterQuery: Schema.optionalKey(Schema.String),
})

export const FindGcpMetricsOutput = Schema.Struct({
	/** Set when `search` was given. */
	search: Schema.optionalKey(
		Schema.Struct({
			text: Schema.String,
			/** The project whose metric list was searched. */
			projectId: GcpProjectId,
			metrics: Schema.Array(Schema.String),
			/** More names matched than `metrics` holds. */
			truncated: Schema.Boolean,
		}),
	),
	/** Set when `metric` was given. */
	metric: Schema.optionalKey(GcpMetricDescription),
})

// query_gcp_promql

export const QueryGcpPromQlOutput = Schema.Struct({
	query: Schema.String,
	kind: Schema.Literals(["timeseries", "instant"]),
	/** An instant query's evaluation time is `end`. */
	timeRange: OutputTimeRange,
	stepSeconds: Schema.optionalKey(Schema.Number),
	/** Highest last value first, at most the tool's cap. */
	series: Schema.Array(GcpPromQlSeries),
	/** Series Google returned, before the cap. */
	totalSeries: Schema.Number,
	projects: Schema.Array(GcpProjectId),
	failures: Schema.Array(GcpPromQlFailure),
})
