/** Output schemas for the services, metrics and query MCP tools. */
import { Schema } from "effect"
import { OutputPagination, OutputTimeRange } from "./shared"

// list_services

export const ListServicesOutput = Schema.Struct({
	timeRange: OutputTimeRange,
	total: Schema.Number,
	services: Schema.Array(
		Schema.Struct({
			name: Schema.String,
			throughput: Schema.Number,
			errorRate: Schema.Number,
			p95Ms: Schema.Number,
		}),
	),
	environment: Schema.optionalKey(Schema.String),
})

// diagnose_service

export const DiagnoseServiceTraceRow = Schema.Struct({
	traceId: Schema.String,
	rootSpanName: Schema.String,
	durationMs: Schema.Number,
	spanCount: Schema.Number,
	services: Schema.Array(Schema.String),
	hasError: Schema.Boolean,
	startTime: Schema.optionalKey(Schema.String),
	errorMessage: Schema.optionalKey(Schema.String),
	resourceAttributes: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
})

export const DiagnoseServiceLogRow = Schema.Struct({
	timestamp: Schema.String,
	severityText: Schema.String,
	serviceName: Schema.String,
	body: Schema.String,
	traceId: Schema.optionalKey(Schema.String),
	spanId: Schema.optionalKey(Schema.String),
})

export const DiagnoseServiceOutput = Schema.Struct({
	serviceName: Schema.String,
	timeRange: OutputTimeRange,
	health: Schema.Struct({
		throughput: Schema.Number,
		errorRate: Schema.Number,
		errorCount: Schema.Number,
		p50Ms: Schema.Number,
		p95Ms: Schema.Number,
		p99Ms: Schema.Number,
		apdex: Schema.Number,
	}),
	topErrors: Schema.Array(
		Schema.Struct({ fingerprintHash: Schema.String, label: Schema.String, count: Schema.Number }),
	),
	recentTraces: Schema.Array(DiagnoseServiceTraceRow),
	recentLogs: Schema.Array(DiagnoseServiceLogRow),
	environment: Schema.optionalKey(Schema.String),
})

// get_service_top_operations

export const GetServiceTopOperationsOutput = Schema.Struct({
	timeRange: OutputTimeRange,
	serviceName: Schema.String,
	metric: Schema.String,
	total: Schema.Number,
	operations: Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.Number })),
})

// service_map

export const ServiceMapEdgeRow = Schema.Struct({
	sourceService: Schema.String,
	targetService: Schema.String,
	callCount: Schema.Number,
	errorCount: Schema.Number,
	avgDurationMs: Schema.Number,
	/** Slowest call in the window, not a percentile: the edge rollup stores a max. */
	maxDurationMs: Schema.Number,
})

export const ServiceMapOutput = Schema.Struct({
	timeRange: OutputTimeRange,
	edges: Schema.Array(ServiceMapEdgeRow),
	serviceCount: Schema.Number,
	service: Schema.optionalKey(Schema.String),
	environment: Schema.optionalKey(Schema.String),
})

// list_metrics

export const ListMetricsMetricRow = Schema.Struct({
	metricName: Schema.String,
	metricType: Schema.String,
	serviceName: Schema.String,
	metricUnit: Schema.String,
	isMonotonic: Schema.Boolean,
	dataPointCount: Schema.Number,
})

export const ListMetricsOutput = Schema.Struct({
	timeRange: OutputTimeRange,
	pagination: Schema.optionalKey(OutputPagination),
	summary: Schema.Array(
		Schema.Struct({
			metricType: Schema.String,
			metricCount: Schema.Number,
			dataPointCount: Schema.Number,
		}),
	),
	metrics: Schema.Array(ListMetricsMetricRow),
	/** The filters that applied. `summary` is scoped by `service` alone. */
	filters: Schema.optionalKey(
		Schema.Struct({
			service: Schema.optionalKey(Schema.String),
			search: Schema.optionalKey(Schema.String),
			metricType: Schema.optionalKey(Schema.String),
		}),
	),
})

// explore_attributes

const CountedName = Schema.Struct({ name: Schema.String, count: Schema.Number })

export const ExploreAttributesOutput = Schema.Struct({
	source: Schema.String,
	scope: Schema.optionalKey(Schema.String),
	key: Schema.optionalKey(Schema.String),
	timeRange: OutputTimeRange,
	keys: Schema.optionalKey(Schema.Array(Schema.Struct({ key: Schema.String, count: Schema.Number }))),
	values: Schema.optionalKey(Schema.Array(Schema.Struct({ value: Schema.String, count: Schema.Number }))),
	/** source=services only: the environments and commit SHAs `keys` also lists, prefixed. */
	environments: Schema.optionalKey(Schema.Array(CountedName)),
	commitShas: Schema.optionalKey(Schema.Array(CountedName)),
	service: Schema.optionalKey(Schema.String),
})

// compare_periods

const PeriodServiceStats = Schema.Struct({
	throughput: Schema.Number,
	errorRate: Schema.Number,
	p95Ms: Schema.Number,
})
const PeriodOverallStats = Schema.Struct({
	totalSpans: Schema.Number,
	totalErrors: Schema.Number,
	errorRate: Schema.Number,
})

export const ComparePeriodsOutput = Schema.Struct({
	currentPeriod: OutputTimeRange,
	previousPeriod: OutputTimeRange,
	overall: Schema.Struct({ current: PeriodOverallStats, previous: PeriodOverallStats }),
	services: Schema.Array(
		Schema.Struct({
			name: Schema.String,
			current: PeriodServiceStats,
			previous: PeriodServiceStats,
			/** Regression flags: error_rate_up, latency_up, throughput_drop. */
			flags: Schema.optionalKey(
				Schema.Array(Schema.Literals(["error_rate_up", "latency_up", "throughput_drop"])),
			),
		}),
	),
	service: Schema.optionalKey(Schema.String),
	environment: Schema.optionalKey(Schema.String),
})

// query_data

export const QueryDataUnitSchema = Schema.Literals([
	"duration_ms",
	"duration_us",
	"duration_s",
	"duration_ns",
	"percent",
	"number",
	"bytes",
	"requests_per_sec",
])

export const QueryDataQueryContextSchema = Schema.Struct({
	source: Schema.Literals(["traces", "logs", "metrics", "product_events"]),
	serviceName: Schema.optionalKey(Schema.String),
	eventName: Schema.optionalKey(Schema.String),
	eventKind: Schema.optionalKey(Schema.String),
	host: Schema.optionalKey(Schema.String),
	pagePath: Schema.optionalKey(Schema.String),
	spanName: Schema.optionalKey(Schema.String),
	rootSpansOnly: Schema.optionalKey(Schema.Boolean),
	environments: Schema.optionalKey(Schema.Array(Schema.String)),
	commitShas: Schema.optionalKey(Schema.Array(Schema.String)),
	severity: Schema.optionalKey(Schema.String),
	metricName: Schema.optionalKey(Schema.String),
	metricType: Schema.optionalKey(Schema.String),
	attributeFilters: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({
				key: Schema.String,
				value: Schema.optionalKey(Schema.String),
				mode: Schema.String,
			}),
		),
	),
	apdexThresholdMs: Schema.optionalKey(Schema.Number),
	bucketSeconds: Schema.optionalKey(Schema.Number),
	limit: Schema.optionalKey(Schema.Number),
})

export const QueryDataOutput = Schema.Struct({
	timeRange: OutputTimeRange,
	kind: Schema.String,
	metric: Schema.String,
	groupBy: Schema.optionalKey(Schema.String),
	/** Defaults the tool applied, one line each. */
	decisions: Schema.optionalKey(Schema.Array(Schema.String)),
	queryContext: QueryDataQueryContextSchema,
	unit: QueryDataUnitSchema,
	result: Schema.Union([
		Schema.Struct({
			kind: Schema.Literal("timeseries"),
			data: Schema.Array(
				Schema.Struct({ bucket: Schema.String, series: Schema.Record(Schema.String, Schema.Number) }),
			),
		}),
		Schema.Struct({
			kind: Schema.Literal("breakdown"),
			data: Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.Number })),
		}),
	]),
})

// run_sql

export const RunSqlOutput = Schema.Struct({
	/** The fully macro-expanded SQL that was executed (org filter and time bounds inlined). */
	expandedSql: Schema.String,
	rowCount: Schema.Number,
	columns: Schema.Array(Schema.String),
	/** Returned rows, capped for the response. */
	rows: Schema.Array(Schema.Record(Schema.String, Schema.Json)),
	/** True when `rows` was cut below the full result set. */
	truncated: Schema.Boolean,
	timeRange: OutputTimeRange,
})

// describe_warehouse_tables

export const DescribeWarehouseTablesOutput = Schema.Struct({
	/** Every table, when no `table` was asked for. */
	tables: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({
				name: Schema.String,
				description: Schema.optionalKey(Schema.String),
				columnCount: Schema.Number,
			}),
		),
	),
	/** The one table asked for. */
	table: Schema.optionalKey(
		Schema.Struct({
			name: Schema.String,
			description: Schema.optionalKey(Schema.String),
			columns: Schema.Array(
				Schema.Struct({
					name: Schema.String,
					type: Schema.String,
					jsonPath: Schema.optionalKey(Schema.String),
				}),
			),
			sortingKey: Schema.optionalKey(Schema.Array(Schema.String)),
			notes: Schema.optionalKey(Schema.Array(Schema.String)),
		}),
	),
})
