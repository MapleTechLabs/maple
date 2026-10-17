import { describe, expect, it } from "vitest"
import { compileUnionUnsafe } from "@maple-dev/effect-orm/clickhouse"
import { OrgId } from "@maple/domain"
import { sourceUsageQuery } from "./source-usage"

const params = {
	orgId: OrgId.make("org_1"),
	sourceId: "src_aXunrkWtzvXSkw9Z2smcft",
	startTime: "2026-10-16 10:00:00",
	endTime: "2026-10-17 10:00:00",
}

describe("sourceUsageQuery", () => {
	it("scopes both branches to the org and source, with the bloom-indexed value candidate", () => {
		const { sql } = compileUnionUnsafe(sourceUsageQuery(), params)
		const branches = sql.split("UNION ALL")

		expect(branches).toHaveLength(2)
		for (const branch of branches) {
			expect(branch).toMatch(/OrgId = 'org_1'/)
			expect(branch).toMatch(
				/has\(mapValues\(\w+\.ResourceAttributes\), 'src_aXunrkWtzvXSkw9Z2smcft'\)/,
			)
			expect(branch).toMatch(/ResourceAttributes\['maple_source_id'\] = 'src_aXunrkWtzvXSkw9Z2smcft'/)
			expect(branch).toContain("GROUP BY hour")
		}
		// Half-open windows: a record at endTime belongs to the next window, not both.
		expect(branches[0]).toMatch(/Timestamp < /)
		expect(branches[0]).not.toMatch(/Timestamp <= /)
		expect(branches[1]).toMatch(/TimestampTime < /)
		expect(branches[1]).not.toMatch(/TimestampTime <= /)
		// Logs must bound the partition column or the read spans every partition.
		expect(branches[1]).toMatch(/logs\.TimestampTime >=/)
	})
})
