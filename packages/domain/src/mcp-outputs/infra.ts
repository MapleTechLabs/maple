/** Output schemas for the infrastructure MCP tools (hosts, Kubernetes, containers, connected providers). */
import { Schema } from "effect"
import { OutputTimeRange } from "./shared"

export const InfraKind = Schema.Literals([
	"hosts",
	"pods",
	"nodes",
	"workloads",
	"containers",
	"cloudflare_zones",
	"cloudflare_workers",
	"railway_services",
	"planetscale_databases",
])
export type InfraKind = typeof InfraKind.Type

export const InfraEntityKind = Schema.Literals([
	"host",
	"pod",
	"node",
	"workload",
	"container",
	"cloudflare_zone",
	"cloudflare_worker",
	"railway_service",
	"planetscale_database",
])
export type InfraEntityKind = typeof InfraEntityKind.Type

/**
 * One infrastructure entity, flattened across kinds. Utilization fields are 0..1 fractions;
 * a field is absent when the kind does not report it, never zero-filled.
 */
export const InfraEntityRow = Schema.Struct({
	name: Schema.String,
	/** Absent for provider kinds polled in aggregate (Cloudflare, PlanetScale). */
	lastSeen: Schema.optionalKey(Schema.String),
	namespace: Schema.optionalKey(Schema.String),
	cluster: Schema.optionalKey(Schema.String),
	environment: Schema.optionalKey(Schema.String),
	node: Schema.optionalKey(Schema.String),
	host: Schema.optionalKey(Schema.String),
	/** `deployment/checkout` style owner of a pod. */
	workload: Schema.optionalKey(Schema.String),
	workloadKind: Schema.optionalKey(Schema.String),
	image: Schema.optionalKey(Schema.String),
	os: Schema.optionalKey(Schema.String),
	cpuCores: Schema.optionalKey(Schema.Number),
	cpuCoresPeak: Schema.optionalKey(Schema.Number),
	/** Host/container CPU utilization, or pod CPU as a fraction of its limit. */
	cpu: Schema.optionalKey(Schema.Number),
	cpuPeak: Schema.optionalKey(Schema.Number),
	/** Host/container memory utilization, or pod memory as a fraction of its limit. */
	memory: Schema.optionalKey(Schema.Number),
	memoryPeak: Schema.optionalKey(Schema.Number),
	disk: Schema.optionalKey(Schema.Number),
	load15: Schema.optionalKey(Schema.Number),
	/** Peak of CPU and memory against their limits. 0 when no limit is set. */
	saturation: Schema.optionalKey(Schema.Number),
	/** Running with no CPU or memory limit, so saturation cannot be measured. */
	unbounded: Schema.optionalKey(Schema.Boolean),
	podCount: Schema.optionalKey(Schema.Number),
	uptimeSeconds: Schema.optionalKey(Schema.Number),
	/** Container restarts in the window (k8s.container.restarts, or Docker's container.restarts). */
	restarts: Schema.optionalKey(Schema.Number),
	/** Railway project, Cloudflare account. */
	project: Schema.optionalKey(Schema.String),
	memoryBytes: Schema.optionalKey(Schema.Number),
	replicas: Schema.optionalKey(Schema.Number),
	// Traffic kinds (Cloudflare zones and Workers): window totals.
	requests: Schema.optionalKey(Schema.Number),
	/** 5xx responses for a zone, failed invocations for a Worker. */
	errors: Schema.optionalKey(Schema.Number),
	errors4xx: Schema.optionalKey(Schema.Number),
	/** errors / requests. */
	errorRate: Schema.optionalKey(Schema.Number),
	/** Edge cache hits over cacheable requests. */
	cacheHitRate: Schema.optionalKey(Schema.Number),
	bytes: Schema.optionalKey(Schema.Number),
	visits: Schema.optionalKey(Schema.Number),
	subrequests: Schema.optionalKey(Schema.Number),
	/** Zone edge TTFB or Worker wall duration percentiles. */
	latencyP50Ms: Schema.optionalKey(Schema.Number),
	latencyP95Ms: Schema.optionalKey(Schema.Number),
	latencyP99Ms: Schema.optionalKey(Schema.Number),
	originP95Ms: Schema.optionalKey(Schema.Number),
	cpuTimeP50Ms: Schema.optionalKey(Schema.Number),
	cpuTimeP99Ms: Schema.optionalKey(Schema.Number),
	// PlanetScale databases.
	connections: Schema.optionalKey(Schema.Number),
	connectionsPeak: Schema.optionalKey(Schema.Number),
	replicaLagSeconds: Schema.optionalKey(Schema.Number),
})
export type InfraEntityRow = typeof InfraEntityRow.Type

/** Fleet counts for one kind, where the warehouse reports them. */
export const InfraFleetSummary = Schema.Struct({
	total: Schema.Number,
	saturated: Schema.optionalKey(Schema.Number),
	elevated: Schema.optionalKey(Schema.Number),
	unbounded: Schema.optionalKey(Schema.Number),
	stale: Schema.optionalKey(Schema.Number),
	ended: Schema.optionalKey(Schema.Number),
})

export const InfraKindSection = Schema.Struct({
	kind: InfraKind,
	summary: Schema.optionalKey(InfraFleetSummary),
	rows: Schema.Array(InfraEntityRow),
	truncated: Schema.Boolean,
})
export type InfraKindSection = typeof InfraKindSection.Type

// list_infra

export const ListInfraOutput = Schema.Struct({
	timeRange: OutputTimeRange,
	/** Kinds reporting telemetry in the window, whatever was asked for. */
	reporting: Schema.Array(InfraKind),
	sections: Schema.Array(InfraKindSection),
	kind: Schema.optionalKey(InfraKind),
	search: Schema.optionalKey(Schema.String),
	sort: Schema.optionalKey(Schema.String),
	status: Schema.optionalKey(Schema.String),
})

// inspect_infra

export const InfraSeriesStats = Schema.Struct({
	/** What the series measures, e.g. "cpu (fraction of limit)". */
	label: Schema.String,
	unit: Schema.Literals(["fraction", "cores", "load", "bytes", "seconds", "count", "ms"]),
	/** Series value per bucket for grouped metrics (filesystem by mountpoint, pods of a workload). */
	group: Schema.optionalKey(Schema.String),
	min: Schema.Number,
	avg: Schema.Number,
	max: Schema.Number,
	last: Schema.Number,
	maxAt: Schema.String,
	points: Schema.Number,
	/** Mean of the last third of the window minus the mean of the first third. */
	change: Schema.Number,
})
export type InfraSeriesStats = typeof InfraSeriesStats.Type

/** A ranked table from a provider (a zone's top paths, firewall rules, DNS names). */
export const InfraBreakdown = Schema.Struct({
	title: Schema.String,
	keyLabel: Schema.String,
	valueLabels: Schema.Array(Schema.String),
	rows: Schema.Array(Schema.Struct({ key: Schema.String, values: Schema.Array(Schema.Number) })),
})
export type InfraBreakdown = typeof InfraBreakdown.Type

export const InfraInspectSection = Schema.Literals(["traffic", "breakdown", "security", "dns"])

export const InspectInfraOutput = Schema.Struct({
	timeRange: OutputTimeRange,
	kind: InfraEntityKind,
	name: Schema.String,
	found: Schema.Boolean,
	/** Width of each series bucket; min/avg/max are over bucket averages, not raw samples. */
	bucketSeconds: Schema.Number,
	entity: Schema.optionalKey(InfraEntityRow),
	firstSeen: Schema.optionalKey(Schema.String),
	details: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
	series: Schema.Array(InfraSeriesStats),
	/** Pods of a workload, or containers on a host, busiest first. */
	children: Schema.optionalKey(InfraKindSection),
	/** Services whose spans name this workload (k8sattributes). */
	services: Schema.optionalKey(Schema.Array(Schema.String)),
	/** The Cloudflare zone section shown; other sections are one call away. */
	section: Schema.optionalKey(InfraInspectSection),
	breakdowns: Schema.optionalKey(Schema.Array(InfraBreakdown)),
})
