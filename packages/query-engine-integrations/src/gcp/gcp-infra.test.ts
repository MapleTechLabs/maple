import { describe, expect, it } from "vitest"
import { compileUnsafe } from "@maple-dev/effect-orm/clickhouse"
import { OrgId } from "@maple/domain"
import { GCP_INFRA_SERVICE_IDS, gcpInfraMetrics } from "@maple/domain/gcp-infra"
import { gcpInfraMetricsSQL, gcpInfraPresenceSQL } from "./gcp-infra"

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
