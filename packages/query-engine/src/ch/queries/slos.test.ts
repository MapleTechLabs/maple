import { describe, expect, it } from "vitest"
import { compileUnsafe } from "@maple-dev/effect-orm/clickhouse"
import { OrgId } from "@maple/domain"
import { sloBucketsQuery, sloTotalsQuery, type SloSliQueryOpts } from "./slos"

const params = {
	orgId: OrgId.make("org_1"),
	startTime: "2024-01-01 00:00:30",
	endTime: "2024-01-31 00:00:30",
}

const availability: SloSliQueryOpts = {
	serviceName: "checkout",
	environments: ["production"],
	sli: { _tag: "availability" },
}

const latency: SloSliQueryOpts = {
	serviceName: "checkout",
	environments: [],
	sli: { _tag: "latency", thresholdMs: 250 },
}

describe("sloTotalsQuery", () => {
	it("reads the whole window from raw minutes, minutely partial hours and the hourly interior", () => {
		const { sql } = compileUnsafe(sloTotalsQuery(availability), params)
		expect(sql).toContain("FROM service_overview_spans")
		expect(sql).toContain("FROM service_overview_minutely")
		expect(sql).toContain("FROM service_overview_hourly")
		// Raw spans only for the partial minutes at each end.
		expect(sql).toContain("toStartOfMinute(toDateTime(")
		expect(sql).toContain("ServiceName = 'checkout'")
		expect(sql).toContain("DeploymentEnv IN ('production')")
		expect(sql).toContain("StatusCode != 'Error'")
	})

	it("counts every environment when none is named", () => {
		const { sql } = compileUnsafe(sloTotalsQuery(latency), params)
		expect(sql).not.toContain("DeploymentEnv IN")
	})

	it("counts spans under the threshold as good for a latency SLI", () => {
		const { sql } = compileUnsafe(sloTotalsQuery(latency), params)
		expect(sql).toContain("Duration < 250000000")
		expect(sql).toContain("sum(service_overview_hourly.EstimatedUnder250Ms)")
		// Rollup buckets from before the ladder cover nothing and drop out of the total.
		expect(sql).toContain("sum(service_overview_hourly.EstimatedLadderSpanCount)")
	})
})

describe("sloBucketsQuery", () => {
	it("buckets by hour from raw edges and the hourly rollup only", () => {
		const { sql } = compileUnsafe(sloBucketsQuery(availability, "hour"), {
			...params,
			bucketSeconds: 3600,
		})
		expect(sql).toContain("FROM service_overview_hourly")
		expect(sql).not.toContain("FROM service_overview_minutely")
		expect(sql).toContain("GROUP BY bucket")
	})

	it("buckets sub-hour windows without the hourly rollup", () => {
		const { sql } = compileUnsafe(sloBucketsQuery(availability, "minute"), {
			...params,
			bucketSeconds: 60,
		})
		expect(sql).toContain("FROM service_overview_minutely")
		expect(sql).not.toContain("FROM service_overview_hourly")
	})
})
