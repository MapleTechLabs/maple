import { describe, expect, it } from "@effect/vitest"
import { compileUnsafe } from "@maple-dev/effect-orm/clickhouse"
import { OrgId } from "@maple/domain"
import { CH } from "@maple/query-engine"
import { hostMetricSpec } from "./query-helpers"

const hostGaugeSql = (metric: "cpu" | "memory") => {
	const spec = hostMetricSpec(metric)
	return compileUnsafe(
		CH.hostGaugeTimeseriesQuery({
			hostName: "h",
			metricName: spec.metricName,
			groupByAttributeKey: spec.groupByAttributeKey,
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
	// CPU and memory chart every state as a stacked breakdown.
	it.each(["cpu", "memory"] as const)("keeps every %s state", (metric) => {
		expect(hostGaugeSql(metric)).not.toContain("Attributes['state'] =")
	})
})
