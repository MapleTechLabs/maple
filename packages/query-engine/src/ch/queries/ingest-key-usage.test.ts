import { describe, expect, it } from "vitest"
import { compileUnionUnsafe } from "@maple-dev/effect-orm/clickhouse"
import { OrgId } from "@maple/domain"
import { ingestKeyUsageQuery } from "./ingest-key-usage"

const params = {
	orgId: OrgId.make("org_1"),
	keyId: "ingk_aXunrkWtzvXSkw9Z2smcft",
	startTime: "2026-10-16 10:00:00",
	endTime: "2026-10-17 10:00:00",
}

describe("ingestKeyUsageQuery", () => {
	it("scopes both branches to the org and key, with the bloom-indexed value candidate", () => {
		const { sql } = compileUnionUnsafe(ingestKeyUsageQuery(), params)
		const branches = sql.split("UNION ALL")

		expect(branches).toHaveLength(2)
		for (const branch of branches) {
			expect(branch).toMatch(/OrgId = 'org_1'/)
			expect(branch).toMatch(
				/has\(mapValues\(\w+\.ResourceAttributes\), 'ingk_aXunrkWtzvXSkw9Z2smcft'\)/,
			)
			expect(branch).toMatch(
				/ResourceAttributes\['maple_ingest_key_id'\] = 'ingk_aXunrkWtzvXSkw9Z2smcft'/,
			)
			expect(branch).toContain("GROUP BY hour")
		}
		// Logs must bound the partition column or the read spans every partition.
		expect(branches[1]).toMatch(/logs\.TimestampTime >=/)
	})
})
