import { describe, expect, it } from "@effect/vitest"
import { Array as Arr, String as Str } from "effect"
import { compileUnsafe } from "@maple-dev/effect-orm/clickhouse"
import { OrgId } from "@maple/domain"
import {
	costBreakdownQuery,
	costCurrenciesQuery,
	costSourceCoverageQuery,
	costTimeseriesQuery,
	costTotalsQuery,
} from "./cost"

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
		["currencies", () => compileUnsafe(costCurrenciesQuery(), params)],
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

	it("does not narrow a dimension on an empty value list", () => {
		const { sql } = compileUnsafe(costTotalsQuery({ values: { region: [] } }), params)
		expect(sql).not.toContain("Region IN")
	})

	it.each([
		["totals", () => compileUnsafe(costTotalsQuery({ currency: "EUR" }), params)],
		[
			"timeseries",
			() => compileUnsafe(costTimeseriesQuery({ currency: "EUR", dimension: "region" }), params),
		],
		[
			"breakdown",
			() => compileUnsafe(costBreakdownQuery({ currency: "EUR", dimension: "region" }), params),
		],
	])("%s keeps one currency, picked after each day's newest pull", (_, compiled) => {
		const flat = oneLine(compiled().sql)
		const [, afterJoin = ""] = Str.split("INNER JOIN (SELECT")(flat)
		const [newest, collapsed = ""] = Str.split(") AS newest")(afterJoin)
		// A pull billed in another currency must still supersede the day's older one.
		expect(newest).not.toContain("Currency")
		expect(collapsed).toContain("cost_daily.Currency = 'EUR'")
	})

	it("escapes a currency that carries a quote", () => {
		const { sql } = compileUnsafe(costTotalsQuery({ currency: "U' OR 1=1 --" }), params)
		expect(oneLine(sql)).toContain("cost_daily.Currency = 'U\\' OR 1=1 --'")
	})

	it("sums any currency without the filter, and only the empty one on an empty string", () => {
		expect(compileUnsafe(costTotalsQuery(), params).sql).not.toContain("cost_daily.Currency =")
		expect(compileUnsafe(costTotalsQuery({ currency: "" }), params).sql).toContain(
			"cost_daily.Currency = ''",
		)
	})

	it("marks the folded rows apart from a value that is named like their key", () => {
		const split = oneLine(
			compileUnsafe(costTimeseriesQuery({ dimension: "cloud_service", keys: ["__other__"] }), params)
				.sql,
		)
		expect(split).toContain("if(latest.cloudService IN ('__other__'), 0, 1) AS other")
		expect(split).toContain("GROUP BY date, key, other ORDER BY date ASC, key ASC, other ASC")
		// Nothing folds without keys to keep, or without a dimension to split by.
		const whole = [
			compileUnsafe(costTimeseriesQuery({ dimension: "cloud_service" }), params).sql,
			compileUnsafe(costTimeseriesQuery({ keys: ["__other__"] }), params).sql,
		]
		expect(Arr.map(whole, (sql) => Str.includes("0 AS other")(oneLine(sql)))).toEqual([true, true])
	})

	it("lists the currencies whatever the dimension filters, those of the window first", () => {
		const flat = oneLine(
			compileUnsafe(costCurrenciesQuery({ values: { region: ["eu-central-1"] } }), params).sql,
		)
		expect(flat).not.toContain("cost_daily.Currency =")
		expect(flat).toContain("cost_daily.Region IN ('eu-central-1')")
		expect(flat).toContain(
			"GROUP BY currency ORDER BY inWindow DESC, cost DESC, previousCost DESC, currency ASC",
		)
	})
})
