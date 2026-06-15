import { describe, expect, it } from "vitest"
import { compileUnion } from "../compile"
import { localIngestPulseQuery } from "./ingest"

const baseParams = {
	orgId: "local",
	startTime: "2024-01-01 00:00:00",
	endTime: "2024-01-01 00:10:00",
}

describe("localIngestPulseQuery", () => {
	it("unions a span and a log probe", () => {
		const q = localIngestPulseQuery()
		const { sql } = compileUnion(q, baseParams)

		// 2 branches → exactly 1 UNION ALL separator.
		expect((sql.match(/UNION ALL/g) || []).length).toBe(1)
		expect(sql).toContain("FROM service_overview_spans")
		expect(sql).toContain("FROM logs")
		expect(sql).toContain("'spans' AS signal")
		expect(sql).toContain("'logs' AS signal")
	})

	it("selects count and a stringified max timestamp per branch", () => {
		const { sql } = compileUnion(localIngestPulseQuery(), baseParams)
		expect(sql).toContain("count() AS count")
		// Stringified so the DateTime (spans) / DateTime64 (logs) branches share a
		// column type across the UNION.
		expect(sql).toContain("toString(max(Timestamp)) AS lastSeen")
		expect(sql).toContain("FORMAT JSON")
	})

	it("scopes every branch by OrgId and the bounded window", () => {
		const { sql } = compileUnion(localIngestPulseQuery(), baseParams)
		expect((sql.match(/OrgId = 'local'/g) || []).length).toBe(2)
		expect(sql).toContain("Timestamp >= '2024-01-01 00:00:00'")
		expect(sql).toContain("Timestamp <= '2024-01-01 00:10:00'")
		// The log branch also carries TimestampTime, the logs partition/index key.
		expect(sql).toContain("TimestampTime >= '2024-01-01 00:00:00'")
		expect(sql).toContain("TimestampTime <= '2024-01-01 00:10:00'")
	})
})
