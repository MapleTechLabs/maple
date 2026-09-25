/** Output schemas for the dashboards MCP tools. */
import { Schema } from "effect"
import { DashboardWidgetSchema, TimeRangeSchema } from "../http/dashboards"

/** A dashboard's identity and counts, as every dashboard tool reports it. */
export const DashboardRow = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	description: Schema.optionalKey(Schema.String),
	tags: Schema.optionalKey(Schema.Array(Schema.String)),
	widgetCount: Schema.Number,
	createdAt: Schema.String,
	updatedAt: Schema.String,
})

export const InspectChartFlag = Schema.Literals([
	"EMPTY",
	"ALL_NULLS",
	"ALL_ZEROS",
	"SINGLE_POINT",
	"FLAT_LINE",
	"SUSPICIOUS_GAP",
	"NEGATIVE_VALUES",
	"UNREALISTIC_MAGNITUDE",
	"SINGLE_SERIES_DOMINATES",
	"CARDINALITY_EXPLOSION",
	"UNIT_MISMATCH",
	"PERCENT_SCALE_MISMATCH",
	"BROKEN_BREAKDOWN",
	"EMPTY_GROUPING",
	"METRIC_NOT_FOUND",
	"BUILDER_WARNINGS",
])

export const InspectChartVerdict = Schema.Literals(["looks_healthy", "suspicious", "broken"])

export const WidgetInspectionVerdict = Schema.Literals([
	"looks_healthy",
	"suspicious",
	"broken",
	"unsupported",
	"skipped",
	"error",
])

/** The window a widget was inspected over, and where it came from. */
export const InspectionTimeRange = Schema.Struct({
	startTime: Schema.String,
	endTime: Schema.String,
	source: Schema.Literals(["override", "widget", "dashboard", "fallback"]),
})

export const WidgetInspectionEntry = Schema.Struct({
	widgetId: Schema.String,
	title: Schema.optionalKey(Schema.String),
	visualization: Schema.String,
	verdict: WidgetInspectionVerdict,
	flags: Schema.Array(InspectChartFlag),
	note: Schema.optionalKey(Schema.String),
})

/** The automatic check the mutation tools run on the widgets they wrote. */
export const WidgetInspectionSummary = Schema.Struct({
	ran: Schema.Boolean,
	inspected: Schema.Array(WidgetInspectionEntry),
	healthyCount: Schema.Number,
	suspiciousCount: Schema.Number,
	brokenCount: Schema.Number,
	skippedCount: Schema.Number,
	capped: Schema.Boolean,
	timeRange: Schema.optionalKey(InspectionTimeRange),
})

const GridLayout = Schema.Struct({ x: Schema.Number, y: Schema.Number, w: Schema.Number, h: Schema.Number })

export const DescribeDashboardSchemaOutput = Schema.Struct({
	/** Absent for the index. */
	section: Schema.optionalKey(Schema.String),
	/** The generated reference, as markdown. */
	markdown: Schema.String,
})

export const ListDashboardsOutput = Schema.Struct({
	dashboards: Schema.Array(DashboardRow),
	total: Schema.Number,
	search: Schema.optionalKey(Schema.String),
})

export const GetDashboardOutput = Schema.Struct({
	/** The document in the shape `update_dashboard`'s `dashboard_json` takes back. */
	dashboard: Schema.Struct({
		id: Schema.String,
		name: Schema.String,
		description: Schema.optionalKey(Schema.String),
		tags: Schema.Array(Schema.String),
		timeRange: TimeRangeSchema,
		widgets: Schema.Array(DashboardWidgetSchema),
		createdAt: Schema.String,
		updatedAt: Schema.String,
	}),
})

export const CreateDashboardOutput = Schema.Struct({
	dashboard: DashboardRow,
	validation: Schema.optionalKey(WidgetInspectionSummary),
	/** Which of the three creation paths built it. */
	source: Schema.Literals(["template", "widgets", "dashboard_json"]),
	template: Schema.optionalKey(Schema.String),
	/** Advisory: saved anyway. */
	renderWarnings: Schema.Array(Schema.String),
})

export const UpdateDashboardOutput = Schema.Struct({
	dashboard: DashboardRow,
	/** True when `dashboard_json` replaced the whole document. */
	replaced: Schema.Boolean,
	renderWarnings: Schema.Array(Schema.String),
})

export const AddDashboardWidgetOutput = Schema.Struct({
	dashboard: DashboardRow,
	widgetId: Schema.String,
	validation: Schema.optionalKey(WidgetInspectionSummary),
	panelType: Schema.String,
	visualization: Schema.String,
	layout: Schema.optionalKey(GridLayout),
	/** Set when the widget is pinned to its own window rather than the dashboard's. */
	widgetTimeRange: Schema.optionalKey(TimeRangeSchema),
	renderWarnings: Schema.Array(Schema.String),
})

export const UpdateDashboardWidgetOutput = Schema.Struct({
	dashboard: DashboardRow,
	widgetId: Schema.String,
	validation: Schema.optionalKey(WidgetInspectionSummary),
	visualization: Schema.String,
	/** A scalar with no `transform.reduceToValue` was given the default one. */
	repairedScalar: Schema.Boolean,
	renderWarnings: Schema.Array(Schema.String),
})

export const RemoveDashboardWidgetOutput = Schema.Struct({
	dashboard: DashboardRow,
	removedWidgetId: Schema.String,
})

export const ReorderDashboardWidgetsOutput = Schema.Struct({
	dashboard: DashboardRow,
	updatedWidgetIds: Schema.Array(Schema.String),
})

export const ReplaceDashboardWidgetsOutput = Schema.Struct({
	dashboard: DashboardRow,
	widgetIds: Schema.Array(Schema.String),
	validation: Schema.optionalKey(WidgetInspectionSummary),
	/** Scalars that had no `transform.reduceToValue` and were given the default one. */
	repairedScalarIds: Schema.Array(Schema.String),
	renderWarnings: Schema.Array(Schema.String),
})

export const InspectChartSeriesStat = Schema.Struct({
	name: Schema.String,
	min: Schema.NullOr(Schema.Number),
	max: Schema.NullOr(Schema.Number),
	avg: Schema.NullOr(Schema.Number),
	validCount: Schema.Number,
	nullCount: Schema.Number,
	zeroCount: Schema.Number,
	negativeCount: Schema.Number,
	samples: Schema.Array(
		Schema.Struct({ bucket: Schema.optionalKey(Schema.String), value: Schema.NullOr(Schema.Number) }),
	),
})

export const InspectChartQueryResult = Schema.Struct({
	queryId: Schema.String,
	queryName: Schema.String,
	status: Schema.Literals(["ok", "error", "skipped"]),
	error: Schema.optionalKey(Schema.String),
	spec: Schema.optionalKey(Schema.Json),
	stats: Schema.Struct({
		rowCount: Schema.Number,
		seriesCount: Schema.Number,
		firstBucket: Schema.optionalKey(Schema.String),
		lastBucket: Schema.optionalKey(Schema.String),
		seriesStats: Schema.Array(InspectChartSeriesStat),
	}),
	reducedValue: Schema.optionalKey(Schema.NullOr(Schema.Number)),
	flags: Schema.Array(InspectChartFlag),
	builderWarnings: Schema.optionalKey(Schema.Array(Schema.String)),
})

/** A raw-SQL widget's stored SQL, run the way the dashboard runs it. */
export const InspectRawSqlResult = Schema.Struct({
	sql: Schema.String,
	/** The macro-expanded SQL actually executed; absent when expansion failed. */
	expandedSql: Schema.optionalKey(Schema.String),
	status: Schema.Literals(["ok", "error"]),
	error: Schema.optionalKey(Schema.String),
	rowCount: Schema.Number,
	columns: Schema.Array(Schema.String),
	rows: Schema.Array(Schema.Record(Schema.String, Schema.Json)),
	truncated: Schema.Boolean,
})

export const InspectChartDataOutput = Schema.Struct({
	/**
	 * `inspected`: query-builder queries run and scored. `raw_sql`: the stored SQL run (see
	 * `rawSql`). `unsupported`: a curated route source this tool cannot run (see `dataSource`).
	 */
	outcome: Schema.Literals(["inspected", "raw_sql", "unsupported"]),
	dashboardId: Schema.String,
	dashboardName: Schema.String,
	widget: Schema.Struct({
		id: Schema.String,
		title: Schema.optionalKey(Schema.String),
		visualization: Schema.String,
		endpoint: Schema.String,
		displayUnit: Schema.optionalKey(Schema.String),
		hasFormulaWarning: Schema.Boolean,
		hasUnsupportedTransform: Schema.Boolean,
	}),
	timeRange: InspectionTimeRange,
	queries: Schema.Array(InspectChartQueryResult),
	verdict: InspectChartVerdict,
	flags: Schema.Array(InspectChartFlag),
	notes: Schema.Array(Schema.String),
	rawSql: Schema.optionalKey(InspectRawSqlResult),
	/** The stored data source, for an `unsupported` widget, to rebuild with query_data. */
	dataSource: Schema.optionalKey(Schema.Json),
})
