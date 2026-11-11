import { describe, expect, it } from "@effect/vitest"
import { Effect, Array as Arr, String as Str } from "effect"
import { OrgId } from "@maple/domain"
import { baselineWarehouseCapabilities } from "../capabilities"
import { costBreakdown, costCurrencies, costTimeseries, costTotals } from "./cost"
import { wholeDayWindow } from "./day-window"

const orgId = OrgId.make("org_cost_registry")
const capabilities = baselineWarehouseCapabilities()

// 30 days, entered mid-day on both ends.
const window = {
	startTime: "2026-10-01 09:15:00",
	endTime: "2026-10-30 18:45:00",
	sourceIds: ["source-a", "source-b"],
}

const oneLine = (sql: string): string => Str.replace(/\s+/g, " ")(sql)

describe("wholeDayWindow", () => {
	it("floors both ends to their UTC day and counts them inclusively", () => {
		expect(wholeDayWindow(window)).toMatchObject({
			startDate: "2026-10-01 00:00:00",
			endDate: "2026-10-30 00:00:00",
			previousStartDate: "2026-09-01 00:00:00",
			days: 30,
		})
	})

	it("covers one day when the window starts and ends inside it", () => {
		expect(
			wholeDayWindow({ startTime: "2026-10-05 03:00:00", endTime: "2026-10-05 21:00:00" }),
		).toMatchObject({
			startDate: "2026-10-05 00:00:00",
			endDate: "2026-10-05 00:00:00",
			previousStartDate: "2026-10-04 00:00:00",
			days: 1,
		})
	})
})

describe("cost registry queries", () => {
	it.effect("reads whole days of the org's sources, with the period before for the comparison", () =>
		Effect.gen(function* () {
			const { sql } = yield* costTotals.compile(window, orgId, capabilities)
			const flat = oneLine(sql)
			expect(flat).toContain("cost_daily.OrgId = 'org_cost_registry'")
			expect(flat).toContain("cost_daily.SourceId IN ('source-a', 'source-b')")
			// The scan starts at the previous period; the current one is split off inside it.
			expect(flat).toContain("cost_daily.Date >= '2026-09-01 00:00:00'")
			expect(flat).toContain("cost_daily.Date <= '2026-10-30 00:00:00'")
			expect(flat).toContain("latest.date >= '2026-10-01 00:00:00'")
			expect(flat).toContain("max(cost_daily.BilledCost)")
		}),
	)

	it.effect("passes the metric and the dimension filters through", () =>
		Effect.gen(function* () {
			const { sql } = yield* costTotals.compile(
				{
					...window,
					metric: "effective",
					filters: { region: ["eu-central-1"], cloud_service: ["AmazonEC2", "AmazonS3"] },
				},
				orgId,
				capabilities,
			)
			const flat = oneLine(sql)
			expect(flat).toContain("max(cost_daily.EffectiveCost)")
			expect(flat).toContain("cost_daily.Region IN ('eu-central-1')")
			expect(flat).toContain("cost_daily.CloudService IN ('AmazonEC2', 'AmazonS3')")
		}),
	)

	it.effect("narrows each read of money to the currency it is given", () =>
		Effect.gen(function* () {
			const read = { ...window, currency: "EUR" }
			const compiled = yield* Effect.all([
				costTotals.compile(read, orgId, capabilities),
				costTimeseries.compile({ ...read, groupBy: "region" }, orgId, capabilities),
				costBreakdown.compile({ ...read, groupBy: "region" }, orgId, capabilities),
			])
			expect(
				Arr.map(compiled, ({ sql }) => Str.includes("cost_daily.Currency = 'EUR'")(oneLine(sql))),
			).toEqual([true, true, true])
			const anyCurrency = yield* costTotals.compile(window, orgId, capabilities)
			expect(anyCurrency.sql).not.toContain("cost_daily.Currency =")
		}),
	)

	it.effect("lists the currencies of the window and the period before, over the same rows", () =>
		Effect.gen(function* () {
			const { sql } = yield* costCurrencies.compile(
				{ ...window, metric: "effective", filters: { region: ["eu-central-1"] } },
				orgId,
				capabilities,
			)
			const flat = oneLine(sql)
			expect(flat).toContain("cost_daily.OrgId = 'org_cost_registry'")
			expect(flat).toContain("cost_daily.SourceId IN ('source-a', 'source-b')")
			expect(flat).toContain("cost_daily.Date >= '2026-09-01 00:00:00'")
			expect(flat).toContain("cost_daily.Date <= '2026-10-30 00:00:00'")
			expect(flat).toContain("latest.date >= '2026-10-01 00:00:00'")
			expect(flat).toContain("max(cost_daily.EffectiveCost)")
			expect(flat).toContain("cost_daily.Region IN ('eu-central-1')")
			expect(flat).toContain(
				"GROUP BY currency ORDER BY inWindow DESC, cost DESC, previousCost DESC, currency ASC",
			)
		}),
	)

	it.effect("reads the timeseries over the window alone and folds unnamed keys together", () =>
		Effect.gen(function* () {
			const { sql } = yield* costTimeseries.compile(
				{ ...window, groupBy: "cloud_service", keys: ["AmazonEC2"] },
				orgId,
				capabilities,
			)
			const flat = oneLine(sql)
			expect(flat).toContain("cost_daily.Date >= '2026-10-01 00:00:00'")
			expect(flat).not.toContain("2026-09-01")
			expect(flat).toContain("cost_daily.SourceId IN ('source-a', 'source-b')")
			expect(flat).toContain("IN ('AmazonEC2')")
			expect(flat).toContain("'__other__'")
		}),
	)

	it.effect("orders and cuts the breakdown as asked", () =>
		Effect.gen(function* () {
			const byCost = yield* costBreakdown.compile({ ...window, groupBy: "region" }, orgId, capabilities)
			expect(oneLine(byCost.sql)).toContain("ORDER BY cost DESC, key ASC LIMIT 50")
			const byChange = yield* costBreakdown.compile(
				{ ...window, groupBy: "region", sortBy: "change", limit: 7 },
				orgId,
				capabilities,
			)
			const flat = oneLine(byChange.sql)
			expect(flat).toContain("ORDER BY changeSize DESC, key ASC LIMIT 7")
			expect(flat).toContain("cost_daily.Date >= '2026-09-01 00:00:00'")
		}),
	)
})
