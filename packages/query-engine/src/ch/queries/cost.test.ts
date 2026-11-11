import { describe, expect, it } from "@effect/vitest"
import { String as Str } from "effect"
import { compileUnsafe } from "@maple-dev/effect-orm/clickhouse"
import { OrgId } from "@maple/domain"
import { costBreakdownQuery, costSourceCoverageQuery, costTimeseriesQuery, costTotalsQuery } from "./cost"

// What the queries return is asserted against real rows in
// packages/backend/src/services/warehouse/cost-daily.clickhouse.e2e.test.ts.

const params = {
	orgId: OrgId.make("org_1"),
	previousStartDate: "2026-09-01 00:00:00",
	startDate: "2026-10-01 00:00:00",
	endDate: "2026-10-30 00:00:00",
}

const oneLine = (sql: string): string => Str.replace(/\s+/g, " ")(sql)

describe("cost queries", () => {
	it.each([
		["totals", () => compileUnsafe(costTotalsQuery(), params)],
		["timeseries", () => compileUnsafe(costTimeseriesQuery({ dimension: "region" }), params)],
		["breakdown", () => compileUnsafe(costBreakdownQuery({ dimension: "cloud_service" }), params)],
		["source coverage", () => compileUnsafe(costSourceCoverageQuery(), params)],
	])("%s reads one tenant on the managed route", (_, compiled) => {
		const { tenantScope, route } = compiled()
		expect(tenantScope).toBe("single-tenant")
		expect(route).toBe("ingest")
	})

	it("picks each day's newest pull before a dimension filter can hide one", () => {
		const flat = oneLine(
			compileUnsafe(costTotalsQuery({ values: { region: ["eu-central-1"] } }), params).sql,
		)
		const [, afterJoin = ""] = Str.split("INNER JOIN (SELECT")(flat)
		const [newest] = Str.split(") AS newest")(afterJoin)
		// A pull that no longer has the filtered region must still supersede the one that did.
		expect(newest).toContain("max(cost_daily.IngestedAt) AS ingestedAt")
		expect(newest).not.toContain("Region")
		expect(flat).toContain("cost_daily.Region IN ('eu-central-1')")
	})

	it("escapes a filter value that carries a quote", () => {
		const { sql } = compileUnsafe(
			costTotalsQuery({ values: { cloud_service: ["O'Brien' OR 1=1 --"] } }),
			params,
		)
		expect(oneLine(sql)).toContain("cost_daily.CloudService IN ('O\\'Brien\\' OR 1=1 --')")
	})

	it("does not narrow on an empty value list", () => {
		const { sql } = compileUnsafe(costTotalsQuery({ sourceIds: [], values: { region: [] } }), params)
		expect(sql).not.toContain(" IN (")
	})
})
