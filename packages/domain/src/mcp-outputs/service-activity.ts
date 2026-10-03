/**
 * Rollup-backed reads of what a fleet is running and receiving: deployed versions, HTTP route
 * usage and per-signal ingest freshness.
 */
import { Schema } from "effect"
import { OutputTimeRange } from "./shared"

// service_deployments

export const DeploymentVersionRow = Schema.Struct({
	service: Schema.String,
	environment: Schema.String,
	/** `vcs.ref.head.revision` as the SDK reported it. */
	commitSha: Schema.String,
	firstSeen: Schema.String,
	/** Start of the last bucket this version served traffic in. */
	lastSeen: Schema.String,
	spanCount: Schema.Number,
	errorCount: Schema.Number,
	errorRate: Schema.Number,
	p50Ms: Schema.Number,
	p95Ms: Schema.Number,
	/** Served traffic in the newest bucket any version of this service and environment did. */
	live: Schema.Boolean,
})

export const ServiceDeploymentsOutput = Schema.Struct({
	timeRange: OutputTimeRange,
	service: Schema.optionalKey(Schema.String),
	environment: Schema.optionalKey(Schema.String),
	lastSeenPrecision: Schema.Literals(["minute", "hour"]),
	truncated: Schema.Boolean,
	versions: Schema.Array(DeploymentVersionRow),
})

// route_usage

export const RouteUsageRow = Schema.Struct({
	service: Schema.String,
	method: Schema.String,
	route: Schema.String,
	spanCount: Schema.Number,
	errorCount: Schema.Number,
	errorRate: Schema.Number,
	p95Ms: Schema.Number,
	firstSeen: Schema.String,
	lastSeen: Schema.String,
})

export const RouteUsageSort = Schema.Literals(["count", "least_recent", "most_recent"])

export const RouteUsageOutput = Schema.Struct({
	timeRange: OutputTimeRange,
	service: Schema.optionalKey(Schema.String),
	environment: Schema.optionalKey(Schema.String),
	search: Schema.optionalKey(Schema.String),
	sort: RouteUsageSort,
	truncated: Schema.Boolean,
	routes: Schema.Array(RouteUsageRow),
})

// ingest_freshness

export const IngestSignalStatus = Schema.Literals(["receiving", "delayed", "stalled", "none"])

export const IngestFreshnessRow = Schema.Struct({
	signal: Schema.Literals(["traces", "logs", "metrics"]),
	status: IngestSignalStatus,
	/** Exact newest timestamp within the probe window, when there was one. */
	lastSeen: Schema.optionalKey(Schema.String),
	/** Seconds between `lastSeen` and the end of the window. */
	lagSeconds: Schema.optionalKey(Schema.Number),
	/** Start of the newest hour with data in the whole window, from the hourly usage rollup. */
	lastHourWithData: Schema.optionalKey(Schema.String),
	/** Events (spans, log records, datapoints) received in the whole window. */
	windowCount: Schema.Number,
})

export const IngestFreshnessOutput = Schema.Struct({
	timeRange: OutputTimeRange,
	/** The trailing slice of the window read for exact timestamps. */
	probeWindow: OutputTimeRange,
	signals: Schema.Array(IngestFreshnessRow),
})
