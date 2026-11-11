import { assert, describe, it } from "@effect/vitest"
import { DateTime, Array as Arr, String as Str } from "effect"
import type { CostPullRow } from "./CostProvider"
import {
	advanceCostSync,
	batchWholeDays,
	type CostSyncState,
	daysOfWindow,
	historyFloor,
	planCostSync,
	toCostDailyRows,
	toWarehouseDateTime64,
	utcMonth,
	utcToday,
} from "./sync-plan"

const at = (iso: string) => DateTime.toEpochMillis(DateTime.makeUnsafe(iso))
const HOUR_MS = 60 * 60_000
const DAY_MS = 24 * HOUR_MS

const NEW: CostSyncState = {
	watermarkDate: null,
	backfillDate: null,
	lastSyncedAt: null,
	lastSettledAt: null,
}

/**
 * A source that pulled its head and settled `ago` before `now`, with its backfill frontier at
 * `backfillDate`. Its watermark is the day of that head pull, as a real source's is.
 */
const pulled = (
	now: number,
	backfillDate: string,
	ago: { readonly head: number; readonly settle: number },
) => ({
	watermarkDate: utcToday(now - ago.head),
	backfillDate,
	lastSyncedAt: now - ago.head,
	lastSettledAt: now - ago.settle,
})

describe("planCostSync", () => {
	it("first pulls the previous month through today", () => {
		assert.deepStrictEqual(planCostSync(NEW, at("2026-11-11T12:00:00Z")), {
			mode: "settle",
			startDay: "2026-10-01",
			endDay: "2026-11-11",
		})
	})

	it("first pulls December through today in January", () => {
		assert.deepStrictEqual(planCostSync(NEW, at("2027-01-05T00:30:00Z")), {
			mode: "settle",
			startDay: "2026-12-01",
			endDay: "2027-01-05",
		})
	})

	it("takes UTC's day, not the day somewhere west of it", () => {
		const plan = planCostSync(NEW, at("2026-11-01T00:00:00Z"))
		assert.deepStrictEqual(plan, { mode: "settle", startDay: "2026-10-01", endDay: "2026-11-01" })
	})

	it("re-pulls the last four days once the head is a day old", () => {
		const now = at("2026-12-02T06:00:00Z")
		const state = pulled(now, "2026-10-01", { head: DAY_MS, settle: 2 * DAY_MS })
		// Across the month boundary, today included.
		assert.deepStrictEqual(planCostSync(state, now), {
			mode: "head",
			startDay: "2026-11-29",
			endDay: "2026-12-02",
		})
	})

	it("re-pulls a head that was never timed", () => {
		const now = at("2026-11-11T12:00:00Z")
		const state = { ...pulled(now, "2026-10-01", { head: 0, settle: DAY_MS }), lastSyncedAt: null }
		assert.deepStrictEqual(planCostSync(state, now), {
			mode: "head",
			startDay: "2026-11-08",
			endDay: "2026-11-11",
		})
	})

	it("settles both open months through the tenth, and only this month from the eleventh", () => {
		const tenth = at("2026-11-10T23:59:59Z")
		assert.deepStrictEqual(
			planCostSync(pulled(tenth, "2026-10-01", { head: DAY_MS, settle: 7 * DAY_MS }), tenth),
			{ mode: "settle", startDay: "2026-10-01", endDay: "2026-11-10" },
		)
		const eleventh = at("2026-11-11T00:00:00Z")
		assert.deepStrictEqual(
			planCostSync(pulled(eleventh, "2026-10-01", { head: DAY_MS, settle: 7 * DAY_MS }), eleventh),
			{ mode: "settle", startDay: "2026-11-01", endDay: "2026-11-11" },
		)
	})

	it("settles December with January while December is still open", () => {
		const now = at("2027-01-03T09:00:00Z")
		const state = { ...pulled(now, "2026-10-01", { head: 2 * DAY_MS, settle: 0 }), lastSettledAt: null }
		assert.deepStrictEqual(planCostSync(state, now), {
			mode: "settle",
			startDay: "2026-12-01",
			endDay: "2027-01-03",
		})
	})

	it("does not settle while the head is current, however old the last settle is", () => {
		const now = at("2026-11-11T12:00:00Z")
		const state = pulled(now, "2026-10-01", { head: 22 * HOUR_MS, settle: 30 * DAY_MS })
		assert.strictEqual(planCostSync(state, now).mode, "backfill")
	})

	it("is due again at the same hour the next day, though the last pull ended minutes past it", () => {
		const now = at("2026-11-12T03:00:10Z")
		const state = pulled(now, "2026-10-01", { head: DAY_MS - 4 * 60_000, settle: 2 * DAY_MS })
		assert.strictEqual(planCostSync(state, now).mode, "head")
	})

	it("resumes from its watermark after a long hold, leaving no day unpulled", () => {
		const now = at("2026-11-20T03:00:00Z")
		// Held for 40 days: the usual window would start on November 1 and skip most of October.
		const held = pulled(now, "2026-06-01", { head: 40 * DAY_MS, settle: 41 * DAY_MS })
		assert.deepStrictEqual(planCostSync(held, now), {
			mode: "settle",
			startDay: "2026-10-12",
			endDay: "2026-11-20",
		})
		// Never further back than the history floor.
		const ancient = { ...held, watermarkDate: "2024-01-01" }
		assert.deepStrictEqual(planCostSync(ancient, now), {
			mode: "settle",
			startDay: historyFloor("2026-11-20"),
			endDay: "2026-11-20",
		})
	})

	it("backfills the calendar month below the frontier while the head is current", () => {
		const now = at("2026-11-11T12:00:00Z")
		assert.deepStrictEqual(
			planCostSync(pulled(now, "2026-10-01", { head: HOUR_MS, settle: HOUR_MS }), now),
			{
				mode: "backfill",
				startDay: "2026-09-01",
				endDay: "2026-09-30",
			},
		)
		// From January down into the year before, and a February that ends on a leap day.
		assert.deepStrictEqual(
			planCostSync(pulled(now, "2026-01-01", { head: HOUR_MS, settle: HOUR_MS }), now),
			{
				mode: "backfill",
				startDay: "2025-12-01",
				endDay: "2025-12-31",
			},
		)
		const later = at("2028-06-11T12:00:00Z")
		assert.deepStrictEqual(
			planCostSync(pulled(later, "2028-03-01", { head: HOUR_MS, settle: HOUR_MS }), later),
			{ mode: "backfill", startDay: "2028-02-01", endDay: "2028-02-29" },
		)
	})

	it("stops at the first day of the month thirteen months back", () => {
		const now = at("2026-11-11T12:00:00Z")
		const current = { head: HOUR_MS, settle: HOUR_MS }
		assert.deepStrictEqual(planCostSync(pulled(now, "2025-11-01", current), now), {
			mode: "backfill",
			startDay: "2025-10-01",
			endDay: "2025-10-31",
		})
		assert.deepStrictEqual(planCostSync(pulled(now, "2025-10-01", current), now), { mode: "idle" })
		assert.deepStrictEqual(planCostSync(pulled(now, "2025-06-01", current), now), { mode: "idle" })
	})

	it("starts a backfill step at the floor when the month below the frontier reaches under it", () => {
		// The floor moved up to 2025-11-01 with the new month; the frontier sits mid-month above it.
		const now = at("2026-12-05T12:00:00Z")
		assert.deepStrictEqual(
			planCostSync(pulled(now, "2025-11-15", { head: HOUR_MS, settle: HOUR_MS }), now),
			{ mode: "backfill", startDay: "2025-11-01", endDay: "2025-11-14" },
		)
	})

	it("is idle with a current head and no frontier to walk", () => {
		const now = at("2026-11-11T12:00:00Z")
		const state = { ...pulled(now, "2026-10-01", { head: HOUR_MS, settle: HOUR_MS }), backfillDate: null }
		assert.deepStrictEqual(planCostSync(state, now), { mode: "idle" })
	})
})

describe("advanceCostSync", () => {
	const NOW = at("2026-11-11T12:00:00Z")

	it("seeds both frontiers and both clocks from the first settle", () => {
		const step = { mode: "settle", startDay: "2026-10-01", endDay: "2026-11-11" } as const
		assert.deepStrictEqual(advanceCostSync(NEW, step, NOW), {
			watermarkDate: "2026-11-11",
			lastSyncedAt: NOW,
			backfillDate: "2026-10-01",
			lastSettledAt: NOW,
		})
	})

	it("moves the watermark on a head without touching the settle clock or raising the backfill frontier", () => {
		const state = pulled(NOW, "2026-03-01", { head: DAY_MS, settle: DAY_MS })
		const step = { mode: "head", startDay: "2026-11-08", endDay: "2026-11-11" } as const
		assert.deepStrictEqual(advanceCostSync(state, step, NOW), {
			watermarkDate: "2026-11-11",
			lastSyncedAt: NOW,
			backfillDate: "2026-03-01",
		})
	})

	it("lowers the backfill frontier when a settle starts below it", () => {
		const state = pulled(NOW, "2026-11-01", { head: DAY_MS, settle: 7 * DAY_MS })
		const step = { mode: "settle", startDay: "2026-10-01", endDay: "2026-11-10" } as const
		assert.strictEqual(advanceCostSync(state, step, NOW).backfillDate, "2026-10-01")
	})

	it("moves only the backfill frontier on a backfill", () => {
		const state = pulled(NOW, "2026-10-01", { head: HOUR_MS, settle: HOUR_MS })
		const step = { mode: "backfill", startDay: "2026-09-01", endDay: "2026-09-30" } as const
		assert.deepStrictEqual(advanceCostSync(state, step, NOW), { backfillDate: "2026-09-01" })
	})

	it("leads the next plan below the month a backfill just finished", () => {
		const state = pulled(NOW, "2026-10-01", { head: HOUR_MS, settle: HOUR_MS })
		const first = planCostSync(state, NOW)
		assert.strictEqual(first.mode, "backfill")
		if (first.mode !== "backfill") return
		const next = planCostSync({ ...state, ...advanceCostSync(state, first, NOW) }, NOW)
		assert.deepStrictEqual(next, { mode: "backfill", startDay: "2026-08-01", endDay: "2026-08-31" })
	})
})

const pullRow = (day: string, overrides: Partial<CostPullRow> = {}): CostPullRow => ({
	day,
	accountId: "123456789012",
	cloudService: "Amazon Elastic Compute Cloud",
	serviceCategory: "Compute",
	usageType: "BoxUsage:t3.micro",
	region: "us-east-1",
	resourceId: "i-0abc",
	resourceType: "instance",
	serviceName: "checkout",
	chargeCategory: "usage",
	basis: "billed",
	currency: "USD",
	billedCost: 1.25,
	effectiveCost: 1.1,
	listCost: 1.5,
	consumedQuantity: 24,
	consumedUnit: "Hrs",
	tags: { team: "payments" },
	estimated: false,
	...overrides,
})

const CONTEXT = {
	orgId: "org_a",
	sourceId: "0190f2b3-0000-7000-8000-00000000000a",
	provider: "aws",
	ingestedAt: "2026-11-11 12:00:00.000",
} as const

describe("toCostDailyRows", () => {
	it("stamps the org, source, provider and pull version on a provider row", () => {
		const window = { startDay: "2026-11-10", endDay: "2026-11-10" }
		assert.deepStrictEqual(
			toCostDailyRows(CONTEXT, [pullRow("2026-11-10", { estimated: true })], window),
			[
				{
					OrgId: "org_a",
					SourceId: "0190f2b3-0000-7000-8000-00000000000a",
					Provider: "aws",
					AccountId: "123456789012",
					Date: "2026-11-10 00:00:00",
					CloudService: "Amazon Elastic Compute Cloud",
					ServiceCategory: "Compute",
					UsageType: "BoxUsage:t3.micro",
					Region: "us-east-1",
					ResourceId: "i-0abc",
					ResourceType: "instance",
					ServiceName: "checkout",
					ChargeCategory: "usage",
					Basis: "billed",
					Currency: "USD",
					BilledCost: 1.25,
					EffectiveCost: 1.1,
					ListCost: 1.5,
					ConsumedQuantity: 24,
					ConsumedUnit: "Hrs",
					Tags: { team: "payments" },
					Estimated: 1,
					IngestedAt: "2026-11-11 12:00:00.000",
				},
			],
		)
	})

	it("adds one zero row for each day of the window the pull left empty, and none for the others", () => {
		const window = { startDay: "2026-10-30", endDay: "2026-11-02" }
		const rows = toCostDailyRows(
			CONTEXT,
			[pullRow("2026-10-30"), pullRow("2026-10-30", { resourceId: "i-0def" }), pullRow("2026-11-01")],
			window,
		)
		assert.deepStrictEqual(
			Arr.map(rows, (row) => [row.Date, row.ResourceId, row.BilledCost]),
			[
				["2026-10-30 00:00:00", "i-0abc", 1.25],
				["2026-10-30 00:00:00", "i-0def", 1.25],
				["2026-11-01 00:00:00", "i-0abc", 1.25],
				["2026-10-31 00:00:00", "", 0],
				["2026-11-02 00:00:00", "", 0],
			],
		)
		assert.deepStrictEqual(rows[3], {
			OrgId: "org_a",
			SourceId: "0190f2b3-0000-7000-8000-00000000000a",
			Provider: "aws",
			AccountId: "",
			Date: "2026-10-31 00:00:00",
			CloudService: "",
			ServiceCategory: "",
			UsageType: "",
			Region: "",
			ResourceId: "",
			ResourceType: "",
			ServiceName: "",
			ChargeCategory: "none",
			Basis: "billed",
			Currency: "",
			BilledCost: 0,
			EffectiveCost: 0,
			ListCost: 0,
			ConsumedQuantity: 0,
			ConsumedUnit: "",
			Tags: {},
			Estimated: 0,
			IngestedAt: "2026-11-11 12:00:00.000",
		})
	})

	it("marks every day of a window the provider answered nothing for", () => {
		const rows = toCostDailyRows(CONTEXT, [], { startDay: "2026-02-27", endDay: "2026-03-01" })
		assert.deepStrictEqual(
			Arr.map(rows, (row) => row.Date),
			["2026-02-27 00:00:00", "2026-02-28 00:00:00", "2026-03-01 00:00:00"],
		)
	})

	it("does not share a row's tags with the provider's object", () => {
		const tags = { team: "payments" }
		const [row] = toCostDailyRows(CONTEXT, [pullRow("2026-11-10", { tags })], {
			startDay: "2026-11-10",
			endDay: "2026-11-10",
		})
		assert.notStrictEqual(row?.Tags, tags)
		assert.deepStrictEqual(row?.Tags, tags)
	})
})

describe("daysOfWindow", () => {
	it("lists a window's days inclusive, and none when it ends before it starts", () => {
		assert.deepStrictEqual(daysOfWindow({ startDay: "2026-12-31", endDay: "2027-01-01" }), [
			"2026-12-31",
			"2027-01-01",
		])
		assert.deepStrictEqual(daysOfWindow({ startDay: "2026-11-02", endDay: "2026-11-01" }), [])
	})
})

describe("batchWholeDays", () => {
	const window = { startDay: "2026-11-01", endDay: "2026-11-03" }
	const rowsOf = (counts: ReadonlyArray<number>) =>
		toCostDailyRows(
			CONTEXT,
			Arr.flatMap(counts, (count, index) =>
				Arr.makeBy(count, (n) => pullRow(`2026-11-0${index + 1}`, { resourceId: `i-${n}` })),
			),
			window,
		)
	/** Each batch as the day-of-month of its rows, in order. */
	const daysIn = (batches: ReadonlyArray<ReadonlyArray<{ readonly Date: string }>>) =>
		Arr.map(batches, (batch) =>
			Arr.join(
				Arr.map(batch, (row) => Str.slice(8, 10)(row.Date)),
				"",
			),
		)

	it("never puts part of a day in one batch and the rest in the next", () => {
		assert.deepStrictEqual(daysIn(batchWholeDays(rowsOf([2, 2, 2]), 5)), ["01010202", "0303"])
	})

	it("packs days oldest first whatever order the provider returned them in", () => {
		const rows = Arr.reverse(rowsOf([1, 1, 1]))
		assert.deepStrictEqual(daysIn(batchWholeDays(rows, 2)), ["0102", "03"])
	})

	it("splits only a day that is larger than a batch, apart from its neighbours", () => {
		assert.deepStrictEqual(daysIn(batchWholeDays(rowsOf([1, 5, 1]), 2)), [
			"01",
			"0202",
			"0202",
			"02",
			"03",
		])
	})

	it("keeps every row once", () => {
		const rows = rowsOf([3, 4, 2])
		assert.strictEqual(Arr.flatten(batchWholeDays(rows, 4)).length, rows.length)
		assert.deepStrictEqual(batchWholeDays([], 4), [])
	})
})

describe("warehouse and month formats", () => {
	it("writes a pull version as a millisecond UTC literal and a month as YYYY-MM", () => {
		const now = at("2026-12-31T23:59:59.987Z")
		assert.strictEqual(toWarehouseDateTime64(now), "2026-12-31 23:59:59.987")
		assert.strictEqual(utcMonth(now), "2026-12")
		assert.strictEqual(utcMonth(now + 13), "2027-01")
	})
})
