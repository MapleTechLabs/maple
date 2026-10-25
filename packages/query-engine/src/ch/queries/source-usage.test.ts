import { describe, expect, it } from "vitest"
import { compileUnsafe } from "@maple-dev/effect-orm/clickhouse"
import { OrgId } from "@maple/domain"
import { sourceUsageHourlyQuery, sourceUsageTotalsQuery } from "./source-usage"

const window = {
	orgId: OrgId.make("org_1"),
	startTime: "2026-10-16 10:00:00",
	endTime: "2026-10-17 09:42:00",
}

describe("sourceUsageHourlyQuery", () => {
	it("sums one source's rollup rows per hour inside the org and a half-open window", () => {
		const { sql } = compileUnsafe(sourceUsageHourlyQuery(), {
			...window,
			sourceId: "src_aXunrkWtzvXSkw9Z2smcft",
		})

		expect(sql).toMatch(/FROM source_usage_hourly/)
		expect(sql).toMatch(/OrgId = 'org_1'/)
		expect(sql).toMatch(/SourceId = 'src_aXunrkWtzvXSkw9Z2smcft'/)
		expect(sql).toMatch(/Hour >= /)
		expect(sql).toMatch(/Hour < /)
		expect(sql).not.toMatch(/Hour <= /)
		expect(sql).toMatch(/sum\(\w+\.MetricCount\)/)
		expect(sql).toContain("GROUP BY hour")
	})
})

describe("sourceUsageTotalsQuery", () => {
	it("groups every source of the org, without a source filter", () => {
		const { sql } = compileUnsafe(sourceUsageTotalsQuery(), window)

		expect(sql).toMatch(/FROM source_usage_hourly/)
		expect(sql).toMatch(/OrgId = 'org_1'/)
		expect(sql).not.toMatch(/SourceId = /)
		expect(sql).toContain("GROUP BY sourceId")
	})
})
