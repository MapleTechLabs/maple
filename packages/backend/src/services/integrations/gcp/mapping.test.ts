import { describe, expect, it } from "vitest"
import { GCP_METRIC_GROUPS, type GcpMetric, type GcpMetricGroup } from "@maple/domain/gcp-metrics"
import type { GcpTimeSeries } from "./api"
import {
	distributionQuantile,
	GCP_SCOPE_NAME,
	gcpResourceAttributes,
	gcpTopKey,
	gcpTopSeries,
	mapGcpResource,
	mapGcpTimeSeries,
	type GcpTopGroup,
} from "./mapping"

const startMs = Date.UTC(2026, 9, 8, 12, 0, 0)
const endMs = startMs + 5 * 60_000
const at = (minutes: number) => new Date(startMs + minutes * 60_000).toISOString()

const find = (type: string): { readonly group: GcpMetricGroup; readonly metric: GcpMetric } => {
	for (const group of GCP_METRIC_GROUPS) {
		const metric = group.metrics.find((candidate) => candidate.type === type)
		if (metric !== undefined) return { group, metric }
	}
	throw new Error(`${type} is not a curated metric`)
}

const map = (type: string, series: ReadonlyArray<GcpTimeSeries>) =>
	mapGcpTimeSeries({ ...find(type), startMs, endMs }, series)

const cloudRun = {
	labels: { project_id: "acme-prod", service_name: "checkout", location: "europe-west4" },
}

describe("mapGcpTimeSeries", () => {
	it("stores a counter as one delta sum per minute, with only the allowlisted labels", () => {
		const { sumRows, gaugeRows } = map("run.googleapis.com/request_count", [
			{
				metric: { labels: { response_code_class: "5xx", response_code: "503" } },
				resource: cloudRun,
				points: [
					{ interval: { endTime: at(2) }, value: { int64Value: "7" } },
					{ interval: { endTime: at(1) }, value: { int64Value: "0" } },
				],
			},
		])
		expect(gaugeRows).toEqual([])
		// The idle minute is not stored.
		expect(sumRows).toHaveLength(1)
		expect(sumRows[0]).toMatchObject({
			metric_name: "gcp.cloud_run.requests",
			metric_unit: "{request}",
			metric_attributes: { "gcp.metric.labels.response_code_class": "5xx" },
			service_name: "checkout",
			scope_name: GCP_SCOPE_NAME,
			value: 7,
			aggregation_temporality: 1,
			is_monotonic: true,
			start_timestamp: "2026-10-08 12:01:00.000",
			timestamp: "2026-10-08 12:02:00.000",
		})
	})

	it("stores a gauge as sampled, zero included", () => {
		const { sumRows, gaugeRows } = map("run.googleapis.com/container/instance_count", [
			{
				metric: { labels: { state: "idle" } },
				resource: cloudRun,
				points: [
					{ interval: { endTime: at(1) }, value: { doubleValue: 0 } },
					{ interval: { endTime: at(2) }, value: { doubleValue: 2.5 } },
				],
			},
		])
		expect(sumRows).toEqual([])
		expect(gaugeRows.map((row) => [row.timestamp, row.start_timestamp, row.value])).toEqual([
			["2026-10-08 12:01:00.000", "2026-10-08 12:01:00.000", 0],
			["2026-10-08 12:02:00.000", "2026-10-08 12:02:00.000", 2.5],
		])
		expect(gaugeRows[0]!.metric_attributes).toEqual({ "gcp.metric.labels.state": "idle" })
	})

	it("keeps the points that end inside (start, end]", () => {
		const { gaugeRows } = map("cloudsql.googleapis.com/database/cpu/utilization", [
			{
				metric: {},
				resource: { labels: { database_id: "acme-prod:main", region: "us-central1" } },
				points: [0, 1, 5, 6].map((minute) => ({
					interval: { endTime: at(minute) },
					value: { doubleValue: minute },
				})),
			},
		])
		expect(gaugeRows.map((row) => row.value)).toEqual([1, 5])
	})

	it("turns a distribution into p50/p95/p99 gauges, in seconds", () => {
		const { gaugeRows } = map("cloudfunctions.googleapis.com/function/execution_times", [
			{
				metric: { labels: { status: "ok" } },
				resource: { labels: { function_name: "resize", region: "us-central1" } },
				points: [
					{
						interval: { endTime: at(1) },
						value: {
							distributionValue: {
								// Finite buckets [0, 100ms), [100ms, 200ms), in nanoseconds.
								bucketOptions: {
									linearBuckets: { numFiniteBuckets: 2, width: 100_000_000 },
								},
								bucketCounts: ["0", "50", "50"],
							},
						},
					},
					// No executions in this minute.
					{ interval: { endTime: at(2) }, value: { distributionValue: {} } },
				],
			},
		])
		expect(gaugeRows.map((row) => [row.metric_attributes, Number(row.value.toFixed(6))])).toEqual([
			[{ quantile: "0.5" }, 0.1],
			[{ quantile: "0.95" }, 0.19],
			[{ quantile: "0.99" }, 0.198],
		])
		expect(gaugeRows[0]).toMatchObject({
			metric_name: "gcp.cloud_functions.execution.duration",
			metric_unit: "s",
			service_name: "resize",
		})
	})

	it("splits a byte counter by direction, and moves the instance name to the resource", () => {
		const series = {
			metric: { labels: { instance_name: "web-1" } },
			resource: {
				labels: { project_id: "acme-prod", instance_id: "8123456789", zone: "europe-west1-b" },
			},
			points: [{ interval: { endTime: at(2) }, value: { int64Value: "2048" } }],
		}
		const [received] = map("compute.googleapis.com/instance/network/received_bytes_count", [
			series,
		]).sumRows
		const [sent] = map("compute.googleapis.com/instance/network/sent_bytes_count", [series]).sumRows
		expect([received, sent].map((row) => [row!.metric_name, row!.metric_attributes])).toEqual([
			["gcp.gce.network.io", { "network.io.direction": "receive" }],
			["gcp.gce.network.io", { "network.io.direction": "transmit" }],
		])
		expect(received!.resource_attributes).toMatchObject({
			"service.name": "web-1",
			"host.name": "web-1",
			"gcp.gce.instance.name": "web-1",
		})
	})

	it("stores Query Insights as the instance, its latency count as queries run", () => {
		const series = {
			metric: {},
			resource: {
				labels: {
					project_id: "acme-prod",
					resource_id: "acme-prod:orders-db",
					location: "us-central1",
				},
			},
			points: [
				{
					interval: { endTime: at(2) },
					value: {
						distributionValue: {
							count: "40",
							// Finite bucket [0, 1000us): every query below a millisecond.
							bucketOptions: { linearBuckets: { numFiniteBuckets: 1, width: 1_000 } },
							bucketCounts: ["0", "40", "0"],
						},
					},
				},
			],
		}
		// Read twice: once for its quantiles, once for its count.
		const latencies = (name: string) => {
			const group = GCP_METRIC_GROUPS.find((one) => one.resourceType === "cloudsql_instance_database")!
			const metric = group.metrics.find((one) => one.name === name)!
			return mapGcpTimeSeries({ group, metric, startMs, endMs }, [series])
		}
		const [queries] = latencies("gcp.cloud_sql.queries").sumRows
		expect(queries).toMatchObject({ metric_name: "gcp.cloud_sql.queries", value: 40 })
		const durations = latencies("gcp.cloud_sql.query.duration").gaugeRows
		expect(durations.map((row) => [row.metric_attributes.quantile, row.value])).toEqual([
			["0.5", 0.0005],
			["0.95", 0.00095],
			["0.99", 0.00099],
		])

		// The same identity as the instance's own metrics.
		const instance = gcpResourceAttributes(
			"cloudsql_database",
			{ project_id: "acme-prod", database_id: "acme-prod:orders-db", region: "us-central1" },
			{},
		)
		for (const key of [
			"service.name",
			"cloud.account.id",
			"cloud.region",
			"gcp.resource.labels.database_id",
		]) {
			expect(queries!.resource_attributes[key], key).toBe(instance[key])
		}
	})

	it("drops a load balancer series that names no URL map", () => {
		const series = (url_map_name: string) => ({
			metric: { labels: { response_code_class: "200" } },
			resource: { labels: { project_id: "acme-prod", url_map_name, backend_target_name: "" } },
			points: [{ interval: { endTime: at(2) }, value: { int64Value: "3" } }],
		})
		const { sumRows } = map("loadbalancing.googleapis.com/https/request_count", [
			series(""),
			series("checkout-lb"),
		])
		expect(sumRows.map((row) => row.resource_attributes["gcp.resource.labels.url_map_name"])).toEqual([
			"checkout-lb",
		])
	})
})

describe("distributionQuantile", () => {
	it("reads exponential and explicit buckets, closing the open-ended ones at their bound", () => {
		// Bucket i covers [scale * growth^(i-1), scale * growth^i): 1-2, 2-4, 4-8.
		const exponential = {
			bucketOptions: { exponentialBuckets: { numFiniteBuckets: 3, growthFactor: 2, scale: 1 } },
			bucketCounts: ["0", "0", "10", "0", "10"],
		}
		expect(distributionQuantile(exponential, 0.25)).toBe(3)
		// The upper half sits in the overflow bucket, which starts at 8.
		expect(distributionQuantile(exponential, 0.99)).toBe(8)

		const explicit = {
			bucketOptions: { explicitBuckets: { bounds: [10, 20] } },
			bucketCounts: ["4", "4"],
		}
		// Underflow bucket: everything below 10.
		expect(distributionQuantile(explicit, 0.5)).toBe(10)
		expect(distributionQuantile(explicit, 0.75)).toBe(15)
		expect(distributionQuantile({}, 0.5)).toBeUndefined()
	})

	it("reads the underflow bucket from zero, as Cloud Monitoring does", () => {
		// A real `run.googleapis.com/request_latencies` point: 25 requests of about 3 ms, all below
		// the first bound of 10 ms. Google's REDUCE_PERCENTILE_50/95/99 answered 5, 9.5 and 9.9.
		const fast = {
			bucketOptions: { exponentialBuckets: { numFiniteBuckets: 135, growthFactor: 1.1, scale: 10 } },
			bucketCounts: ["25"],
		}
		expect(distributionQuantile(fast, 0.5)).toBe(5)
		expect(distributionQuantile(fast, 0.95)).toBe(9.5)
		expect(distributionQuantile(fast, 0.99)).toBeCloseTo(9.9, 10)
	})
})

describe("gcpResourceAttributes", () => {
	it("names compute workloads after the workload, as the log receiver does", () => {
		// The project comes from the series, so a folder or organization scope attributes each one.
		expect(gcpResourceAttributes("cloud_run_revision", cloudRun.labels, {})).toEqual({
			"cloud.provider": "gcp",
			"cloud.account.id": "acme-prod",
			"cloud.platform": "gcp_cloud_run",
			"cloud.region": "europe-west4",
			"gcp.resource.type": "cloud_run_revision",
			"faas.name": "checkout",
			"service.name": "checkout",
			"gcp.resource.labels.project_id": "acme-prod",
			"gcp.resource.labels.service_name": "checkout",
			"gcp.resource.labels.location": "europe-west4",
		})

		const container = gcpResourceAttributes(
			"k8s_container",
			{
				cluster_name: "prod",
				location: "us-central1-a",
				namespace_name: "payments",
				container_name: "api",
			},
			{},
		)
		expect(container).toMatchObject({
			"service.name": "api",
			"cloud.platform": "gcp_kubernetes_engine",
			"cloud.region": "us-central1",
			"cloud.availability_zone": "us-central1-a",
			"k8s.cluster.name": "prod",
			"k8s.namespace.name": "payments",
			"k8s.container.name": "api",
		})

		// The instance name is a metric label on Compute Engine metrics.
		const instance = gcpResourceAttributes(
			"gce_instance",
			{ instance_id: "8123456789", zone: "europe-west1-b" },
			{ instance_name: "web-1" },
		)
		expect(instance).toMatchObject({
			"service.name": "web-1",
			"host.name": "web-1",
			"gcp.gce.instance.name": "web-1",
			"host.id": "8123456789",
			"cloud.platform": "gcp_compute_engine",
			"cloud.availability_zone": "europe-west1-b",
		})
	})

	it("names managed services gcp/<resource type>", () => {
		const database = gcpResourceAttributes(
			"cloudsql_database",
			{ database_id: "acme-prod:main", region: "us-central1" },
			{},
		)
		expect(database["service.name"]).toBe("gcp/cloudsql_database")
		expect(database["cloud.region"]).toBe("us-central1")
		expect(database).not.toHaveProperty("cloud.platform")

		const nodes = gcpResourceAttributes("k8s_node", { cluster_name: "prod" }, {})
		expect(nodes).toMatchObject({ "service.name": "gcp/k8s_node", "k8s.cluster.name": "prod" })
		expect(gcpResourceAttributes("pubsub_topic", { topic_id: "orders" }, {})["service.name"]).toBe(
			"gcp/pubsub_topic",
		)
	})
})

describe("mapGcpResource", () => {
	it("reads the project off the resource name, and a project's id off its attribute", () => {
		expect(
			mapGcpResource({
				name: "//run.googleapis.com/projects/acme-prod/locations/europe-west4/services/checkout",
				assetType: "run.googleapis.com/Service",
				displayName: "checkout",
				location: "europe-west4",
				labels: { team: "payments" },
				createTime: "2026-01-02T03:04:05Z",
				updateTime: "not a time",
			}),
		).toEqual({
			name: "//run.googleapis.com/projects/acme-prod/locations/europe-west4/services/checkout",
			assetType: "run.googleapis.com/Service",
			projectId: "acme-prod",
			location: "europe-west4",
			displayName: "checkout",
			state: null,
			labels: { team: "payments" },
			resourceCreatedAt: Date.UTC(2026, 0, 2, 3, 4, 5),
			resourceUpdatedAt: null,
		})

		const project = mapGcpResource({
			name: "//cloudresourcemanager.googleapis.com/projects/123456789",
			assetType: "cloudresourcemanager.googleapis.com/Project",
			displayName: "Acme production",
			state: "ACTIVE",
			additionalAttributes: { projectId: "acme-prod" },
		})
		expect(project).toMatchObject({ projectId: "acme-prod", state: "ACTIVE", labels: {} })

		expect(
			mapGcpResource({
				name: "//cloudresourcemanager.googleapis.com/folders/42",
				assetType: "cloudresourcemanager.googleapis.com/Folder",
			}),
		).toBeUndefined()
	})

	it("shortens the path Pub/Sub answers as a display name to the resource's own id", () => {
		expect(
			mapGcpResource({
				name: "//pubsub.googleapis.com/projects/acme-prod/topics/orders",
				assetType: "pubsub.googleapis.com/Topic",
				displayName: "projects/acme-prod/topics/orders",
				location: "global",
			}),
		).toMatchObject({ projectId: "acme-prod", displayName: "orders" })
	})
})

describe("gcpTopSeries", () => {
	const statements = GCP_METRIC_GROUPS.find((group) => group.top !== undefined)!
	const group: GcpTopGroup = { ...statements, top: { ...statements.top!, limit: 2 } }
	const series = (instance: string, hash: string, microseconds: number): GcpTimeSeries => ({
		metric: { labels: { query_hash: hash } },
		resource: {
			labels: {
				project_id: "acme-prod",
				resource_id: `acme-prod:${instance}`,
				location: "us-central1",
			},
		},
		points: [{ interval: { endTime: at(5) }, value: { int64Value: String(microseconds) } }],
	})

	it("keeps the items with the largest totals of each resource, and none that ran no time", () => {
		const all = [
			series("orders-db", "a", 10),
			series("orders-db", "b", 30),
			series("orders-db", "c", 20),
			series("billing-db", "a", 5),
			series("billing-db", "idle", 0),
		]
		const kept = gcpTopSeries(group, all)
		expect(
			all
				.filter((item) => kept.has(gcpTopKey(group, item)))
				.map((item) => item.metric.labels?.query_hash),
		).toEqual(["b", "c", "a"])
		// The key is the resource and the item, whichever metric's series it is.
		expect(
			kept.has(
				gcpTopKey(group, {
					...series("billing-db", "a", 1),
					metric: { labels: { query_hash: "a" } },
				}),
			),
		).toBe(true)
	})

	it("stores a point per window, its counter's start at the window's start", () => {
		const metric = statements.metrics.find((candidate) => candidate.name === statements.top!.by)!
		const { sumRows } = mapGcpTimeSeries({ group, metric, startMs, endMs }, [
			{
				...series("orders-db", "a", 2_000_000),
				metric: { labels: { query_hash: "a", querystring: "select $1" } },
			},
		])
		expect(sumRows).toHaveLength(1)
		expect(sumRows[0]).toMatchObject({
			start_timestamp: "2026-10-08 12:00:00.000",
			timestamp: "2026-10-08 12:05:00.000",
			value: 2,
			metric_attributes: { "gcp.metric.labels.query_hash": "a", "db.query.text": "select $1" },
			service_name: "gcp/cloudsql_database",
		})
	})
})
