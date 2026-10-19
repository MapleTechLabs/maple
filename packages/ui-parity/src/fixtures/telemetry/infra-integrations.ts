import {
	GCP_INFRA_SOURCES,
	gcpInfraMetrics,
	gcpInfraServiceName,
	type GcpInfraSourceId,
} from "@maple/domain/gcp-infra"
import { gcpMetricLabelAttribute } from "@maple/domain/gcp-metrics"
import { formatMicros, type TelemetryRows, type WarehouseRow } from "./rows.ts"

/**
 * What the integration pollers write for one org: Cloudflare zone, Worker and queue analytics,
 * Railway replica gauges, Google Cloud monitoring series and scraped PlanetScale gauges.
 * Values are smooth functions of the slot index, so the seed is deterministic without a PRNG.
 */

const MINUTE_MICROS = 60_000_000
const SLOT_MICROS = 5 * MINUTE_MICROS
const SLOTS = 288
const GCP_MINUTES = 180

export const CF_ACCOUNT_ID = "4f1c2a9e0b7d4c3a8e6f5d2c1b0a9e8d"
export const CF_ZONES = ["acme.test", "docs.acme.test"] as const
export const CF_WORKERS = ["edge-router", "image-resizer"] as const
export const CF_QUEUE = "order-events"

export const RAILWAY_PROJECT = { id: "prj_acme_shop", name: "acme-shop" } as const
export const RAILWAY_ENVIRONMENTS = [
	{ id: "env_acme_production", name: "production" },
	{ id: "env_acme_staging", name: "staging" },
] as const
export const RAILWAY_SERVICES = [
	{ id: "svc_acme_api", name: "api", replicas: 2, env: 0, volume: false, cpuLimit: 8 },
	{ id: "svc_acme_worker", name: "worker", replicas: 1, env: 0, volume: false, cpuLimit: 4 },
	{ id: "svc_acme_postgres", name: "postgres", replicas: 1, env: 0, volume: true, cpuLimit: 8 },
	{ id: "svc_acme_api", name: "api", replicas: 1, env: 1, volume: false, cpuLimit: 2 },
] as const

export const PS_DATABASES = [
	{ name: "acme-prod", branches: ["main", "dev"] },
	{ name: "acme-analytics", branches: ["main"] },
] as const

export const GCP_PROJECT = "acme-shop-prod"
/** One identity tuple per workload, in `GCP_INFRA_SOURCES[source].identity` order. */
export const GCP_WORKLOADS: ReadonlyArray<{
	readonly source: GcpInfraSourceId
	readonly keys: ReadonlyArray<string>
}> = [
	{ source: "cloudRun", keys: ["checkout-api", GCP_PROJECT, "us-central1"] },
	{ source: "cloudRun", keys: ["image-worker", GCP_PROJECT, "us-central1"] },
	{ source: "cloudFunctions", keys: ["send-receipt", GCP_PROJECT, "us-central1"] },
	{ source: "computeEngine", keys: ["batch-runner-1", GCP_PROJECT, "us-central1-a"] },
	{ source: "cloudSql", keys: [`${GCP_PROJECT}:orders-db`, GCP_PROJECT, "us-central1"] },
	{ source: "pubsub", keys: ["orders-sub", GCP_PROJECT] },
]

const wave = (slot: number, period: number, phase = 0) =>
	0.5 + 0.5 * Math.sin((slot / period) * 2 * Math.PI + phase)

const base = (
	orgId: string,
	serviceName: string,
	resource: Readonly<Record<string, string>>,
	name: string,
	unit: string,
	micros: number,
) => ({
	OrgId: orgId,
	ResourceAttributes: resource,
	ResourceSchemaUrl: "",
	ScopeName: "maple-integrations",
	ScopeVersion: "1.0.0",
	ScopeAttributes: {},
	ScopeSchemaUrl: "",
	ServiceName: serviceName,
	MetricName: name,
	MetricDescription: "",
	MetricUnit: unit,
	StartTimeUnix: formatMicros(micros - SLOT_MICROS),
	TimeUnix: formatMicros(micros),
	ExemplarsTraceId: [],
	ExemplarsSpanId: [],
	ExemplarsTimestamp: [],
	ExemplarsValue: [],
	ExemplarsFilteredAttributes: [],
	Flags: 0,
})

interface Sink {
	readonly gauge: Array<WarehouseRow>
	readonly sum: Array<WarehouseRow>
}

type Emit = (name: string, unit: string, value: number, attributes?: Readonly<Record<string, string>>) => void

const emitters = (
	sink: Sink,
	orgId: string,
	serviceName: string,
	resource: Readonly<Record<string, string>>,
	micros: number,
) => {
	const gauge: Emit = (name, unit, value, attributes = {}) =>
		sink.gauge.push({
			...base(orgId, serviceName, resource, name, unit, micros),
			Attributes: attributes,
			Value: value,
		})
	const sum: Emit = (name, unit, value, attributes = {}) =>
		sink.sum.push({
			...base(orgId, serviceName, resource, name, unit, micros),
			Attributes: attributes,
			Value: Math.round(value),
			AggregationTemporality: 1,
			IsMonotonic: true,
		})
	return { gauge, sum }
}

const HTTP_MIX = [
	["acme.test", "2xx", "hit", 0.46],
	["acme.test", "2xx", "miss", 0.12],
	["acme.test", "2xx", "dynamic", 0.2],
	["www.acme.test", "2xx", "hit", 0.08],
	["acme.test", "3xx", "none", 0.05],
	["acme.test", "4xx", "dynamic", 0.06],
	["acme.test", "5xx", "dynamic", 0.03],
] as const
const PATHS = [
	["/", 0.4],
	["/products", 0.3],
	["/api/cart", 0.2],
	["/checkout", 0.1],
] as const
const COUNTRIES = [
	["US", 0.55],
	["DE", 0.2],
	["GB", 0.15],
	["JP", 0.1],
] as const
const CLIENTS = [
	["GET", "HTTP/2", "desktop", 0.6],
	["GET", "HTTP/3", "mobile", 0.3],
	["POST", "HTTP/2", "desktop", 0.1],
] as const
const DNS = [
	["acme.test", "NOERROR", 0.6],
	["www.acme.test", "NOERROR", 0.3],
	["old.acme.test", "NXDOMAIN", 0.1],
] as const

const cloudflareSlot = (sink: Sink, orgId: string, slot: number, micros: number) => {
	const resource = { "cloudflare.account.id": CF_ACCOUNT_ID }
	CF_ZONES.forEach((zone, index) => {
		const { gauge, sum } = emitters(sink, orgId, `cloudflare/${zone}`, resource, micros)
		const volume = (index === 0 ? 4200 : 650) * (0.6 + 0.8 * wave(slot, 288, -1.4))
		const host = (name: string) => name.replace("acme.test", zone)
		HTTP_MIX.forEach(([name, statusClass, cacheStatus, share]) =>
			sum("cloudflare.http.requests", "{request}", volume * share, {
				"server.address": host(name),
				"http.status_class": statusClass,
				"cache.status": cacheStatus,
			}),
		)
		const cube = { "server.address": zone, "http.status_class": "2xx", "cache.status": "hit" }
		sum("cloudflare.http.bytes", "By", volume * 48_000, cube)
		sum("cloudflare.http.visits", "{visit}", volume * 0.18, cube)
		const ttfb = 38 + 22 * wave(slot, 96) + index * 12
		const origin = 120 + 60 * wave(slot, 72, 1) + index * 40
		for (const [quantile, factor] of [
			["0.5", 1],
			["0.95", 2.6],
			["0.99", 4.1],
		] as const) {
			gauge("cloudflare.http.edge.ttfb", "ms", ttfb * factor, { quantile })
			gauge("cloudflare.http.origin.duration", "ms", origin * factor, { quantile })
		}
		PATHS.forEach(([path, share]) => {
			sum("cloudflare.http.requests.by_path", "{request}", volume * share, { "url.path": path })
			sum(
				"cloudflare.http.errors.by_path",
				"{request}",
				volume * share * (path === "/checkout" ? 0.08 : 0.01),
				{ "url.path": path },
			)
			sum("cloudflare.http.bytes.by_path", "By", volume * share * 52_000, { "url.path": path })
		})
		COUNTRIES.forEach(([country, share]) => {
			sum("cloudflare.http.requests.by_country", "{request}", volume * share, {
				"geo.country_iso_code": country,
			})
			sum("cloudflare.http.bytes.by_country", "By", volume * share * 50_000, {
				"geo.country_iso_code": country,
			})
		})
		CLIENTS.forEach(([method, protocol, device, share]) =>
			sum("cloudflare.http.requests.by_client", "{request}", volume * share, {
				"http.request.method": method,
				"network.protocol.version": protocol,
				"cloudflare.device.type": device,
			}),
		)
		const firewall = (action: string, source: string, rule: string, value: number) =>
			sum("cloudflare.firewall.events", "{event}", value, {
				"server.address": zone,
				"firewall.action": action,
				"firewall.source": source,
				"firewall.rule_id": rule,
			})
		firewall("block", "waf", "rule_sqli_100", 14 + 30 * wave(slot, 48))
		firewall("managed_challenge", "ratelimit", "rule_rl_login", 6 + 12 * wave(slot, 64, 2))
		DNS.forEach(([name, code, share]) =>
			sum("cloudflare.dns.queries", "{query}", volume * 0.4 * share, {
				"dns.query_name": host(name),
				"dns.response_code": code,
			}),
		)
	})
	CF_WORKERS.forEach((worker, index) => {
		const { gauge, sum } = emitters(sink, orgId, `cloudflare-worker/${worker}`, resource, micros)
		const invocations = (index === 0 ? 3100 : 420) * (0.6 + 0.8 * wave(slot, 288, -1.2))
		const thrown = invocations * (index === 0 ? 0.004 : 0.02)
		sum("cloudflare.worker.requests", "{request}", invocations - thrown, { "worker.status": "success" })
		sum("cloudflare.worker.requests", "{request}", thrown, { "worker.status": "scriptThrewException" })
		sum("cloudflare.worker.errors", "{error}", thrown)
		sum("cloudflare.worker.subrequests", "{request}", invocations * 1.6)
		for (const [quantile, factor] of [
			["0.5", 1],
			["0.99", 5],
		] as const) {
			gauge("cloudflare.worker.cpu_time", "ms", (2.1 + index * 6 + wave(slot, 60)) * factor, {
				quantile,
			})
			gauge("cloudflare.worker.duration", "ms", (18 + index * 40 + 8 * wave(slot, 80)) * factor, {
				quantile,
			})
			if (index === 0)
				gauge("cloudflare.durable_object.wall_time", "ms", (9 + 3 * wave(slot, 50)) * factor, {
					quantile,
				})
		}
		if (index === 0) {
			sum("cloudflare.durable_object.requests", "{request}", invocations * 0.3)
			sum("cloudflare.durable_object.errors", "{error}", invocations * 0.3 * 0.002)
		}
	})
	const queue = emitters(sink, orgId, `cloudflare-queue/${CF_QUEUE}`, resource, micros)
	const backlog = Math.round(40 + 260 * wave(slot, 36))
	queue.gauge("cloudflare.queue.backlog.messages", "{message}", backlog)
	queue.gauge("cloudflare.queue.backlog.bytes", "By", backlog * 1800)
	queue.gauge("cloudflare.queue.consumer.concurrency", "1", 2 + Math.round(3 * wave(slot, 36)))
}

const GIB = 1024 ** 3

const railwaySlot = (sink: Sink, orgId: string, slot: number, micros: number) =>
	RAILWAY_SERVICES.forEach((service, index) => {
		const environment = RAILWAY_ENVIRONMENTS[service.env]
		Array.from({ length: service.replicas }, (_, replica) => {
			const resource = {
				"railway.project.id": RAILWAY_PROJECT.id,
				"railway.project.name": RAILWAY_PROJECT.name,
				"railway.environment.id": environment.id,
				"railway.environment.name": environment.name,
				"railway.service.id": service.id,
				"railway.replica.id": `${service.id}-${environment.name}-r${replica}`,
			}
			const { gauge } = emitters(sink, orgId, service.name, resource, micros)
			const load = 0.15 + 0.5 * wave(slot, 96 + index * 13, index)
			gauge("railway.cpu.usage", "{vCPU}", (service.cpuLimit / service.replicas) * load * 0.6)
			gauge("railway.cpu.limit", "{vCPU}", service.cpuLimit / service.replicas)
			gauge("railway.memory.usage", "By", (0.4 + load) * GIB * (service.volume ? 3 : 1))
			gauge("railway.memory.limit", "By", 8 * GIB)
			gauge("railway.network.io", "By", 2_000_000 * load, { "network.io.direction": "receive" })
			gauge("railway.network.io", "By", 3_400_000 * load, { "network.io.direction": "transmit" })
			gauge("railway.disk.usage", "By", 0.6 * GIB, { "railway.disk.kind": "ephemeral" })
			if (service.volume && replica === 0)
				gauge("railway.disk.usage", "By", (31 + slot * 0.004) * GIB, {
					"railway.disk.kind": "volume",
				})
		})
	})

const planetscaleSlot = (sink: Sink, orgId: string, slot: number, micros: number) =>
	PS_DATABASES.forEach((database, dbIndex) =>
		database.branches.forEach((branch, branchIndex) => {
			const { gauge } = emitters(sink, orgId, "planetscale", {}, micros)
			const attributes = { planetscale_database_name: database.name, planetscale_branch_name: branch }
			const scale = branchIndex === 0 ? 1 : 0.2
			const load = wave(slot, 120 + dbIndex * 30, dbIndex)
			const connections = Math.round((dbIndex === 0 ? 42 : 12) * scale * (0.5 + load))
			gauge("planetscale_edge_postgres_active_connections", "{connection}", connections, attributes)
			gauge(
				"planetscale_pods_cpu_util_percentages",
				"%",
				(dbIndex === 0 ? 38 : 14) * scale * (0.6 + load),
				attributes,
			)
			gauge(
				"planetscale_pods_mem_util_percentages",
				"%",
				(dbIndex === 0 ? 61 : 33) * (0.9 + 0.1 * load),
				attributes,
			)
			gauge("planetscale_postgres_replica_lag_seconds", "s", 0.05 + 0.4 * load * scale, attributes)
			gauge("planetscale_volume_capacity_bytes", "By", 100 * GIB, attributes)
			gauge(
				"planetscale_volume_available_bytes",
				"By",
				((dbIndex === 0 ? 38 : 81) - slot * 0.002) * GIB,
				attributes,
			)
		}),
	)

/** One value per kept metric label, as the poller would store after Cloud Monitoring's reduction. */
const GCP_LABEL_VALUES = new Map(
	Object.entries({
		response_code_class: "2xx",
		state: "active",
		status: "ok",
		database: "orders",
		source: "heap",
		response_class: "ack",
	} satisfies Record<string, string>),
)

/** Metrics whose unit-based magnitude would read as an incident. */
const GCP_VALUE_OVERRIDES = new Map(
	Object.entries({
		"gcp.cloud_sql.postgresql.deadlocks": () => 0,
		"gcp.cloud_sql.disk.usage": () => 38 * GIB,
		"gcp.cloud_sql.disk.limit": () => 100 * GIB,
		"gcp.cloud_sql.postgresql.temp_file.io": (load) => load * 4_000_000,
	} satisfies Record<string, (load: number) => number>),
)

/** A plausible magnitude per metric unit, scaled by load. */
const gcpValue = (name: string, unit: string, load: number, index: number) => {
	const override = GCP_VALUE_OVERRIDES.get(name)
	if (override !== undefined) return override(load)
	if (unit === "1") return 0.12 + 0.5 * load
	if (unit === "s") return 0.04 + 0.2 * load
	if (unit === "By") return (0.3 + load) * GIB
	return Math.round((index + 1) * 40 * (0.4 + load))
}

const gcpSlot = (sink: Sink, orgId: string, slot: number, micros: number) =>
	GCP_WORKLOADS.forEach((workload, index) => {
		const identity = GCP_INFRA_SOURCES[workload.source].identity
		const resource = Object.fromEntries([
			["cloud.provider", "gcp"],
			...identity.map(([, attribute], key) => [attribute, workload.keys[key] ?? ""]),
		])
		const { gauge, sum } = emitters(
			sink,
			orgId,
			gcpInfraServiceName(workload.source, workload.keys),
			resource,
			micros,
		)
		const load = wave(slot, 90 + index * 17, index)
		const seen = new Set<string>()
		gcpInfraMetrics(workload.source).forEach((metric, metricIndex) => {
			const attributes = {
				...Object.fromEntries(
					metric.labels.map((label) => [
						gcpMetricLabelAttribute(label),
						GCP_LABEL_VALUES.get(label) ?? "default",
					]),
				),
				...metric.attributes,
			}
			const key = `${metric.name}|${JSON.stringify(attributes)}`
			if (seen.has(key)) return
			seen.add(key)
			const value = gcpValue(metric.name, metric.unit, load, metricIndex % 4)
			// Buffer cache hits against disk reads: the page's cache-hit ratio.
			if (metric.name === "gcp.cloud_sql.postgresql.block_reads") {
				const source = gcpMetricLabelAttribute("source")
				sum(metric.name, metric.unit, 9_800 * (0.5 + load), { [source]: "buffer_cache" })
				sum(metric.name, metric.unit, 120 * (0.5 + load), { [source]: "disk" })
			} else if (metric.kind === "sum") sum(metric.name, metric.unit, value, attributes)
			else if (metric.kind === "gauge") gauge(metric.name, metric.unit, value, attributes)
			else
				for (const [quantile, factor] of [
					["0.5", 1],
					["0.95", 1.8],
					["0.99", 2.6],
				] as const)
					gauge(metric.name, metric.unit, value * factor, { ...attributes, quantile })
		})
	})

/** Every integration's series over the 24 h before `now`, one point per 5 minutes. */
export const infraIntegrationsTelemetry = (orgId: string, now: Date): TelemetryRows => {
	const sink: Sink = { gauge: [], sum: [] }
	const nowMicros = now.getTime() * 1000
	Array.from({ length: SLOTS }, (_, slot) => {
		const micros = nowMicros - (SLOTS - 1 - slot) * SLOT_MICROS
		cloudflareSlot(sink, orgId, slot, micros)
		railwaySlot(sink, orgId, slot, micros)
		planetscaleSlot(sink, orgId, slot, micros)
	})
	// Google Cloud series are one point per minute; the pages default to the last hour.
	Array.from({ length: GCP_MINUTES }, (_, minute) =>
		gcpSlot(sink, orgId, minute, nowMicros - (GCP_MINUTES - 1 - minute) * MINUTE_MICROS),
	)
	return { traces: [], logs: [], metrics_gauge: sink.gauge, metrics_sum: sink.sum, metrics_histogram: [] }
}
