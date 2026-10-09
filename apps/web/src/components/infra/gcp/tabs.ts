// Infrastructure -> Google Cloud: which tabs show, what each tab's columns read, and how the
// metric points of a tab fold into one table row per workload. Pure (no React, no atoms).

import { GCP_INFRA_SERVICE_IDS, type GcpInfraServiceId } from "@maple/domain/gcp-infra"
import type { V2GcpConnector } from "@maple/domain/http/v2"
import {
	EMPTY_VALUE,
	formatBytes,
	formatErrorRate,
	formatLatency,
	formatNumber,
	formatPercent,
} from "@maple/ui/lib/format"
import { gcpMetricsState } from "@/components/integrations/gcp-connector-state"

/** A row of the tab query: see `gcpInfraMetricsSQL`. */
export interface GcpMetricPoint {
	readonly keys: ReadonlyArray<string>
	readonly metric: string
	readonly label: string
	readonly total: number
	readonly samples: number
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

const share = (part: number, whole: number) => (whole > 0 ? part / whole : undefined)

// Cloud Run labels a response class "5xx", the load balancer "500".
const serverErrorShare = (read: GcpMetricReader, metric: string) =>
	share(read.total(metric, "5xx") + read.total(metric, "500"), read.total(metric))

/** The share of a counter outside its one healthy label value. */
const failedShare = (read: GcpMetricReader, metric: string, healthy: string) =>
	share(read.total(metric) - read.total(metric, healthy), read.total(metric))

const RUN = "gcp.run"
const FUNCTION = "gcp.cloudfunctions.function"
const CONTAINER = "gcp.kubernetes.container"
const INSTANCE = "gcp.compute.instance"
const DATABASE = "gcp.cloudsql.database"
const SUBSCRIPTION = "gcp.pubsub.subscription"
const HTTPS = "gcp.loadbalancing.https"

export const GCP_INFRA_COLUMNS: Record<GcpInfraServiceId, ReadonlyArray<GcpColumn>> = {
	cloudRun: [
		column("Requests", "count", (m) => m.total(`${RUN}.request_count`)),
		column("5xx rate", "errorRate", (m) => serverErrorShare(m, `${RUN}.request_count`)),
		column("Latency p95", "ms", (m) => m.mean(`${RUN}.request_latencies`, "0.95")),
		column("Latency p99", "ms", (m) => m.mean(`${RUN}.request_latencies`, "0.99")),
		column("Instances", "decimal", (m) => m.mean(`${RUN}.container.instance_count`, "active")),
		column("CPU p95", "percent", (m) => m.mean(`${RUN}.container.cpu.utilizations`, "0.95")),
		column("Memory p95", "percent", (m) => m.mean(`${RUN}.container.memory.utilizations`, "0.95")),
	],
	cloudFunctions: [
		column("Executions", "count", (m) => m.total(`${FUNCTION}.execution_count`)),
		column("Error rate", "errorRate", (m) => failedShare(m, `${FUNCTION}.execution_count`, "ok")),
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
		column("Restarts", "count", (m) => m.total(`${CONTAINER}.restart_count`)),
	],
	computeEngine: [
		column("CPU", "percent", (m) => m.mean(`${INSTANCE}.cpu.utilization`)),
		// E2 machine types only.
		column("Memory", "bytes", (m) => m.mean(`${INSTANCE}.memory.balloon.ram_used`)),
		column("Network in", "bytes", (m) => m.total(`${INSTANCE}.network.received_bytes_count`)),
		column("Network out", "bytes", (m) => m.total(`${INSTANCE}.network.sent_bytes_count`)),
		column("Disk read", "bytes", (m) => m.total(`${INSTANCE}.disk.read_bytes_count`)),
		column("Disk write", "bytes", (m) => m.total(`${INSTANCE}.disk.write_bytes_count`)),
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
		column("Delivered", "count", (m) => m.total(`${SUBSCRIPTION}.sent_message_count`)),
		column("Acked", "count", (m) => m.total(`${SUBSCRIPTION}.ack_message_count`)),
		column("Dead-lettered", "count", (m) => m.total(`${SUBSCRIPTION}.dead_letter_message_count`)),
		// Push subscriptions only.
		column("Push errors", "errorRate", (m) =>
			failedShare(m, `${SUBSCRIPTION}.push_request_count`, "ack"),
		),
	],
	loadBalancing: [
		column("Requests", "count", (m) => m.total(`${HTTPS}.request_count`)),
		column("5xx rate", "errorRate", (m) => serverErrorShare(m, `${HTTPS}.request_count`)),
		column("Latency p95", "ms", (m) => m.mean(`${HTTPS}.total_latencies`, "0.95")),
		column("Latency p99", "ms", (m) => m.mean(`${HTTPS}.total_latencies`, "0.99")),
		column("Backend p95", "ms", (m) => m.mean(`${HTTPS}.backend_latencies`, "0.95")),
		column("Response size", "bytes", (m) => m.total(`${HTTPS}.response_bytes_count`)),
	],
} satisfies Record<GcpInfraServiceId, ReadonlyArray<GcpColumn>>

const readerOf = (points: ReadonlyArray<GcpMetricPoint>): GcpMetricReader => {
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

export interface GcpWorkload {
	/** Identity values, in the order of the service's `identity`. The first names the row. */
	readonly keys: ReadonlyArray<string>
	/** One value per column of the tab; undefined where the workload reported nothing. */
	readonly values: ReadonlyArray<number | undefined>
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
	return [...byWorkload.values()].map((workload) => {
		const read = readerOf(workload.points)
		return { keys: workload.keys, values: GCP_INFRA_COLUMNS[service].map((spec) => spec.value(read)) }
	})
}

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
 * service tab stays, so a link or a narrower time range lands on its empty state.
 */
export const gcpInfraTabs = (
	reporting: ReadonlyArray<GcpInfraServiceId>,
	requested: GcpInfraTab | undefined,
): ReadonlyArray<GcpInfraTab> =>
	GCP_INFRA_TABS.filter((tab) => tab === GCP_RESOURCES_TAB || tab === requested || reporting.includes(tab))

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

/** What to call a resource: its display name, else the last segment of its full name. */
export const gcpResourceName = (resource: {
	readonly name: string
	readonly displayName: string | null
}): string => resource.displayName || (resource.name.split("/").at(-1) ?? resource.name)
