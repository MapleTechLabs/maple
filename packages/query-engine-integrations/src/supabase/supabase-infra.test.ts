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

// The SQL text is pinned by the integrations baseline (`__sql_baseline__/integrations.sql`).

const window = {
	orgId: OrgId.make("org_1"),
	startTime: "2026-07-02 00:00:00",
	endTime: "2026-07-03 00:00:00",
}
const project = { ...window, projectRef: "abcdefghijklmnopqrst", bucketSeconds: 300 }

describe("supabase infra queries", () => {
	it("scope every read to one org", () => {
		expect(compileUnsafe(supabaseProjectGaugesSQL(), window).tenantScope).toBe("single-tenant")
		expect(compileUnsafe(supabaseProjectCpuSQL(), window).tenantScope).toBe("single-tenant")
		expect(compileUnsafe(supabaseProjectGaugeSeriesSQL(), project).tenantScope).toBe("single-tenant")
		expect(compileUnsafe(supabaseProjectRateSeriesSQL(), project).tenantScope).toBe("single-tenant")
	})

	it("decodes quoted ClickHouse numerics in the project rows", () => {
		const compiled = compileUnsafe(supabaseProjectGaugesSQL(), window)
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
					maxConnections: "60",
					lastSeen: "2026-07-02 12:00:00.000",
				},
			]),
		)
		expect(rows[0]?.memoryTotal).toBe(426192896)
		expect(rows[0]?.maxConnections).toBe(60)
		expect(rows[0]?.lastSeen).toEqual(DateTime.makeUnsafe("2026-07-02T12:00:00Z"))
	})

	it("keeps a bucket without block reads as a null cache hit ratio", () => {
		const compiled = compileUnsafe(supabaseProjectRateSeriesSQL(), project)
		const rate = (cacheHitRatio: string | null) => ({
			bucket: "2026-07-02 12:00:00",
			cpu: "0.2",
			commitsPerSecond: "1.5",
			rollbacksPerSecond: "0",
			cacheHitRatio,
			networkRxPerSecond: "10",
			networkTxPerSecond: "20",
			diskReadPerSecond: "0",
			diskWritePerSecond: "30",
		})
		const rows = Effect.runSync(compiled.decodeRows([rate("0.99"), rate(null)]))
		expect(rows.map((row) => row.cacheHitRatio)).toEqual([0.99, null])
	})
})
