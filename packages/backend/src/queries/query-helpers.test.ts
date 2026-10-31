import { describe, expect, it } from "@effect/vitest"
import { compileUnsafe } from "@maple-dev/effect-orm/clickhouse"
import { OrgId } from "@maple/domain"
import { CH } from "@maple/query-engine"
import { hostMetricSpec } from "./query-helpers"

const hostGaugeSql = (metric: "cpu" | "memory" | "filesystem") => {
	const spec = hostMetricSpec(metric)
	return compileUnsafe(
		CH.hostGaugeTimeseriesQuery({
			hostName: "h",
			metricName: spec.metricName,
			groupByAttributeKey: spec.groupByAttributeKey,
			attributeIn: spec.attributeIn,
			attributeNotIn: spec.attributeNotIn,
		}),
		{
			orgId: OrgId.make("org_1"),
			startTime: "2024-01-01 00:00:00",
			endTime: "2024-01-02 00:00:00",
			bucketSeconds: 60,
		},
	).sql
}

describe("hostMetricSpec", () => {
	// The hostmetrics receiver sends no state; shippers that split by state send
	// used/free/reserved rows, and averaging those shows each disk a third full.
	it("reads filesystem utilization without a state or from the used state", () => {
		const sql = hostGaugeSql("filesystem")
		expect(sql).toContain("Attributes['state'] IN ('used', '')")
		// oxlint-disable-next-line test-slop/no-sql-text-pin -- the per-disk grain
		expect(sql).toContain("Attributes['mountpoint'] AS attributeValue")
		expect(sql).toContain("GROUP BY bucket, attributeValue")
	})

	// CPU and memory chart every state as a stacked breakdown.
	it.each(["cpu", "memory"] as const)("keeps every %s state", (metric) => {
		expect(hostGaugeSql(metric)).not.toContain("Attributes['state'] =")
	})
})
