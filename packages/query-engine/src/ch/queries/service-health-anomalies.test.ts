import { describe, expect, it } from "vitest"
import { serviceHealthAnomalyQuery } from "./service-health-anomalies"

const baseParams = {
	orgId: "org_1",
	startTime: "2026-06-05 12:00:00",
	endTime: "2026-06-05 12:15:00",
	baselineStartTime: "2026-05-08 12:15:00",
	baselineEndTime: "2026-06-05 10:15:00",
	currentHourUtc: 12,
	currentWindowMinutes: 15,
	signalType: "p95_latency" as const,
}

describe("serviceHealthAnomalyQuery", () => {
	it("uses the hourly rollup for the baseline and raw current-window spans only for now", () => {
		const { sql } = serviceHealthAnomalyQuery(baseParams)

		expect(sql).toContain("FROM service_overview_spans AS s")
		expect(sql).toContain("FROM service_health_hourly AS h")
		expect(sql).toContain("WHERE s.OrgId = 'org_1'")
		expect(sql).toContain("WHERE h.OrgId = 'org_1'")
		expect(sql).toContain("s.Timestamp >= toDateTime(start_time)")
		expect(sql).toContain("s.Timestamp < toDateTime(end_time)")
		expect(sql).toContain("h.Hour >= toDateTime(baseline_start_time)")
		expect(sql).toContain("h.Hour < toDateTime(baseline_end_time)")
		expect(sql).toContain("least(abs(toHour(h.Hour) - 12), 24 - abs(toHour(h.Hour) - 12)) <= 2")
		expect(sql).toContain("quantilesTDigestWeightedMerge(0.5, 0.95, 0.99)(DurationQuantiles)")
	})

	it("filters scoped services and exclusions on both current and baseline branches", () => {
		const { sql } = serviceHealthAnomalyQuery({
			...baseParams,
			serviceNames: ["api", "checkout"],
			excludeServiceNames: ["worker"],
		})

		expect(sql).toContain("s.ServiceName IN ('api', 'checkout')")
		expect(sql).toContain("s.ServiceName NOT IN ('worker')")
		expect(sql).toContain("h.ServiceName IN ('api', 'checkout')")
		expect(sql).toContain("h.ServiceName NOT IN ('worker')")
	})
})
