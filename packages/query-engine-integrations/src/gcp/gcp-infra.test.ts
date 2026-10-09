import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { compileUnsafe } from "@maple-dev/effect-orm/clickhouse"
import { OrgId } from "@maple/domain"
import { GCP_INFRA_SERVICE_IDS, GCP_INFRA_SOURCE_IDS, gcpInfraMetrics } from "@maple/domain/gcp-infra"
import { gcpInfraMetricsSQL, gcpInfraPresenceSQL, gcpInfraTimeseriesSQL } from "./gcp-infra"

const params = {
	orgId: OrgId.make("org_1"),
	startTime: "2026-07-02 00:00:00.000",
	endTime: "2026-07-03 00:00:00.000",
}

describe("gcpInfraMetricsSQL", () => {
	it("reads counters and gauges of one service in one grouped query", () => {
		const { sql, tenantScope } = compileUnsafe(gcpInfraMetricsSQL("cloudRun"), params)
		expect(tenantScope).toBe("single-tenant")
		expect(sql).toContain(
			"FROM metrics_sum\n        WHERE metrics_sum.OrgId = 'org_1'\n          AND metrics_sum.MetricName IN ('gcp.run.request_count', 'gcp.run.container.billable_instance_time')",
		)
		expect(sql).toContain("FROM metrics_gauge\n        WHERE metrics_gauge.OrgId = 'org_1'")
		expect(sql).toContain("'gcp.run.request_latencies', 'gcp.run.container.instance_count'")
		expect(sql.match(/TimeUnix >= '2026-07-02 00:00:00.000'/g)).toHaveLength(2)
		expect(sql.match(/TimeUnix <= '2026-07-03 00:00:00.000'/g)).toHaveLength(2)
		expect(sql).toContain(
			"[metrics_sum.ResourceAttributes['service.name'], metrics_sum.ResourceAttributes['cloud.account.id'], metrics_sum.ResourceAttributes['cloud.region']] AS keys",
		)
		// The quantile and the metric's own label share one column.
		expect(sql).toContain(
			"arrayStringConcat([metrics_gauge.Attributes['quantile'], metrics_gauge.Attributes['response_code_class'], metrics_gauge.Attributes['state']], '') AS label",
		)
		expect(sql).toContain("GROUP BY keys, metric, label")
		expect(sql).toContain("LIMIT 10000")
		expect(sql).toContain("FORMAT JSON")
	})

	it("keeps every service to its own metrics and never leaves a branch without one", () => {
		for (const service of GCP_INFRA_SERVICE_IDS) {
			const { sql } = compileUnsafe(gcpInfraMetricsSQL(service), params)
			expect(sql, service).not.toContain("IN ()")
			// Metric names only: `gcp.resource.labels.*` are identity attributes.
			const names = [...sql.matchAll(/'(gcp\.(?!resource\.)[a-z_.]+)'/g)].map((match) => match[1])
			expect(names.sort(), service).toEqual(
				gcpInfraMetrics(service)
					.map((metric) => metric.name)
					.sort(),
			)
		}
	})

	it("escapes single quotes in orgId", () => {
		const { sql } = compileUnsafe(gcpInfraMetricsSQL("gke"), { ...params, orgId: OrgId.make("org'evil") })
		expect(sql).toContain("OrgId = 'org\\'evil'")
		expect(sql).not.toContain("OrgId = 'org'evil'")
	})

	// A BYO ClickHouse quotes 64-bit integers in JSON: the derived row schema unquotes the count.
	it("decodes a quoted point count to a number", () => {
		const point = { keys: ["api", "acme-prod", "europe-west1"], metric: "gcp.run.request_count" }
		const rows = Effect.runSync(
			compileUnsafe(gcpInfraMetricsSQL("cloudRun"), params).decodeRows([
				{ ...point, label: "2xx", total: 12.5, samples: "60" },
			]),
		)
		expect(rows).toEqual([{ ...point, label: "2xx", total: 12.5, samples: 60 }])
	})
})

describe("gcpInfraTimeseriesSQL", () => {
	const bucketed = { ...params, bucketSeconds: 300 }

	it("buckets one workload's counters and gauges, bounded by its identity", () => {
		const { sql, tenantScope } = compileUnsafe(
			gcpInfraTimeseriesSQL("cloudRun", ["api", "acme-prod", "europe-west1"]),
			bucketed,
		)
		expect(tenantScope).toBe("single-tenant")
		for (const table of ["metrics_sum", "metrics_gauge"]) {
			expect(sql).toContain(`${table}.OrgId = 'org_1'`)
			expect(sql).toContain(`${table}.ResourceAttributes['service.name'] = 'api'`)
			expect(sql).toContain(`${table}.ResourceAttributes['cloud.account.id'] = 'acme-prod'`)
			expect(sql).toContain(`${table}.ResourceAttributes['cloud.region'] = 'europe-west1'`)
		}
		expect(sql).toContain(
			"metrics_sum.MetricName IN ('gcp.run.request_count', 'gcp.run.container.billable_instance_time')",
		)
		expect(sql.match(/TimeUnix >= '2026-07-02 00:00:00.000'/g)).toHaveLength(2)
		expect(sql.match(/TimeUnix <= '2026-07-03 00:00:00.000'/g)).toHaveLength(2)
		expect(sql).toContain("toStartOfInterval(points.t, INTERVAL 300 SECOND) AS bucket")
		expect(sql).toContain("GROUP BY bucket, metric, label")
		expect(sql).toContain("LIMIT 10000")
	})

	it("reads the nodes of a cluster, which have no tab", () => {
		const { sql } = compileUnsafe(
			gcpInfraTimeseriesSQL("gkeNodes", ["prod", "acme-prod", "us-central1"]),
			bucketed,
		)
		expect(sql).not.toContain("IN ()")
		expect(sql).toContain("'gcp.kubernetes.node.cpu.allocatable_utilization'")
		expect(sql).toContain("metrics_gauge.ResourceAttributes['k8s.cluster.name'] = 'prod'")
		expect(sql).toContain(
			"metrics_gauge.ResourceAttributes['gcp.resource.labels.location'] = 'us-central1'",
		)
	})

	it("compares every identity attribute of every source, a missing key as empty", () => {
		for (const source of GCP_INFRA_SOURCE_IDS) {
			const { sql } = compileUnsafe(gcpInfraTimeseriesSQL(source, ["only-the-name"]), bucketed)
			expect(sql, source).toContain("= 'only-the-name'")
			expect(sql.match(/ResourceAttributes\['[a-z_.]+'\] = ''/g)?.length ?? 0, source).toBeGreaterThan(
				0,
			)
		}
	})

	it("escapes single quotes in a key", () => {
		const { sql } = compileUnsafe(
			gcpInfraTimeseriesSQL("pubsub", ["orders' OR 1", "acme-prod"]),
			bucketed,
		)
		expect(sql).toContain("= 'orders\\' OR 1'")
		expect(sql).not.toContain("= 'orders' OR 1'")
	})

	it("decodes a quoted point count to a number", () => {
		const rows = Effect.runSync(
			compileUnsafe(gcpInfraTimeseriesSQL("cloudRun", ["api"]), bucketed).decodeRows([
				{
					bucket: "2026-07-02 00:05:00",
					metric: "gcp.run.request_count",
					label: "2xx",
					total: 12.5,
					samples: "5",
				},
			]),
		)
		expect(rows[0]).toMatchObject({
			metric: "gcp.run.request_count",
			label: "2xx",
			total: 12.5,
			samples: 5,
		})
	})
})

describe("gcpInfraPresenceSQL", () => {
	it("probes the hourly catalog for the page's metrics, flooring the start to the hour", () => {
		const { sql, tenantScope } = compileUnsafe(gcpInfraPresenceSQL(), params)
		expect(tenantScope).toBe("single-tenant")
		expect(sql).toContain("FROM metric_catalog")
		expect(sql).toContain("metric_catalog.OrgId = 'org_1'")
		for (const service of GCP_INFRA_SERVICE_IDS) {
			expect(sql, service).toContain(`'${gcpInfraMetrics(service)[0]?.name}'`)
		}
		expect(sql).toContain(
			"Hour >= toStartOfInterval(toDateTime('2026-07-02 00:00:00.000'), INTERVAL 3600 SECOND)",
		)
		expect(sql).toContain("Hour <= '2026-07-03 00:00:00'")
		expect(sql).toContain("GROUP BY metric")
	})
})
