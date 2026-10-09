// Infrastructure -> Google Cloud: which tabs show, what each tab's columns read, and how the
// metric points of a tab fold into one table row per workload. Pure (no React, no atoms).

import {
	GCP_INFRA_ROW_LIMIT,
	GCP_INFRA_SERVICE_IDS,
	GCP_INFRA_SERVICES,
	type GcpInfraServiceId,
} from "@maple/domain/gcp-infra"
import type { V2GcpConnector } from "@maple/domain/http/v2"
import { errorRateLevel, type ErrorRateLevel } from "@maple/ui/lib/error-rate"
import { utilizationLevel, type UtilizationLevel } from "@maple/ui/lib/utilization"
import {
	EMPTY_VALUE,
	formatBytes,
	formatErrorRate,
	formatLatency,
	formatNumber,
	formatPercent,
} from "@maple/ui/lib/format"
import { gcpMetricsState } from "@/components/integrations/gcp-connector-state"

/** One metric and label value of one workload: `total` over `samples` points. */
export interface GcpMetricValue {
	readonly metric: string
	readonly label: string
	readonly total: number
	readonly samples: number
}

/** A row of the tab query: see `gcpInfraMetricsSQL`. */
export interface GcpMetricPoint extends GcpMetricValue {
	readonly keys: ReadonlyArray<string>
}

/** One workload's metrics over the window. Without `label`, every label value is added up. */
export interface GcpMetricReader {
	/** A counter's sum. The poller stores no zero deltas, so no points means zero. */
	readonly total: (metric: string, label?: string) => number
	/** A gauge's or percentile's mean per point; undefined when it never reported. */
	readonly mean: (metric: string, label?: string) => number | undefined
}

export type GcpColumnFormat =
	| "count"
	| "decimal"
	| "cores"
	| "percent"
	| "errorRate"
	| "ms"
	| "seconds"
	| "bytes"

export interface GcpColumn {
	/** Unique in its tab: also the column's sort key. */
	readonly label: string
	readonly format: GcpColumnFormat
	readonly value: (read: GcpMetricReader) => number | undefined
	/** For an `errorRate`: how many events it is the share of. */
	readonly events?: (read: GcpMetricReader) => number
	/** A counter summed over the range; every other column is an average over it. */
	readonly total?: boolean
}

export function formatGcpValue(format: GcpColumnFormat, value: number | undefined): string {
	if (value === undefined) return EMPTY_VALUE
	switch (format) {
		case "count":
			return formatNumber(value)
		case "decimal":
			return value.toLocaleString(undefined, { maximumFractionDigits: 2 })
		case "cores":
			// Most containers use a fraction of a core: millicores, as Kubernetes writes them.
			if (value >= 1) return value.toLocaleString(undefined, { maximumFractionDigits: 2 })
			return value > 0 && value < 0.001 ? "<1m" : `${Math.round(value * 1000)}m`
		case "percent":
			return formatPercent(value)
		case "errorRate":
			return formatErrorRate(value)
		case "ms":
			return formatLatency(value)
		case "seconds":
			return formatLatency(value * 1000)
		case "bytes":
			return formatBytes(value)
	}
}

const column = (label: string, format: GcpColumnFormat, value: GcpColumn["value"]): GcpColumn => ({
	label,
	format,
	value,
})

const total = (label: string, format: GcpColumnFormat, metric: string): GcpColumn => ({
	label,
	format,
	value: (read) => read.total(metric),
	total: true,
})

type Read = (read: GcpMetricReader) => number

/** The failed share of a counter: undefined while it counted nothing. */
export const failedShare =
	(metric: string, failed: Read) =>
	(read: GcpMetricReader): number | undefined => {
		const whole = read.total(metric)
		return whole > 0 ? failed(read) / whole : undefined
	}

// Cloud Run labels a response class "5xx", the load balancer "500".
export const serverErrors =
	(metric: string): Read =>
	(read) =>
		read.total(metric, "5xx") + read.total(metric, "500")

/** Everything a counter counted outside its one healthy label value. */
export const unhealthy =
	(metric: string, healthy: string): Read =>
	(read) =>
		read.total(metric) - read.total(metric, healthy)

const errorRate = (label: string, metric: string, failed: Read): GcpColumn => ({
	label,
	format: "errorRate",
	value: failedShare(metric, failed),
	events: (read) => read.total(metric),
})

const RUN = "gcp.run"
const FUNCTION = "gcp.cloudfunctions.function"
const CONTAINER = "gcp.kubernetes.container"
const INSTANCE = "gcp.compute.instance"
const DATABASE = "gcp.cloudsql.database"
const SUBSCRIPTION = "gcp.pubsub.subscription"
const HTTPS = "gcp.loadbalancing.https"

export const GCP_INFRA_COLUMNS: Record<GcpInfraServiceId, ReadonlyArray<GcpColumn>> = {
	cloudRun: [
		total("Requests", "count", `${RUN}.request_count`),
		errorRate("5xx rate", `${RUN}.request_count`, serverErrors(`${RUN}.request_count`)),
		column("Latency p95", "ms", (m) => m.mean(`${RUN}.request_latencies`, "0.95")),
		column("Latency p99", "ms", (m) => m.mean(`${RUN}.request_latencies`, "0.99")),
		column("Instances", "decimal", (m) => m.mean(`${RUN}.container.instance_count`, "active")),
		column("CPU p95", "percent", (m) => m.mean(`${RUN}.container.cpu.utilizations`, "0.95")),
		column("Memory p95", "percent", (m) => m.mean(`${RUN}.container.memory.utilizations`, "0.95")),
	],
	cloudFunctions: [
		total("Executions", "count", `${FUNCTION}.execution_count`),
		errorRate(
			"Error rate",
			`${FUNCTION}.execution_count`,
			unhealthy(`${FUNCTION}.execution_count`, "ok"),
		),
		column("Duration p95", "ms", (m) => m.mean(`${FUNCTION}.execution_times`, "0.95")),
		column("Duration p99", "ms", (m) => m.mean(`${FUNCTION}.execution_times`, "0.99")),
		column("Instances", "decimal", (m) => m.mean(`${FUNCTION}.instance_count`, "active")),
		column("Memory p95", "bytes", (m) => m.mean(`${FUNCTION}.user_memory_bytes`, "0.95")),
	],
	gke: [
		// A point is the CPU seconds used in one minute: the mean covers the minutes it ran.
		column("CPU cores", "cores", (m) => {
			const seconds = m.mean(`${CONTAINER}.cpu.core_usage_time`)
			return seconds === undefined ? undefined : seconds / 60
		}),
		column("CPU of limit", "percent", (m) => m.mean(`${CONTAINER}.cpu.limit_utilization`)),
		// Non-evictable memory is what counts against the limit.
		column("Memory", "bytes", (m) => m.mean(`${CONTAINER}.memory.used_bytes`, "non-evictable")),
		column("Mem of limit", "percent", (m) =>
			m.mean(`${CONTAINER}.memory.limit_utilization`, "non-evictable"),
		),
		total("Restarts", "count", `${CONTAINER}.restart_count`),
	],
	computeEngine: [
		column("CPU", "percent", (m) => m.mean(`${INSTANCE}.cpu.utilization`)),
		// E2 machine types only.
		column("Memory", "bytes", (m) => m.mean(`${INSTANCE}.memory.balloon.ram_used`)),
		total("Network in", "bytes", `${INSTANCE}.network.received_bytes_count`),
		total("Network out", "bytes", `${INSTANCE}.network.sent_bytes_count`),
		total("Disk read", "bytes", `${INSTANCE}.disk.read_bytes_count`),
		total("Disk write", "bytes", `${INSTANCE}.disk.write_bytes_count`),
	],
	cloudSql: [
		column("CPU", "percent", (m) => m.mean(`${DATABASE}.cpu.utilization`)),
		column("Memory", "percent", (m) => m.mean(`${DATABASE}.memory.utilization`)),
		column("Disk", "percent", (m) => m.mean(`${DATABASE}.disk.utilization`)),
		// MySQL and SQL Server report the first, PostgreSQL the second.
		column(
			"Connections",
			"decimal",
			(m) => m.mean(`${DATABASE}.network.connections`) ?? m.mean(`${DATABASE}.postgresql.num_backends`),
		),
		column("Replica lag", "seconds", (m) => m.mean(`${DATABASE}.replication.replica_lag`)),
	],
	pubsub: [
		column("Backlog", "decimal", (m) => m.mean(`${SUBSCRIPTION}.num_undelivered_messages`)),
		column("Unacked age", "seconds", (m) => m.mean(`${SUBSCRIPTION}.oldest_unacked_message_age`)),
		total("Delivered", "count", `${SUBSCRIPTION}.sent_message_count`),
		total("Acked", "count", `${SUBSCRIPTION}.ack_message_count`),
		total("Dead-lettered", "count", `${SUBSCRIPTION}.dead_letter_message_count`),
		// Push subscriptions only.
		errorRate(
			"Push errors",
			`${SUBSCRIPTION}.push_request_count`,
			unhealthy(`${SUBSCRIPTION}.push_request_count`, "ack"),
		),
	],
	loadBalancing: [
		total("Requests", "count", `${HTTPS}.request_count`),
		errorRate("5xx rate", `${HTTPS}.request_count`, serverErrors(`${HTTPS}.request_count`)),
		column("Latency p95", "ms", (m) => m.mean(`${HTTPS}.total_latencies`, "0.95")),
		column("Latency p99", "ms", (m) => m.mean(`${HTTPS}.total_latencies`, "0.99")),
		column("Backend p95", "ms", (m) => m.mean(`${HTTPS}.backend_latencies`, "0.95")),
		total("Response size", "bytes", `${HTTPS}.response_bytes_count`),
	],
} satisfies Record<GcpInfraServiceId, ReadonlyArray<GcpColumn>>

/** Reads values that hold each metric and label value once. */
export const gcpMetricReader = (points: ReadonlyArray<GcpMetricValue>): GcpMetricReader => {
	const matching = (metric: string, label?: string) =>
		points.filter((point) => point.metric === metric && (label === undefined || point.label === label))
	return {
		total: (metric, label) => matching(metric, label).reduce((sum, point) => sum + point.total, 0),
		mean: (metric, label) => {
			const matched = matching(metric, label)
			return matched.length === 0
				? undefined
				: matched.reduce((sum, point) => sum + point.total / point.samples, 0)
		},
	}
}

/** An error rate over fewer events than this is no finding: one failure of two is not an outage. */
const GCP_MIN_EVENTS = 100

export interface GcpWorkload {
	/** Identity values, in the order of the service's `identity`. The first names the row. */
	readonly keys: ReadonlyArray<string>
	/** One value per column of the tab; undefined where the workload reported nothing. */
	readonly values: ReadonlyArray<number | undefined>
	/** Its busiest `percent` column, every one a share of a limit or of capacity. */
	readonly saturation: UtilizationLevel
	/** Its worst error rate over at least `GCP_MIN_EVENTS` events. */
	readonly errors: ErrorRateLevel
}

/** A page's workload, read from the points that hold each of its metrics once. */
export function gcpWorkload(
	service: GcpInfraServiceId,
	keys: ReadonlyArray<string>,
	points: ReadonlyArray<GcpMetricValue>,
): GcpWorkload {
	const read = gcpMetricReader(points)
	const columns = GCP_INFRA_COLUMNS[service]
	const values = columns.map((spec) => spec.value(read))
	const worst = (counts: (spec: GcpColumn) => boolean) =>
		Math.max(0, ...columns.flatMap((spec, index) => (counts(spec) ? [values[index] ?? 0] : [])))
	return {
		keys,
		values,
		saturation: utilizationLevel(worst((spec) => spec.format === "percent")),
		errors: errorRateLevel(
			worst((spec) => spec.events !== undefined && spec.events(read) >= GCP_MIN_EVENTS),
		),
	}
}

/** One table row per workload, from the tab query's points. */
export function gcpWorkloads(
	service: GcpInfraServiceId,
	points: ReadonlyArray<GcpMetricPoint>,
): ReadonlyArray<GcpWorkload> {
	const byWorkload = new Map<string, { keys: ReadonlyArray<string>; points: Array<GcpMetricPoint> }>()
	for (const point of points) {
		const id = point.keys.join("\u0000")
		const workload = byWorkload.get(id)
		if (workload === undefined) byWorkload.set(id, { keys: point.keys, points: [point] })
		else workload.points.push(point)
	}
	return [...byWorkload.values()].map((workload) => gcpWorkload(service, workload.keys, workload.points))
}

/** One reporting service of the fleet read: see `getGcpInfraFleet`. */
export interface GcpFleetService {
	readonly service: GcpInfraServiceId
	readonly workloads: ReadonlyArray<GcpWorkload>
	/** The service's query hit its row cap. */
	readonly truncated: boolean
	/** The service's query failed: its workloads are unknown, not absent. */
	readonly failed: boolean
}

/** Stable empty fallback so memos don't recompute on every render. */
export const NO_GCP_FLEET: ReadonlyArray<GcpFleetService> = []

export const gcpFleet = (
	services: ReadonlyArray<{
		readonly service: GcpInfraServiceId
		readonly points: ReadonlyArray<GcpMetricPoint>
		readonly failed: boolean
	}>,
): ReadonlyArray<GcpFleetService> =>
	services.map(({ service, points, failed }) => ({
		service,
		workloads: gcpWorkloads(service, points),
		truncated: points.length >= GCP_INFRA_ROW_LIMIT,
		failed,
	}))

/** A workload's tone on a health strip: the worse of its saturation and its error rate. */
export const gcpWorkloadTone = (workload: GcpWorkload): ErrorRateLevel =>
	workload.saturation === "crit" || workload.errors === "crit"
		? "crit"
		: workload.saturation === "warn" || workload.errors === "warn"
			? "warn"
			: "neutral"

export const GCP_SCOPES = ["saturated", "elevated", "erroring"] as const
export type GcpScope = (typeof GCP_SCOPES)[number]

export const gcpInScope = (workload: GcpWorkload, scope: GcpScope): boolean =>
	scope === "saturated"
		? workload.saturation === "crit"
		: scope === "elevated"
			? workload.saturation === "warn"
			: workload.errors !== "neutral"

const identityValue = (
	service: GcpInfraServiceId,
	keys: ReadonlyArray<string>,
	labels: ReadonlyArray<string>,
): string | undefined =>
	keys[GCP_INFRA_SERVICES[service].identity.findIndex(([label]) => labels.includes(label))]

const REGION_LABELS = ["Region", "Location", "Zone"]

export const gcpWorkloadProject = (service: GcpInfraServiceId, keys: ReadonlyArray<string>) =>
	identityValue(service, keys, ["Project"])

/** Where a workload runs, as Google Cloud names it: a region or a zone. Undefined for a global one. */
export const gcpWorkloadLocation = (service: GcpInfraServiceId, keys: ReadonlyArray<string>) =>
	identityValue(service, keys, REGION_LABELS)

/** The region a workload runs in: its own, or its zone's. */
export const gcpWorkloadRegion = (service: GcpInfraServiceId, keys: ReadonlyArray<string>) =>
	gcpWorkloadLocation(service, keys)?.replace(/-[a-z]$/, "")

/** The search params that carry a workload's identity after its name, by lower-cased identity label. */
const GCP_WORKLOAD_PARAMS = [
	"project",
	"region",
	"namespace",
	"cluster",
	"location",
	"zone",
	"backend",
] as const
type GcpWorkloadSearch = Partial<Record<(typeof GCP_WORKLOAD_PARAMS)[number], string>>

const workloadParams = (service: GcpInfraServiceId) =>
	GCP_INFRA_SERVICES[service].identity
		.slice(1)
		.flatMap(([label]) => GCP_WORKLOAD_PARAMS.filter((name) => name === label.toLowerCase()))

/** The search params of a workload's page. */
export function gcpWorkloadSearch(
	service: GcpInfraServiceId,
	keys: ReadonlyArray<string>,
): GcpWorkloadSearch {
	const search: GcpWorkloadSearch = {}
	for (const [index, name] of workloadParams(service).entries()) search[name] = keys[index + 1]
	return search
}

/** A workload's identity values from its page's address; an absent param reads as empty. */
export const gcpWorkloadKeys = (
	service: GcpInfraServiceId,
	name: string,
	search: GcpWorkloadSearch,
): ReadonlyArray<string> => [name, ...workloadParams(service).map((param) => search[param] ?? "")]

/** What to call a workload: its name, without the project Cloud Monitoring puts before a Cloud SQL instance. */
export const gcpWorkloadName = (service: GcpInfraServiceId, keys: ReadonlyArray<string>): string =>
	service === "cloudSql" ? keys[0].slice(keys[0].indexOf(":") + 1) : keys[0]

/** Whether a service's workloads run in a region or zone; a subscription and a URL map are global. */
export const gcpHasRegion = (service: GcpInfraServiceId): boolean =>
	GCP_INFRA_SERVICES[service].identity.some(([label]) => REGION_LABELS.includes(label))

/** What one row of a tab is, in running text: "container", "URL map". */
export const gcpWorkloadNoun = (service: GcpInfraServiceId): string =>
	GCP_INFRA_SERVICES[service].identity[0][0].replace(/^[A-Z](?=[a-z])/, (letter) => letter.toLowerCase())

/** Sort key of the name column; every other key is a column label. */
export const GCP_NAME_SORT = "name"

/** Sorted by the name or by one column. A value that never reported sorts last either way. */
export function sortGcpWorkloads(
	service: GcpInfraServiceId,
	workloads: ReadonlyArray<GcpWorkload>,
	sort: { readonly key: string; readonly dir: "asc" | "desc" },
): ReadonlyArray<GcpWorkload> {
	const sign = sort.dir === "asc" ? 1 : -1
	const index = GCP_INFRA_COLUMNS[service].findIndex((spec) => spec.label === sort.key)
	return [...workloads].sort((a, b) => {
		if (sort.key === GCP_NAME_SORT) return sign * a.keys[0].localeCompare(b.keys[0])
		const left = a.values[index]
		const right = b.values[index]
		if (left === undefined || right === undefined) {
			return left === right ? 0 : left === undefined ? 1 : -1
		}
		return sign * (left - right)
	})
}

export const GCP_RESOURCES_TAB = "resources"
export const GCP_INFRA_TABS = [...GCP_INFRA_SERVICE_IDS, GCP_RESOURCES_TAB] as const
export type GcpInfraTab = (typeof GCP_INFRA_TABS)[number]

/**
 * The tabs on the page: the services reporting in the window, then the inventory. A requested
 * service tab stays, so a link or a narrower time range lands on its empty state. The inventory
 * only while a connection collects: the resources of one that stopped are not listed.
 */
export const gcpInfraTabs = (
	reporting: ReadonlyArray<GcpInfraServiceId>,
	requested: GcpInfraTab | undefined,
	collecting: boolean,
): ReadonlyArray<GcpInfraTab> =>
	GCP_INFRA_TABS.filter((tab) =>
		tab === GCP_RESOURCES_TAB ? collecting : tab === requested || reporting.includes(tab),
	)

export type GcpInfraNotice =
	/** A connector's reads fail, or arrive with part of the metrics missing. */
	| { readonly kind: "failing" | "incomplete"; readonly error: string }
	/** No error, and no read for half an hour. */
	| { readonly kind: "stalled" }
	/** The setup script has run and the first read has not landed. */
	| { readonly kind: "waiting" }
	/** Metrics arrive, but none in the selected window. */
	| { readonly kind: "quiet" }
	/** Metrics are switched off on every connection: the tables show what was collected before. */
	| { readonly kind: "off" }

type MetricsFields = Parameters<typeof gcpMetricsState>[0]

/** No connection has run its setup script with metrics on: nothing to show but the next step. */
export const gcpInfraSetupPending = (connectors: ReadonlyArray<MetricsFields>, nowMs: number): boolean =>
	connectors.every((connector) => gcpMetricsState(connector, nowMs).kind === "setup-pending")

/**
 * What to say above the tabs, given the connectors that collect metrics: none when metrics are
 * switched off on every connection. Worst first.
 */
export function gcpInfraNotice(
	connectors: ReadonlyArray<MetricsFields>,
	reporting: boolean,
	nowMs: number,
): GcpInfraNotice | null {
	if (connectors.length === 0) return { kind: "off" }
	const states = connectors.map((connector) => gcpMetricsState(connector, nowMs))
	const broken =
		states.find((state) => state.kind === "failing") ??
		states.find((state) => state.kind === "incomplete")
	if (broken !== undefined) return { kind: broken.kind, error: broken.error }
	const has = (kind: (typeof states)[number]["kind"]) => states.some((state) => state.kind === kind)
	if (has("stalled")) return { kind: "stalled" }
	if (reporting) return null
	if (has("receiving")) return { kind: "quiet" }
	// A run that is still working is minutes from its first read too.
	return has("waiting") || has("setup-running") ? { kind: "waiting" } : null
}

/** Why the inventory may be stale: the first failing resource sync, or null. */
export const gcpResourcesError = (
	connectors: ReadonlyArray<Pick<V2GcpConnector, "last_resources_error">>,
): string | null =>
	connectors.find((connector) => connector.last_resources_error !== null)?.last_resources_error ?? null

const ASSET_TYPE_LABELS: Record<string, string> = {
	"cloudresourcemanager.googleapis.com/Project": "Project",
	"run.googleapis.com/Service": "Cloud Run service",
	"run.googleapis.com/Job": "Cloud Run job",
	"cloudfunctions.googleapis.com/CloudFunction": "Cloud Function (1st gen)",
	"cloudfunctions.googleapis.com/Function": "Cloud Function (2nd gen)",
	"container.googleapis.com/Cluster": "GKE cluster",
	"compute.googleapis.com/Instance": "VM instance",
	"sqladmin.googleapis.com/Instance": "Cloud SQL instance",
	"pubsub.googleapis.com/Topic": "Pub/Sub topic",
	"pubsub.googleapis.com/Subscription": "Pub/Sub subscription",
	"compute.googleapis.com/UrlMap": "URL map",
	"compute.googleapis.com/BackendService": "Backend service",
	"compute.googleapis.com/ForwardingRule": "Forwarding rule",
} satisfies Record<string, string>

/** A Cloud Asset Inventory type in words; the raw type when it is not one Maple collects. */
export const gcpAssetTypeLabel = (assetType: string): string => ASSET_TYPE_LABELS[assetType] ?? assetType

/** "RUNNING" and "PENDING_CREATE" as Google reports them, in sentence case. */
export const gcpStateLabel = (state: string) =>
	(state.charAt(0) + state.slice(1).toLowerCase()).replaceAll("_", " ")

/** What to call a resource: its display name, else the last segment of its full name. */
export const gcpResourceName = (resource: {
	readonly name: string
	readonly displayName: string | null
}): string => resource.displayName || (resource.name.split("/").at(-1) ?? resource.name)
