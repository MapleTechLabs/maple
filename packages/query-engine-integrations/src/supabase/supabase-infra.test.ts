import { describe, expect, it } from "vitest"
import { DateTime, Effect } from "effect"
import { compileUnsafe } from "@maple-dev/effect-orm/clickhouse"
import { OrgId } from "@maple/domain"
import {
	supabaseProjectCpuSQL,
	supabaseProjectGaugeSeriesSQL,
	supabaseProjectGaugesSQL,
	supabaseProjectRateSeriesSQL,
} from "./supabase-infra"

const window = {
	orgId: OrgId.make("org_1"),
	startTime: "2026-07-02 00:00:00",
	endTime: "2026-07-03 00:00:00",
}
const project = { ...window, projectRef: "abcdefghijklmnopqrst", bucketSeconds: 300 }

describe("supabaseProjectGaugesSQL", () => {
	const compiled = compileUnsafe(supabaseProjectGaugesSQL(), window)

	it("reads one org's projects by their ref attribute, never by service name", () => {
		expect(compiled.tenantScope).toBe("single-tenant")
		expect(compiled.sql).toContain("metrics_gauge.OrgId = 'org_1'")
		expect(compiled.sql).toContain("metrics_gauge.Attributes['supabase_project_ref'] != ''")
		expect(compiled.sql).not.toContain("ServiceName")
		expect(compiled.sql).toContain("GROUP BY projectRef")
	})

	it("measures disk on the data volume and sizes only the non-template databases", () => {
		expect(compiled.sql).toContain("metrics_gauge.Attributes['mountpoint'] = '/data'")
		expect(compiled.sql).toContain("NOT IN ('template0', 'template1')")
	})

	it("computes memory use as one minus the available share", () => {
		expect(compiled.sql).toContain(
			"avgIf(1 - points.memAvailable / points.memTotal, points.memTotal > 0)",
		)
	})

	it("decodes quoted ClickHouse numerics through the row schema", () => {
		const rows = Effect.runSync(
			compiled.decodeRows([
				{
					projectRef: "abcdefghijklmnopqrst",
					memoryAvg: "0.52",
					memoryMax: "0.61",
					memoryTotal: "426192896",
					diskUsedMax: "0.14",
					diskSize: "2077073408",
					dbSize: "10802867",
					connectionsAvg: "5",
					connectionsMax: "7",
					poolerClientsMax: "2",
					lastSeen: "2026-07-02 12:00:00.000",
				},
			]),
		)
		expect(rows[0]?.memoryTotal).toBe(426192896)
		expect(rows[0]?.lastSeen).toEqual(DateTime.makeUnsafe("2026-07-02T12:00:00Z"))
	})
})

describe("counter rates", () => {
	it("differences each counter series, reset-aware, with lookback before the window", () => {
		const { sql } = compileUnsafe(supabaseProjectCpuSQL(), window)
		expect(sql).toContain("FROM metrics_sum")
		expect(sql).toContain("metrics_sum.OrgId = 'org_1'")
		expect(sql).toContain(
			"lagInFrame(metrics_sum.Value, 1, metrics_sum.Value) OVER (PARTITION BY metrics_sum.MetricName",
		)
		// A drop is a reset: the new value is what accrued since.
		expect(sql).toContain("multiIf(metrics_sum.Value < lagInFrame(")
		expect(sql).toContain("metrics_sum.TimeUnix >= '2026-07-02 00:00:00' - INTERVAL 120 SECOND")
		expect(sql).toContain("WHERE deltas.t >= '2026-07-02 00:00:00'")
	})

	it("derives CPU busy share from idle and total increments", () => {
		const { sql } = compileUnsafe(supabaseProjectCpuSQL(), window)
		expect(sql).toContain("sumIf(deltas.delta, deltas.mode = 'idle') AS idle")
		expect(sql).toContain("greatest(1 - sum(buckets.idle) / sum(buckets.total), 0)")
	})

	it("scopes the project series to its ref and divides increments by the covered seconds", () => {
		const { sql } = compileUnsafe(supabaseProjectRateSeriesSQL(), project)
		expect(sql).toContain("metrics_sum.Attributes['supabase_project_ref'] = 'abcdefghijklmnopqrst'")
		expect(sql).toContain(
			"sumIf(deltas.delta, deltas.metricName = 'pg_stat_database_xact_commit_total') / min(",
		)
		// Cache hit ratio: hits over every block read, in one aggregate so precedence cannot split it.
		expect(sql).toContain(
			"sumIf(deltas.delta, deltas.metricName = 'pg_stat_database_blks_hit_total') / sumIf(deltas.delta, deltas.metricName IN ('pg_stat_database_blks_hit_total', 'pg_stat_database_blks_read_total'))",
		)
		expect(sql).toContain("deltas.device != 'lo'")
	})
})

describe("supabaseProjectGaugeSeriesSQL", () => {
	it("buckets one project's gauges", () => {
		const { sql, tenantScope } = compileUnsafe(supabaseProjectGaugeSeriesSQL(), project)
		expect(tenantScope).toBe("single-tenant")
		expect(sql).toContain("metrics_gauge.Attributes['supabase_project_ref'] = 'abcdefghijklmnopqrst'")
		expect(sql).toContain("toStartOfInterval(points.t, INTERVAL 300 SECOND) AS bucket")
		// The exporter answers -1 when it cannot count users; those samples are not data.
		expect(sql).toContain(
			"metrics_gauge.MetricName = 'auth_users_user_count' AND metrics_gauge.Value >= 0",
		)
		expect(sql).toContain("ORDER BY bucket ASC")
	})
})
