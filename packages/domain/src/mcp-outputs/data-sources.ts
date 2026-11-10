import { Schema } from "effect"
import {
	CatalogEntryKind,
	CatalogField,
	DataSourceColumn,
	DataSourceEnvironment,
	DataSourceKind,
	DataSourceStatus,
	QueryLanguage,
	QueryPlanSummary,
} from "../data-sources"
import { OutputTimeRange } from "./shared"

/** One connected source as every data source tool names it. */
export const DataSourceSummary = Schema.Struct({
	name: Schema.String,
	kind: DataSourceKind,
	queryLanguage: QueryLanguage,
	environment: DataSourceEnvironment,
	description: Schema.String,
	status: DataSourceStatus,
	/** Tables or resources an agent may see. */
	entryCount: Schema.Number,
	/** The source had more tables or resources than Maple keeps; the rest are not searchable. */
	catalogTruncated: Schema.Boolean,
	lastError: Schema.NullOr(Schema.String),
})

export const ListDataSourcesOutput = Schema.Struct({
	sources: Schema.Array(DataSourceSummary),
	/** Every agent-visible source, across pages. */
	total: Schema.Number,
	offset: Schema.Number,
})

export const SearchDataSourcesOutput = Schema.Struct({
	query: Schema.String,
	/** Visible sources whose catalog failed, was never captured or was cut at the cap: search cannot vouch for them. */
	incompleteSources: Schema.optionalKey(Schema.Array(Schema.String)),
	hits: Schema.Array(
		Schema.Struct({
			source: Schema.String,
			entry: Schema.String,
			environment: DataSourceEnvironment,
			queryLanguage: QueryLanguage,
			matchedFields: Schema.Array(Schema.String),
			reason: Schema.String,
			score: Schema.Number,
		}),
	),
})

/** An entry as the overview lists it, without fields. */
export const DataSourceEntryOverview = Schema.Struct({
	name: Schema.String,
	kind: CatalogEntryKind,
	rowEstimate: Schema.optionalKey(Schema.Number),
	timeField: Schema.optionalKey(Schema.String),
	note: Schema.optionalKey(Schema.String),
	fieldCount: Schema.Number,
})

export const DescribedDataSourceEntry = Schema.Struct({
	name: Schema.String,
	kind: CatalogEntryKind,
	rowEstimate: Schema.optionalKey(Schema.Number),
	timeField: Schema.optionalKey(Schema.String),
	note: Schema.optionalKey(Schema.String),
	fields: Schema.Array(CatalogField),
})

export const DescribeDataSourceOutput = Schema.Struct({
	source: DataSourceSummary,
	/** The overview page, when no entries were asked for. */
	entries: Schema.optionalKey(Schema.Array(DataSourceEntryOverview)),
	/** Exposed entries in the source, across pages. */
	totalEntries: Schema.Number,
	offset: Schema.Number,
	/** The entries asked for by name, with their fields. */
	described: Schema.optionalKey(Schema.Array(DescribedDataSourceEntry)),
	/** Saved example queries, as the source takes them (SQL text or resource JSON). */
	examples: Schema.Array(Schema.Struct({ title: Schema.String, query: Schema.String })),
	/** How to write a query for this source's language; present with `described`. */
	cheatSheet: Schema.optionalKey(Schema.Array(Schema.String)),
	/** A runnable query over the described entries, in the source's language. */
	exampleQuery: Schema.optionalKey(Schema.String),
})

export const QueryDataSourceOutput = Schema.Struct({
	source: Schema.String,
	kind: DataSourceKind,
	queryLanguage: QueryLanguage,
	environment: DataSourceEnvironment,
	plan: QueryPlanSummary,
	/** False for `explain`, which plans without running. */
	executed: Schema.Boolean,
	timeRange: OutputTimeRange,
	/** False when the SQL uses no window macro, so `timeRange` did not filter anything. */
	windowApplied: Schema.optionalKey(Schema.Boolean),
	/** Set when the call chose a bucket size; otherwise the source picked one from the window. */
	granularitySeconds: Schema.optionalKey(Schema.Number),
	columns: Schema.Array(DataSourceColumn),
	/** Returned rows, capped for the response. */
	rows: Schema.Array(Schema.Record(Schema.String, Schema.Json)),
	rowCount: Schema.Number,
	/** The source's own row cap cut the result. */
	sourceTruncated: Schema.Boolean,
	/** `rows` shows fewer than `rowCount`. */
	truncated: Schema.Boolean,
})
