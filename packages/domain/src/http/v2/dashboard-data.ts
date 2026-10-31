import { Schema, SchemaGetter } from "effect"
import {
	RAW_SQL_ENDPOINT,
	SORT_DIRECTIONS,
	STAT_AGGREGATES,
	DashboardQueryVariableFacet,
	DashboardRefreshIntervalSeconds,
	DashboardVariableName,
} from "@maple/widgets/dashboard"
import { HEATMAP_COLOR_SCALES, HEATMAP_SCALE_TYPES, WIDGET_VISUALIZATIONS } from "@maple/widgets"
import {
	FunnelBreakdownBy,
	FunnelKeyBy,
	FunnelPopulationFilters,
	FunnelStep,
	FunnelVariant,
	PathsAnchor,
	PathsDirection,
	PathsInclude,
	QUERY_BUILDER_METRIC_TYPES,
	QUERY_RESULT_KINDS,
	QueryBuilderFormulaSchema,
	QueryBuilderQueryDraftSchema,
	QueryComparisonSchema,
} from "@maple/query-model"
import { RawSqlText } from "../../raw-sql"
import { Timestamp } from "./timestamp"

const optional = <S extends Schema.Top>(schema: S) => Schema.optionalKey(schema)

const timeRangeSchema = Schema.Union([
	Schema.Struct({ type: Schema.Literal("relative"), value: Schema.String }),
	Schema.Struct({
		type: Schema.Literal("absolute"),
		startTime: Timestamp,
		endTime: Timestamp,
	}).pipe(Schema.encodeKeys({ startTime: "start_time", endTime: "end_time" })),
]).annotate({ identifier: "DashboardTimeRange", title: "Dashboard time range" })

// Named schema interfaces preserve inference while keeping enclosing declarations
// from repeatedly expanding every nested schema (TypeScript performance guidance).
type V2TimeRangeSchemaType = typeof timeRangeSchema
export interface V2TimeRangeSchema extends V2TimeRangeSchemaType {}
export const V2TimeRange: V2TimeRangeSchema = timeRangeSchema

const StringRecord = Schema.Record(Schema.String, Schema.String)
const UnknownRecordWire = Schema.Record(Schema.String, Schema.Unknown)
const decodeJsonValueSync = Schema.decodeUnknownSync(Schema.Json)

const isJsonArray = (value: Schema.Json): value is Schema.JsonArray => Array.isArray(value)

const mapDecodedJsonKeys = (value: Schema.Json, mapKey: (key: string) => string): Schema.Json => {
	if (isJsonArray(value)) return value.map((item) => mapDecodedJsonKeys(item, mapKey))
	if (typeof value !== "object" || value === null) return value
	return Object.fromEntries(
		Object.entries(value).map(([key, item]) => [mapKey(key), mapDecodedJsonKeys(item, mapKey)]),
	)
}

const mapJsonKeys = (value: unknown, mapKey: (key: string) => string): Schema.Json =>
	mapDecodedJsonKeys(decodeJsonValueSync(value), mapKey)

const toSnakeKey = (key: string): string =>
	key.replace(/[A-Z]/g, (character) => `_${character.toLowerCase()}`)
const toCamelKey = (key: string): string =>
	key.replace(/_([a-z])/g, (_, character: string) => character.toUpperCase())

/** Opaque widget params still obey the v2 recursive snake_case wire convention. */
const UnknownRecord = UnknownRecordWire.pipe(
	Schema.decodeTo(UnknownRecordWire, {
		decode: SchemaGetter.transform((value) => {
			const mapped = mapJsonKeys(value, toCamelKey)
			// SAFETY: UnknownRecordWire establishes an object root; recursive key mapping preserves it.
			return mapped as Record<string, unknown>
		}),
		encode: SchemaGetter.transform((value) => {
			const mapped = mapJsonKeys(value, toSnakeKey)
			// SAFETY: UnknownRecordWire establishes an object root; recursive key mapping preserves it.
			return mapped as Record<string, unknown>
		}),
	}),
)

/**
 * The same recursive snake_case convention, but decoding into a TYPED schema
 * instead of an opaque record.
 *
 * Needed by the v3 data source. A query draft used to travel inside the untyped
 * `params` bag, so its fields were snake_cased by `UnknownRecord` above and never
 * validated. v3 hoists `queries` to a real field, which leaves two bad options
 * and one good one: keep it opaque (the wire is preserved but the route cannot
 * assign it into the stored type without a second decode), type it directly (the
 * route works but every draft field silently renames on the published wire), or
 * this — snake_case on the wire, typed after decode.
 *
 * The wire bytes are therefore identical to v2 while the decoded value is the
 * real draft, which is what lets `toInternalWidgets` stay a plain field carry.
 */
const snakeCasedWire = <S extends Schema.Top>(schema: S) =>
	UnknownRecordWire.pipe(
		Schema.decodeTo(schema, {
			decode: SchemaGetter.transform((value) => {
				const mapped = mapJsonKeys(value, toCamelKey)
				// SAFETY: Every schema passed below decodes the same object after its wire keys are camel-cased.
				return mapped as S["Encoded"]
			}),
			encode: SchemaGetter.transform((value) => {
				const mapped = mapJsonKeys(value, toSnakeKey)
				// SAFETY: Every schema passed below encodes an object; recursive key mapping preserves its root.
				return mapped as Record<string, unknown>
			}),
		}),
	)

// The widget schemas below (transform, data source, display, layout, widget) are
// a deliberate re-declaration of the stored schema in
// `packages/widgets/src/dashboard/shared/`, differing only by `encodeKeys` for
// snake_case. Keeping them explicit rather than deriving them mechanically
// preserves the OpenAPI `identifier`/`title` annotations that shape the published
// v2 spec.
//
// The cost of a clone is drift, so it is guarded rather than trusted:
// `dashboard-widget-parity.test.ts` asserts the two are assignable and that every
// stored field reaches the wire under its mechanical snake_case name. Add a field
// to the stored display and that test fails until it is mirrored here.
const V2WidgetTransform = Schema.Struct({
	fieldMap: optional(StringRecord),
	hideSeries: optional(
		Schema.Struct({ baseNames: Schema.Array(Schema.String) }).pipe(
			Schema.encodeKeys({ baseNames: "base_names" }),
		),
	),
	flattenSeries: optional(
		Schema.Struct({ valueField: Schema.String }).pipe(Schema.encodeKeys({ valueField: "value_field" })),
	),
	reduceToValue: optional(
		Schema.Struct({
			field: Schema.String,
			aggregate: optional(Schema.Literals(STAT_AGGREGATES)),
		}).pipe(Schema.encodeKeys({})),
	),
	computeRatio: optional(
		Schema.Struct({
			numeratorName: Schema.String,
			denominatorNames: Schema.Array(Schema.String),
		}).pipe(
			Schema.encodeKeys({ numeratorName: "numerator_name", denominatorNames: "denominator_names" }),
		),
	),
	limit: optional(Schema.Number),
	sortBy: optional(
		Schema.Struct({
			field: Schema.String,
			direction: Schema.Literals(SORT_DIRECTIONS),
		}).pipe(Schema.encodeKeys({})),
	),
}).pipe(
	Schema.encodeKeys({
		fieldMap: "field_map",
		hideSeries: "hide_series",
		flattenSeries: "flatten_series",
		reduceToValue: "reduce_to_value",
		computeRatio: "compute_ratio",
		sortBy: "sort_by",
	}),
)

/**
 * The data source, as a discriminated union on `kind`.
 *
 * Schema v3 replaced the stored `{ endpoint, params }` bag with this union, and
 * `/v2/dashboards` republishes the new shape rather than encoding back to the old
 * one — a deliberate breaking change, taken so there is exactly one data-source
 * shape in the system instead of a wire format kept alive by a translation layer.
 *
 * Re-declared here rather than aliased to `WidgetDataSourceSchema`, for the same
 * reason as every other schema in this file: the v2 wire is snake_case
 * throughout, and the stored schema is not. Aliasing compiles and silently ships
 * `fieldMap` where the published spec says `field_map`.
 *
 * `queries`, `formulas` and `comparison` go through `snakeCasedWire`, so their
 * wire representation is byte-identical to v2 — where they lived inside the
 * untyped `params` bag and got the same recursive snake_case treatment — while
 * decoding to the real stored types. Only the envelope around them moved.
 */
const V2QueryDataSource = Schema.Struct({
	kind: Schema.Literal("query"),
	resultShape: Schema.Literals(QUERY_RESULT_KINDS),
	queries: Schema.Array(snakeCasedWire(QueryBuilderQueryDraftSchema)),
	formulas: optional(Schema.Array(snakeCasedWire(QueryBuilderFormulaSchema))),
	comparison: optional(snakeCasedWire(QueryComparisonSchema)),
	defaultLimit: optional(Schema.Number),
	limit: optional(Schema.Number),
	columns: optional(Schema.Array(Schema.String)),
	transform: optional(V2WidgetTransform),
}).pipe(Schema.encodeKeys({ resultShape: "result_shape", defaultLimit: "default_limit" }))

const V2RawSqlDataSource = Schema.Struct({
	kind: Schema.Literal("raw_sql"),
	// Validated here because this is the write boundary: nothing else on the v2
	// dashboard path checked the SQL, so a widget with a deny-listed statement or
	// a SETTINGS clause saved fine and failed when the board was opened.
	sql: RawSqlText,
	displayType: optional(Schema.String),
	granularitySeconds: optional(Schema.Number),
	transform: optional(V2WidgetTransform),
}).pipe(Schema.encodeKeys({ displayType: "display_type", granularitySeconds: "granularity_seconds" }))

// Raw SQL has one door: the `raw_sql` arm. The route arm could carry it too —
// `dataSourceRawSql` still reads `params.sql` under the pre-v3 `raw_sql_chart`
// endpoint — which meant a second, unvalidated way to store a query. Refused
// here rather than validated, because an audit of production found 193 raw-SQL
// widgets and not one using this form: nothing has ever come through it, so
// closing it breaks no client and no stored document.
//
// `endpoint` stays `Schema.String` otherwise. Closing it to a literal set would
// make a document naming a route this build does not know fail to decode, and
// `parsePayload` turns that into a hard error on the writable path — one stale
// route name would lock a whole dashboard out of editing.
const V2RouteDataSource = Schema.Struct({
	kind: Schema.Literal("route"),
	endpoint: Schema.String,
	params: optional(UnknownRecord),
	transform: optional(V2WidgetTransform),
}).check(
	// Returns the message rather than `false`: a filter's `description` is not
	// what surfaces on failure, the returned string is.
	Schema.makeFilter(
		(value) =>
			value.endpoint !== RAW_SQL_ENDPOINT ||
			`Raw SQL is not a route endpoint. Use { "kind": "raw_sql", "sql": … } instead of endpoint "${RAW_SQL_ENDPOINT}".`,
		{ description: "a route endpoint that is not raw SQL" },
	),
)

const V2StaticDataSource = Schema.Struct({
	kind: Schema.Literal("static"),
	transform: optional(V2WidgetTransform),
})

const widgetDataSourceSchema = Schema.Union([
	V2QueryDataSource,
	V2RawSqlDataSource,
	V2RouteDataSource,
	V2StaticDataSource,
]).annotate({ identifier: "DashboardWidgetDataSource", title: "Dashboard widget data source" })

type V2WidgetDataSourceSchemaType = typeof widgetDataSourceSchema
export interface V2WidgetDataSourceSchema extends V2WidgetDataSourceSchemaType {}
export const V2WidgetDataSource: V2WidgetDataSourceSchema = widgetDataSourceSchema

const V2WidgetDisplayColumn = Schema.Struct({
	field: Schema.String,
	header: Schema.String,
	unit: optional(Schema.String),
	width: optional(Schema.Number),
	align: optional(Schema.Literals(["left", "center", "right"])),
	hidden: optional(Schema.Boolean),
	thresholds: optional(Schema.Array(Schema.Struct({ value: Schema.Number, color: Schema.String }))),
})

const V2ChartPresentation = Schema.Struct({
	legend: optional(Schema.Literals(["visible", "hidden", "right"])),
	seriesStats: optional(Schema.Boolean),
	tooltip: optional(Schema.Literals(["visible", "hidden"])),
	showPoints: optional(Schema.Boolean),
	fillNulls: optional(Schema.Union([Schema.Number, Schema.Literal(false)])),
	compareToPreviousPeriod: optional(Schema.Boolean),
}).pipe(
	Schema.encodeKeys({
		seriesStats: "series_stats",
		showPoints: "show_points",
		fillNulls: "fill_nulls",
		compareToPreviousPeriod: "compare_to_previous_period",
	}),
)

const V2Axis = Schema.Struct({
	label: optional(Schema.String),
	unit: optional(Schema.String),
	visible: optional(Schema.Boolean),
})

const V2YAxis = Schema.Struct({
	...V2Axis.fields,
	min: optional(Schema.Number),
	max: optional(Schema.Number),
	softMin: optional(Schema.Number),
	softMax: optional(Schema.Number),
	logScale: optional(Schema.Boolean),
	fitYAxisToData: optional(Schema.Boolean),
}).pipe(
	Schema.encodeKeys({
		softMin: "soft_min",
		softMax: "soft_max",
		logScale: "log_scale",
		fitYAxisToData: "fit_y_axis_to_data",
	}),
)

const widgetDisplaySchema = Schema.Struct({
	title: optional(Schema.String),
	description: optional(Schema.String),
	chartId: optional(Schema.String),
	chartPresentation: optional(V2ChartPresentation),
	xAxis: optional(V2Axis),
	yAxis: optional(V2YAxis),
	seriesMapping: optional(StringRecord),
	colorOverrides: optional(StringRecord),
	stacked: optional(Schema.Boolean),
	curveType: optional(Schema.Literals(["linear", "monotone"])),
	unit: optional(Schema.String),
	thresholds: optional(
		Schema.Array(
			Schema.Struct({ value: Schema.Number, color: Schema.String, label: optional(Schema.String) }),
		),
	),
	prefix: optional(Schema.String),
	suffix: optional(Schema.String),
	sparkline: optional(
		Schema.Struct({ enabled: Schema.Boolean, dataSource: optional(V2WidgetDataSource) }).pipe(
			Schema.encodeKeys({ dataSource: "data_source" }),
		),
	),
	columns: optional(Schema.Array(V2WidgetDisplayColumn)),
	listDataSource: optional(Schema.String),
	listWhereClause: optional(Schema.String),
	listLimit: optional(Schema.Number),
	listRootOnly: optional(Schema.Boolean),
	pie: optional(
		Schema.Struct({
			donut: optional(Schema.Boolean),
			innerRadius: optional(Schema.Number),
			showLabels: optional(Schema.Boolean),
			showPercent: optional(Schema.Boolean),
		}).pipe(
			Schema.encodeKeys({
				innerRadius: "inner_radius",
				showLabels: "show_labels",
				showPercent: "show_percent",
			}),
		),
	),
	// The product-event funnel definition rides on the display block (see the
	// stored schema in `@maple/widgets`). Step objects keep their own camelCase
	// keys on the wire: they are the query-engine's `FunnelStep` contract, the
	// same shape `query_funnel` and the internal endpoint speak.
	funnel: optional(
		Schema.Struct({
			showStepPercent: optional(Schema.Boolean),
			steps: optional(Schema.Array(FunnelStep)),
			keyBy: optional(FunnelKeyBy),
			windowSeconds: optional(Schema.Number),
			breakdownBy: optional(FunnelBreakdownBy),
			filters: optional(
				Schema.Struct(FunnelPopulationFilters.fields).pipe(
					Schema.encodeKeys({
						pagePath: "page_path",
						referrerHost: "referrer_host",
						deviceType: "device_type",
						browserName: "browser_name",
						osName: "os_name",
						utmSource: "utm_source",
						utmMedium: "utm_medium",
						utmCampaign: "utm_campaign",
						visitorType: "visitor_type",
					}),
				),
			),
			variant: optional(FunnelVariant),
		}).pipe(
			Schema.encodeKeys({
				showStepPercent: "show_step_percent",
				keyBy: "key_by",
				windowSeconds: "window_seconds",
				breakdownBy: "breakdown_by",
			}),
		),
	),
	// The paths definition, same discipline as the funnel block: the anchor is
	// the query-engine's `FunnelStep` contract and keeps its own keys.
	paths: optional(
		Schema.Struct({
			anchor: PathsAnchor,
			direction: optional(PathsDirection),
			depth: optional(Schema.Number),
			branches: optional(Schema.Number),
			keyBy: optional(FunnelKeyBy),
			windowSeconds: optional(Schema.Number),
			include: optional(PathsInclude),
			exclude: optional(Schema.Array(Schema.String)),
			filters: optional(
				Schema.Struct(FunnelPopulationFilters.fields).pipe(
					Schema.encodeKeys({
						pagePath: "page_path",
						referrerHost: "referrer_host",
						deviceType: "device_type",
						browserName: "browser_name",
						osName: "os_name",
						utmSource: "utm_source",
						utmMedium: "utm_medium",
						utmCampaign: "utm_campaign",
						visitorType: "visitor_type",
					}),
				),
			),
		}).pipe(Schema.encodeKeys({ keyBy: "key_by", windowSeconds: "window_seconds" })),
	),
	histogram: optional(
		Schema.Struct({
			bucketCount: optional(Schema.Number),
			bucketWidth: optional(Schema.Number),
			logScaleY: optional(Schema.Boolean),
		}).pipe(
			Schema.encodeKeys({
				bucketCount: "bucket_count",
				bucketWidth: "bucket_width",
				logScaleY: "log_scale_y",
			}),
		),
	),
	heatmap: optional(
		Schema.Struct({
			colorScale: optional(Schema.Literals(HEATMAP_COLOR_SCALES)),
			scaleType: optional(Schema.Literals(HEATMAP_SCALE_TYPES)),
		}).pipe(Schema.encodeKeys({ colorScale: "color_scale", scaleType: "scale_type" })),
	),
	gauge: optional(
		Schema.Struct({
			min: optional(Schema.Number),
			max: optional(Schema.Number),
			style: optional(Schema.Literals(["radial", "bar"])),
		}),
	),
	markdown: optional(Schema.Struct({ content: Schema.String })),
})
	.pipe(
		Schema.encodeKeys({
			chartId: "chart_id",
			chartPresentation: "chart_presentation",
			xAxis: "x_axis",
			yAxis: "y_axis",
			seriesMapping: "series_mapping",
			colorOverrides: "color_overrides",
			curveType: "curve_type",
			listDataSource: "list_data_source",
			listWhereClause: "list_where_clause",
			listLimit: "list_limit",
			listRootOnly: "list_root_only",
		}),
	)
	.annotate({ identifier: "DashboardWidgetDisplay", title: "Dashboard widget display" })

type V2WidgetDisplaySchemaType = typeof widgetDisplaySchema
export interface V2WidgetDisplaySchema extends V2WidgetDisplaySchemaType {}
export const V2WidgetDisplay: V2WidgetDisplaySchema = widgetDisplaySchema

const widgetLayoutSchema = Schema.Struct({
	x: Schema.Number,
	y: Schema.Number,
	w: Schema.Number,
	h: Schema.Number,
	minW: optional(Schema.Number),
	minH: optional(Schema.Number),
	maxW: optional(Schema.Number),
	maxH: optional(Schema.Number),
}).pipe(Schema.encodeKeys({ minW: "min_w", minH: "min_h", maxW: "max_w", maxH: "max_h" }))

type V2WidgetLayoutSchemaType = typeof widgetLayoutSchema
export interface V2WidgetLayoutSchema extends V2WidgetLayoutSchemaType {}
export const V2WidgetLayout: V2WidgetLayoutSchema = widgetLayoutSchema

const dashboardWidgetSchema = Schema.Struct({
	id: Schema.String,
	// Closed against the widget-type table, matching the stored schema. An
	// unrecognised kind is a 400 here rather than a widget that silently renders
	// as a line chart via the renderer registry's fallback.
	visualization: Schema.Literals(WIDGET_VISUALIZATIONS),
	dataSource: V2WidgetDataSource,
	display: V2WidgetDisplay,
	layout: V2WidgetLayout,
	// Optional per-widget window. Omit it — the overwhelmingly common case — and
	// the widget follows the dashboard's `time_range`.
	timeRange: optional(V2TimeRange),
	// Section membership. Omit both — the common case — and the widget sits on
	// the root canvas. `layout` is relative to whichever container these name, so
	// two widgets in different sections may both be at `x: 0, y: 0`.
	sectionId: optional(Schema.String),
	tabId: optional(Schema.String),
}).pipe(
	Schema.encodeKeys({
		dataSource: "data_source",
		timeRange: "time_range",
		sectionId: "section_id",
		tabId: "tab_id",
	}),
)

type V2DashboardWidgetSchemaType = typeof dashboardWidgetSchema
export interface V2DashboardWidgetSchema extends V2DashboardWidgetSchemaType {}
export const V2DashboardWidget: V2DashboardWidgetSchema = dashboardWidgetSchema

const V2DashboardSectionTab = Schema.Struct({ id: Schema.String, title: Schema.String })

const dashboardSectionSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	// The stored default. Individual viewers override it in their own URL without
	// changing what anyone else sees.
	collapsed: optional(Schema.Boolean),
	// `false` pins the section open: no collapse control, and a viewer's collapse
	// override naming it is ignored. Omit for the default (collapsible).
	collapsible: optional(Schema.Boolean),
	tabs: Schema.Array(V2DashboardSectionTab),
}).annotate({
	identifier: "DashboardSection",
	title: "Dashboard section",
	description:
		"A collapsible group of widgets. A section with one tab renders as a plain header; two or more render a tab bar. Widgets join a section by setting `section_id` and `tab_id`.",
})

type V2DashboardSectionSchemaType = typeof dashboardSectionSchema
export interface V2DashboardSectionSchema extends V2DashboardSectionSchemaType {}
export const V2DashboardSection: V2DashboardSectionSchema = dashboardSectionSchema

const V2DashboardVariableSource = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("facet"), facet: DashboardQueryVariableFacet }),
	Schema.Struct({
		kind: Schema.Literal("attribute"),
		scope: Schema.Literals(["span", "resource"]),
		attributeKey: Schema.String,
	}).pipe(Schema.encodeKeys({ attributeKey: "attribute_key" })),
	Schema.Struct({
		kind: Schema.Literal("metric"),
		metricType: Schema.Literals(QUERY_BUILDER_METRIC_TYPES),
		metricNames: Schema.Array(Schema.String).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
		scope: Schema.Literals(["metric", "resource"]),
		attributeKey: Schema.String,
	}).pipe(
		Schema.encodeKeys({
			metricType: "metric_type",
			metricNames: "metric_names",
			attributeKey: "attribute_key",
		}),
	),
])

const variableBase = {
	name: DashboardVariableName,
	label: optional(Schema.String),
	includeAll: optional(Schema.Boolean),
	defaultValue: optional(Schema.String),
}

const dashboardVariableSchema = Schema.Union([
	Schema.Struct({ ...variableBase, type: Schema.Literal("query"), source: V2DashboardVariableSource }).pipe(
		Schema.encodeKeys({ includeAll: "include_all", defaultValue: "default_value" }),
	),
	Schema.Struct({
		...variableBase,
		type: Schema.Literal("custom"),
		options: Schema.Array(Schema.Struct({ value: Schema.String, label: optional(Schema.String) })),
	}).pipe(Schema.encodeKeys({ includeAll: "include_all", defaultValue: "default_value" })),
	Schema.Struct({ ...variableBase, type: Schema.Literal("textbox") }).pipe(
		Schema.encodeKeys({ includeAll: "include_all", defaultValue: "default_value" }),
	),
])

type V2DashboardVariableSchemaType = typeof dashboardVariableSchema
export interface V2DashboardVariableSchema extends V2DashboardVariableSchemaType {}
export const V2DashboardVariable: V2DashboardVariableSchema = dashboardVariableSchema

const dashboardCreateParamsSchema = Schema.Struct({
	name: Schema.String.check(Schema.isMinLength(1)),
	description: optional(Schema.NullOr(Schema.String)),
	tags: optional(Schema.Array(Schema.String)),
	timeRange: optional(V2TimeRange),
	widgets: optional(Schema.Array(V2DashboardWidget)),
	sections: optional(Schema.Array(V2DashboardSection)),
	variables: optional(Schema.Array(V2DashboardVariable)),
	refreshIntervalSeconds: optional(Schema.NullOr(DashboardRefreshIntervalSeconds)),
})
	.pipe(
		Schema.encodeKeys({
			timeRange: "time_range",
			refreshIntervalSeconds: "refresh_interval_seconds",
		}),
	)
	.annotate({
		identifier: "DashboardCreateParams",
		title: "Dashboard create parameters",
		parseOptions: { reportInput: true },
	})

type V2DashboardCreateParamsSchemaType = typeof dashboardCreateParamsSchema
export interface V2DashboardCreateParamsSchema extends V2DashboardCreateParamsSchemaType {}
export const V2DashboardCreateParams: V2DashboardCreateParamsSchema = dashboardCreateParamsSchema
export type V2DashboardCreateParams = Schema.Schema.Type<typeof V2DashboardCreateParams>
