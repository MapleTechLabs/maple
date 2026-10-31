import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { compileUnsafe } from "@maple-dev/effect-orm/clickhouse"
import { OrgId } from "@maple/domain"
import { GCP_INFRA_SERVICE_IDS, GCP_INFRA_SOURCE_IDS, gcpInfraMetrics } from "@maple/domain/gcp-infra"
import {
	gcpCloudSqlDatabasesSQL,
	gcpCloudSqlTopQueriesSQL,
	gcpInfraMetricsSQL,
	gcpInfraPresenceSQL,
	gcpInfraSparklinesSQL,
	gcpInfraTimeseriesSQL,
} from "./gcp-infra"

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
			"FROM metrics_sum\n        WHERE metrics_sum.OrgId = 'org_1'\n          AND metrics_sum.MetricName IN ('gcp.cloud_run.requests', 'gcp.cloud_run.container.billable_time')",
		)
		expect(sql).toContain("FROM metrics_gauge\n        WHERE metrics_gauge.OrgId = 'org_1'")
		expect(sql).toContain("'gcp.cloud_run.request.duration', 'gcp.cloud_run.container.instance.count'")
		expect(sql.match(/TimeUnix >= '2026-07-02 00:00:00.000'/g)).toHaveLength(2)
		expect(sql.match(/TimeUnix <= '2026-07-03 00:00:00.000'/g)).toHaveLength(2)
		// oxlint-disable-next-line test-slop/no-sql-text-pin -- the identity key every row groups by
		expect(sql).toContain(
			"[metrics_sum.ResourceAttributes['service.name'], metrics_sum.ResourceAttributes['cloud.account.id'], metrics_sum.ResourceAttributes['cloud.region']] AS keys",
		)
		// The quantile and the metric's own label share one column.
		expect(sql).toContain(
			"arrayStringConcat([metrics_gauge.Attributes['quantile'], metrics_gauge.Attributes['gcp.metric.labels.response_code_class'], metrics_gauge.Attributes['gcp.metric.labels.state']], '') AS label",
		)
	})

	it("reads the direction of a byte counter as its label, and each shared name once", () => {
		const { sql } = compileUnsafe(gcpInfraMetricsSQL("computeEngine"), params)
		expect(sql).toContain(
			"arrayStringConcat([metrics_sum.Attributes['quantile'], metrics_sum.Attributes['network.io.direction'], metrics_sum.Attributes['disk.io.direction']], '') AS label",
		)
		expect(sql).toContain("metrics_sum.MetricName IN ('gcp.gce.network.io', 'gcp.gce.disk.io')")
		expect(sql).toContain("GROUP BY keys, metric, label")
		expect(sql).toContain("LIMIT 10000")
	})

	it("keeps every service to its own metrics and never leaves a branch without one", () => {
		for (const service of GCP_INFRA_SERVICE_IDS) {
			const { sql } = compileUnsafe(gcpInfraMetricsSQL(service), params)
			expect(sql, service).not.toContain("IN ()")
			// Metric names only: `gcp.resource.labels.*` are identity attributes, and
			// `gcp.metric.labels.*` point attributes.
			const names = [...sql.matchAll(/'(gcp\.(?!resource\.|metric\.)[a-z_.]+)'/g)].map(
				(match) => match[1],
			)
			expect(names.sort(), service).toEqual([
				...new Set(
					gcpInfraMetrics(service)
						.map((metric) => metric.name)
						.sort(),
				),
			])
		}
	})

	it("adds PostgreSQL's connections up over an instance's databases, a reading per minute", () => {
		const { sql } = compileUnsafe(gcpInfraMetricsSQL("cloudSql"), params)
		expect(sql).toContain("metrics_gauge.Attributes['gcp.metric.labels.state']")
		// The database is no label of its own: a row's mean is the instance's.
		expect(sql).not.toMatch(/arrayStringConcat\([^)]*gcp\.metric\.labels\.database/)
		expect(sql).toContain(
			"countIf(points.database = '') + uniqIf(points.t, points.database != '') AS samples",
		)
	})

	it("escapes single quotes in orgId", () => {
		const { sql } = compileUnsafe(gcpInfraMetricsSQL("gke"), { ...params, orgId: OrgId.make("org'evil") })
		expect(sql).toContain("OrgId = 'org\\'evil'")
		expect(sql).not.toContain("OrgId = 'org'evil'")
	})

	// A BYO ClickHouse quotes 64-bit integers in JSON: the derived row schema unquotes the count.
	it("decodes a quoted point count to a number", () => {
		const point = { keys: ["api", "acme-prod", "europe-west1"], metric: "gcp.cloud_run.requests" }
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
			expect(sql).toContain(`${table}.ServiceName = 'api'`)
			expect(sql).toContain(`${table}.ResourceAttributes['service.name'] = 'api'`)
			expect(sql).toContain(`${table}.ResourceAttributes['cloud.account.id'] = 'acme-prod'`)
			expect(sql).toContain(`${table}.ResourceAttributes['cloud.region'] = 'europe-west1'`)
		}
		expect(sql).toContain(
			"metrics_sum.MetricName IN ('gcp.cloud_run.requests', 'gcp.cloud_run.container.billable_time')",
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
		expect(sql).toContain("'gcp.gke.node.cpu.allocatable.utilization'")
		// A managed resource's series are stored under its resource type.
		expect(sql).toContain("metrics_gauge.ServiceName = 'gcp/k8s_node'")
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
					metric: "gcp.cloud_run.requests",
					label: "2xx",
					total: 12.5,
					samples: "5",
				},
			]),
		)
		expect(rows[0]).toMatchObject({
			metric: "gcp.cloud_run.requests",
			label: "2xx",
			total: 12.5,
			samples: 5,
		})
	})
})

describe("gcpInfraSparklinesSQL", () => {
	const bucketed = { ...params, bucketSeconds: 3600 }

	it("buckets the volume of every workload of a service, every label value added up", () => {
		const { sql, tenantScope } = compileUnsafe(gcpInfraSparklinesSQL("cloudRun"), bucketed)
		expect(tenantScope).toBe("single-tenant")
		expect(sql).toContain("metrics_sum.OrgId = 'org_1'")
		expect(sql).toContain("metrics_sum.MetricName IN ('gcp.cloud_run.requests')")
		// No gauge is drawn for Cloud Run: that branch reads nothing.
		expect(sql).toContain("metrics_gauge.OrgId = 'org_1'")
		expect(sql).toContain("1 = 0")
		// oxlint-disable-next-line test-slop/no-sql-text-pin -- the identity key every row groups by
		expect(sql).toContain(
			"[metrics_sum.ResourceAttributes['service.name'], metrics_sum.ResourceAttributes['cloud.account.id'], metrics_sum.ResourceAttributes['cloud.region']] AS keys",
		)
		expect(sql).toContain("toStartOfInterval(points.t, INTERVAL 3600 SECOND) AS bucket")
		expect(sql).toContain("GROUP BY keys, bucket, metric")
		expect(sql).not.toContain("label")
		expect(sql).toContain("LIMIT 10000")
	})

	it("reads a Pub/Sub subscription's deliveries and its backlog gauge", () => {
		const { sql } = compileUnsafe(gcpInfraSparklinesSQL("pubsub"), bucketed)
		expect(sql).toContain("metrics_sum.MetricName IN ('gcp.pubsub.subscription.sent_messages')")
		expect(sql).toContain("metrics_gauge.MetricName IN ('gcp.pubsub.subscription.undelivered_messages')")
		expect(sql).not.toContain("1 = 0")
	})

	it("reads a Cloud SQL instance's Query Insights count, stored under the instance", () => {
		const { sql } = compileUnsafe(gcpInfraSparklinesSQL("cloudSql"), bucketed)
		expect(sql).toContain("metrics_sum.MetricName IN ('gcp.cloud_sql.queries')")
		expect(sql).toContain("metrics_sum.ResourceAttributes['gcp.resource.labels.database_id']")
	})

	it("decodes a quoted point count to a number", () => {
		const point = {
			keys: ["orders-fulfil", "acme-prod"],
			bucket: "2026-07-02 01:00:00",
			metric: "gcp.pubsub.subscription.undelivered_messages",
		}
		const rows = Effect.runSync(
			compileUnsafe(gcpInfraSparklinesSQL("pubsub"), bucketed).decodeRows([
				{ ...point, total: 1200, samples: "60" },
			]),
		)
		expect(rows[0]).toMatchObject({ keys: point.keys, metric: point.metric, total: 1200, samples: 60 })
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
			"Hour >= toStartOfInterval(toDateTime('2026-07-02 00:00:00'), INTERVAL 3600 SECOND)",
		)
		expect(sql).toContain("Hour <= '2026-07-03 00:00:00'")
		expect(sql).toContain("GROUP BY metric")
	})
})

const INSTANCE = ["acme-prod:orders-db", "acme-prod", "us-central1"]

describe("gcpCloudSqlTopQueriesSQL", () => {
	it("reads one instance's statements, a row per poll first, then per statement", () => {
		const { sql, tenantScope } = compileUnsafe(gcpCloudSqlTopQueriesSQL(INSTANCE), params)
		expect(tenantScope).toBe("single-tenant")
		for (const table of ["metrics_sum", "metrics_gauge"]) {
			expect(sql).toContain(`${table}.OrgId = 'org_1'`)
			expect(sql).toContain(`${table}.ServiceName = 'gcp/cloudsql_database'`)
			expect(sql).toContain(
				`${table}.ResourceAttributes['gcp.resource.labels.database_id'] = 'acme-prod:orders-db'`,
			)
		}
		expect(sql).toContain("metrics_gauge.MetricName IN ('gcp.cloud_sql.query.statement.duration')")
		// oxlint-disable-next-line test-slop/no-sql-text-pin -- the attribute the statement text is read from
		expect(sql).toContain("metrics_sum.Attributes['db.query.text'] AS statement")
		expect(sql).toContain("GROUP BY hash, t) AS polls")
		expect(sql).toContain("GROUP BY queryHash")
		expect(sql).toContain("ORDER BY executionSeconds DESC, queryHash ASC")
		expect(sql).toContain("LIMIT 25")
	})

	it("weights each poll's p95 by its calls", () => {
		const { sql } = compileUnsafe(gcpCloudSqlTopQueriesSQL(INSTANCE), params)
		expect(sql).toContain(
			"ifNull(ifNotFinite(sum(polls.p95 * polls.callCount) / sum(polls.callCount), 0), 0) AS p95Seconds",
		)
	})

	it("escapes single quotes in an instance", () => {
		const { sql } = compileUnsafe(gcpCloudSqlTopQueriesSQL(["x' OR 1"]), params)
		expect(sql).toContain("= 'x\\' OR 1'")
		expect(sql).not.toContain("= 'x' OR 1'")
	})

	it("decodes quoted sums to numbers", () => {
		const rows = Effect.runSync(
			compileUnsafe(gcpCloudSqlTopQueriesSQL(INSTANCE), params).decodeRows([
				{
					queryHash: "123",
					statement: "select $1",
					calls: "40",
					executionSeconds: 1.5,
					lockSeconds: 0,
					ioSeconds: 0.25,
					rowCount: "800",
					p50Seconds: 0.01,
					p95Seconds: 0.05,
				},
			]),
		)
		expect(rows[0]).toMatchObject({ queryHash: "123", calls: 40, rowCount: 800, p95Seconds: 0.05 })
	})
})

describe("gcpCloudSqlDatabasesSQL", () => {
	it("lists the databases of one instance's PostgreSQL connections", () => {
		const { sql, tenantScope } = compileUnsafe(gcpCloudSqlDatabasesSQL(INSTANCE), params)
		expect(tenantScope).toBe("single-tenant")
		expect(sql).toContain("metrics_gauge.OrgId = 'org_1'")
		expect(sql).toContain("metrics_gauge.MetricName = 'gcp.cloud_sql.postgresql.connection.count'")
		expect(sql).toContain(
			"metrics_gauge.ResourceAttributes['gcp.resource.labels.database_id'] = 'acme-prod:orders-db'",
		)
		expect(sql).toContain("metrics_gauge.Attributes['gcp.metric.labels.database'] != ''")
		expect(sql).toContain("GROUP BY database")
	})
})
