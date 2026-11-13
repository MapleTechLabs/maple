import { assert, describe, it } from "@effect/vitest"
import { DateTime, Option, Array as Arr, String as Str } from "effect"
import type { CostPullRow } from "./CostProvider"
import {
	advanceCostSync,
	BACKFILL_REQUEST_BUDGET,
	batchWholeDays,
	type CostSyncState,
	daysOfWindow,
	historyFloor,
	MONTHLY_REQUEST_BUDGET,
	nextMonthStartMs,
	oversizedDay,
	planCostSync,
	toCostDailyRows,
	toWarehouseDateTime64,
	utcMonth,
	utcToday,
	monthStart,
} from "./sync-plan"

const at = (iso: string) => DateTime.toEpochMillis(DateTime.makeUnsafe(iso))
const HOUR_MS = 60 * 60_000
const DAY_MS = 24 * HOUR_MS

const NEW: CostSyncState = {
	provider: "aws",
	watermarkDate: null,
	backfillDate: null,
	lastSyncedAt: null,
	lastSettledAt: null,
	requestsMonth: null,
	requestsCount: 0,
}

/**
 * A source that pulled its head and settled `ago` before `now`, with its backfill frontier at
 * `backfillDate`. Its watermark is the day of that head pull, as a real source's is.
 */
const pulled = (
	now: number,
	backfillDate: string,
	ago: { readonly head: number; readonly settle: number },
): CostSyncState => ({
	provider: "aws",
	watermarkDate: utcToday(now - ago.head),
	backfillDate,
	lastSyncedAt: now - ago.head,
	lastSettledAt: now - ago.settle,
	requestsMonth: null,
	requestsCount: 0,
})

/** `state` after `count` billable requests in the UTC month of `now`. */
const billed = (state: CostSyncState, now: number, count: number): CostSyncState => ({
	...state,
	requestsMonth: utcMonth(now),
	requestsCount: count,
})

describe("monthStart", () => {
	it.each([
		// From the last day of a long month into a shorter one: never the day after it ends.
		["2026-03-31", -1, "2026-02-01"],
		["2024-03-31", -1, "2024-02-01"],
		["2026-05-31", -1, "2026-04-01"],
		["2026-01-31", -1, "2025-12-01"],
		["2026-12-31", -13, "2025-11-01"],
		["2026-03-29", 0, "2026-03-01"],
	])("is the first day of the month %s months from %s", (day, months, expected) => {
		assert.strictEqual(monthStart(day, months), expected)
	})
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

	it("settles both open months through the tenth", () => {
		const tenth = at("2026-11-10T23:59:59Z")
		assert.deepStrictEqual(
			planCostSync(pulled(tenth, "2026-10-01", { head: DAY_MS, settle: 7 * DAY_MS }), tenth),
			{ mode: "settle", startDay: "2026-10-01", endDay: "2026-11-10" },
		)
	})

	it("settles the previous month once more after it closed, then only this month", () => {
		// Last settled on the 4th, while October was still open: the 12th takes October again.
		const twelfth = at("2026-11-12T03:00:00Z")
		assert.deepStrictEqual(
			planCostSync(pulled(twelfth, "2026-06-01", { head: DAY_MS, settle: 8 * DAY_MS }), twelfth),
			{ mode: "settle", startDay: "2026-10-01", endDay: "2026-11-12" },
		)
		// That settle was after the 10th, so the next one leaves October alone.
		const nineteenth = at("2026-11-19T03:00:00Z")
		assert.deepStrictEqual(
			planCostSync(pulled(nineteenth, "2026-06-01", { head: DAY_MS, settle: 7 * DAY_MS }), nineteenth),
			{ mode: "settle", startDay: "2026-11-01", endDay: "2026-11-19" },
		)
	})

	it("counts a settle as after the close from the first moment of the eleventh", () => {
		const now = at("2026-11-18T12:00:00Z")
		const state = pulled(now, "2026-06-01", { head: DAY_MS, settle: 0 })
		const settledAt = (iso: string) => planCostSync({ ...state, lastSettledAt: at(iso) }, now)
		assert.deepStrictEqual(settledAt("2026-11-10T23:59:59Z"), {
			mode: "settle",
			startDay: "2026-10-01",
			endDay: "2026-11-18",
		})
		assert.deepStrictEqual(settledAt("2026-11-11T00:00:00Z"), {
			mode: "settle",
			startDay: "2026-11-01",
			endDay: "2026-11-18",
		})
	})

	it("settles December once more in mid January, then only January", () => {
		const twelfth = at("2027-01-12T03:00:00Z")
		assert.deepStrictEqual(
			planCostSync(pulled(twelfth, "2026-06-01", { head: DAY_MS, settle: 8 * DAY_MS }), twelfth),
			{ mode: "settle", startDay: "2026-12-01", endDay: "2027-01-12" },
		)
		const nineteenth = at("2027-01-19T03:00:00Z")
		assert.deepStrictEqual(
			planCostSync(pulled(nineteenth, "2026-06-01", { head: DAY_MS, settle: 7 * DAY_MS }), nineteenth),
			{ mode: "settle", startDay: "2027-01-01", endDay: "2027-01-19" },
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

	it("resumes a month before its watermark's after a long hold, so no day keeps a pre-final amount", () => {
		const now = at("2026-11-20T03:00:00Z")
		// Last pulled on September 21, with September still open and August perhaps too. The usual
		// window starts on October 1; from September 22 on, September 1 to 21 would never be final.
		const held = pulled(now, "2026-06-01", { head: 60 * DAY_MS, settle: 61 * DAY_MS })
		assert.strictEqual(held.watermarkDate, "2026-09-21")
		assert.deepStrictEqual(planCostSync(held, now), {
			mode: "settle",
			startDay: "2026-08-01",
			endDay: "2026-11-20",
		})
		// Never further back than the history floor.
		const ancient = { ...held, watermarkDate: "2024-01-01" }
		assert.deepStrictEqual(planCostSync(ancient, now), {
			mode: "settle",
			startDay: historyFloor("aws", "2026-11-20"),
			endDay: "2026-11-20",
		})
		// A month before the watermark's that reaches under the floor starts at the floor.
		const nearFloor = { ...held, watermarkDate: "2025-10-15" }
		assert.deepStrictEqual(
			[historyFloor("aws", "2026-11-20"), planCostSync(nearFloor, now)],
			["2025-10-01", { mode: "settle", startDay: "2025-10-01", endDay: "2026-11-20" }],
		)
	})

	it("keeps the usual four day head while the watermark reaches it, and widens one day past it", () => {
		const now = at("2026-11-20T03:00:00Z")
		const headAfter = (days: number) =>
			pulled(now, "2026-06-01", { head: days * DAY_MS, settle: days * DAY_MS })
		// Pulled yesterday, and four days ago: the day after the watermark is the head's first day.
		assert.deepStrictEqual(
			[planCostSync(headAfter(1), now), headAfter(4).watermarkDate, planCostSync(headAfter(4), now)],
			[
				{ mode: "head", startDay: "2026-11-17", endDay: "2026-11-20" },
				"2026-11-16",
				{ mode: "head", startDay: "2026-11-17", endDay: "2026-11-20" },
			],
		)
		// Five days ago: November 16 is in no head, so October and November are pulled whole.
		assert.deepStrictEqual(
			[headAfter(5).watermarkDate, planCostSync(headAfter(5), now)],
			["2026-11-15", { mode: "head", startDay: "2026-10-01", endDay: "2026-11-20" }],
		)
	})

	it("keeps the usual settle window while the watermark reaches it", () => {
		const now = at("2026-11-20T03:00:00Z")
		// A week since the last settle, a day since the head: November alone, as with no gap at all.
		const settled = pulled(now, "2026-06-01", { head: DAY_MS, settle: 7 * DAY_MS })
		assert.deepStrictEqual(planCostSync(settled, now), {
			mode: "settle",
			startDay: "2026-11-01",
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

describe("planCostSync for a provider that serves 30 completed days", () => {
	const OPENROUTER_NEW: CostSyncState = { ...NEW, provider: "openrouter" }
	const openRouterPulled = (
		now: number,
		backfillDate: string,
		ago: { readonly head: number; readonly settle: number },
	): CostSyncState => ({
		...pulled(now, backfillDate, ago),
		provider: "openrouter",
		// The newest day it serves is the day before the pull.
		watermarkDate: utcToday(now - ago.head - DAY_MS),
	})

	it("starts 28 days back and ends yesterday, not at the previous month's start and today", () => {
		const now = at("2026-11-20T12:00:00Z")
		assert.deepStrictEqual(planCostSync(OPENROUTER_NEW, now), {
			mode: "settle",
			startDay: "2026-10-23",
			endDay: "2026-11-19",
		})
	})

	it("takes the four newest served days as its head", () => {
		const now = at("2026-11-20T12:00:00Z")
		const state = openRouterPulled(now, "2026-10-22", { head: DAY_MS, settle: 2 * DAY_MS })
		assert.deepStrictEqual(planCostSync(state, now), {
			mode: "head",
			startDay: "2026-11-16",
			endDay: "2026-11-19",
		})
	})

	it("never settles below its floor, though the open month starts before it", () => {
		const now = at("2026-12-05T12:00:00Z")
		const state = openRouterPulled(now, "2026-10-22", { head: DAY_MS, settle: 8 * DAY_MS })
		assert.deepStrictEqual(planCostSync(state, now), {
			mode: "settle",
			startDay: "2026-11-07",
			endDay: "2026-12-04",
		})
	})

	it("has no history to walk once its first pull reached the floor", () => {
		const now = at("2026-11-20T12:00:00Z")
		const state = openRouterPulled(now, "2026-10-23", { head: HOUR_MS, settle: HOUR_MS })
		assert.deepStrictEqual(planCostSync(state, now), { mode: "idle" })
	})

	it("resumes at the floor after a hold longer than what the provider serves", () => {
		const now = at("2026-11-20T12:00:00Z")
		const state = openRouterPulled(now, "2026-08-01", { head: 40 * DAY_MS, settle: 40 * DAY_MS })
		assert.deepStrictEqual(planCostSync(state, now), {
			mode: "settle",
			startDay: "2026-10-23",
			endDay: "2026-11-19",
		})
	})
})

describe("planCostSync for a provider that serves a year of completed days", () => {
	const CLOUDFLARE_NEW: CostSyncState = { ...NEW, provider: "cloudflare" }
	const cloudflarePulled = (
		now: number,
		backfillDate: string,
		ago: { readonly head: number; readonly settle: number },
	): CostSyncState => ({
		...pulled(now, backfillDate, ago),
		provider: "cloudflare",
		// The newest day it serves is the day before the pull.
		watermarkDate: utcToday(now - ago.head - DAY_MS),
	})

	it("starts at the previous month and ends yesterday", () => {
		const now = at("2026-11-20T12:00:00Z")
		assert.deepStrictEqual(planCostSync(CLOUDFLARE_NEW, now), {
			mode: "settle",
			startDay: "2026-10-01",
			endDay: "2026-11-19",
		})
	})

	it("takes the four newest served days as its head", () => {
		const now = at("2026-11-20T12:00:00Z")
		const state = cloudflarePulled(now, "2026-10-01", { head: DAY_MS, settle: 2 * DAY_MS })
		assert.deepStrictEqual(planCostSync(state, now), {
			mode: "head",
			startDay: "2026-11-16",
			endDay: "2026-11-19",
		})
	})

	it("walks history a month per step down to the eleventh month back, and no further", () => {
		const now = at("2026-11-20T12:00:00Z")
		const current = { head: HOUR_MS, settle: HOUR_MS }
		assert.strictEqual(historyFloor("cloudflare", "2026-11-20"), "2025-12-01")
		assert.deepStrictEqual(planCostSync(cloudflarePulled(now, "2026-01-01", current), now), {
			mode: "backfill",
			startDay: "2025-12-01",
			endDay: "2025-12-31",
		})
		assert.deepStrictEqual(planCostSync(cloudflarePulled(now, "2025-12-01", current), now), {
			mode: "idle",
		})
	})

	it("keeps its floor inside the year Cloudflare serves on every day of a month", () => {
		// One year back from the pull is the oldest day served: the floor is never before it.
		assert.isTrue(historyFloor("cloudflare", "2026-11-01") >= "2025-11-01")
		assert.isTrue(historyFloor("cloudflare", "2026-11-30") >= "2025-11-30")
		assert.strictEqual(historyFloor("cloudflare", "2027-01-31"), "2026-02-01")
	})

	it("resumes at the floor after a hold longer than what the provider serves", () => {
		const now = at("2026-11-20T12:00:00Z")
		const state = cloudflarePulled(now, "2025-01-01", { head: 500 * DAY_MS, settle: 500 * DAY_MS })
		assert.deepStrictEqual(planCostSync(state, now), {
			mode: "settle",
			startDay: "2025-12-01",
			endDay: "2026-11-19",
		})
	})
})

describe("planCostSync for a provider that bills by the month, a year back", () => {
	const PLANETSCALE_NEW: CostSyncState = { ...NEW, provider: "planetscale" }
	const planetScalePulled = (
		now: number,
		backfillDate: string,
		ago: { readonly head: number; readonly settle: number },
	): CostSyncState => ({ ...pulled(now, backfillDate, ago), provider: "planetscale" })

	it("first pulls the previous month's invoice and the open month through today", () => {
		assert.deepStrictEqual(planCostSync(PLANETSCALE_NEW, at("2026-11-12T12:00:00Z")), {
			mode: "settle",
			startDay: "2026-10-01",
			endDay: "2026-11-12",
		})
	})

	it("takes the whole open month as its head: a new line changes the share of every day of it", () => {
		const now = at("2026-11-12T12:00:00Z")
		const state = planetScalePulled(now, "2026-10-01", { head: DAY_MS, settle: 2 * DAY_MS })
		assert.deepStrictEqual(planCostSync(state, now), {
			mode: "head",
			startDay: "2026-11-01",
			endDay: "2026-11-12",
		})
	})

	it("keeps the closed month in its head through the tenth: a branch deleted on its last day is discounted after", () => {
		const first = at("2026-12-01T12:00:00Z")
		assert.deepStrictEqual(
			planCostSync(planetScalePulled(first, "2026-10-01", { head: DAY_MS, settle: 2 * DAY_MS }), first),
			{ mode: "head", startDay: "2026-11-01", endDay: "2026-12-01" },
		)
		const tenth = at("2026-12-10T12:00:00Z")
		assert.deepStrictEqual(
			planCostSync(planetScalePulled(tenth, "2026-10-01", { head: DAY_MS, settle: 2 * DAY_MS }), tenth),
			{ mode: "head", startDay: "2026-11-01", endDay: "2026-12-10" },
		)
		// From the eleventh the closed month is the settle's, which takes it once more.
		const eleventh = at("2026-12-11T12:00:00Z")
		assert.deepStrictEqual(
			planCostSync(
				planetScalePulled(eleventh, "2026-10-01", { head: DAY_MS, settle: 2 * DAY_MS }),
				eleventh,
			),
			{ mode: "head", startDay: "2026-12-01", endDay: "2026-12-11" },
		)
		assert.deepStrictEqual(
			planCostSync(
				planetScalePulled(eleventh, "2026-10-01", { head: DAY_MS, settle: 8 * DAY_MS }),
				eleventh,
			),
			{ mode: "settle", startDay: "2026-11-01", endDay: "2026-12-11" },
		)
	})

	it("takes the month before the watermark's when pulls stopped over a month end before it closed", () => {
		// October was last settled on November 2, still open. Pulls failed from the 9th to December 2.
		const now = at("2026-12-03T12:00:00Z")
		const stalled: CostSyncState = {
			...PLANETSCALE_NEW,
			watermarkDate: "2026-11-08",
			backfillDate: "2026-09-01",
			lastSyncedAt: at("2026-11-08T12:00:00Z"),
			lastSettledAt: at("2026-11-02T12:00:00Z"),
		}
		// The watermark is inside the usual start, so no gap is seen: October would keep what
		// November 2 saw of it.
		assert.deepStrictEqual(planCostSync(stalled, now), {
			mode: "settle",
			startDay: "2026-10-01",
			endDay: "2026-12-03",
		})
		// Settled after October closed, the same stall leaves October alone.
		assert.deepStrictEqual(planCostSync({ ...stalled, lastSettledAt: at("2026-11-11T00:00:00Z") }, now), {
			mode: "settle",
			startDay: "2026-11-01",
			endDay: "2026-12-03",
		})
		// A provider whose head is its trailing days plans as before.
		assert.deepStrictEqual(planCostSync({ ...stalled, provider: "aws" }, now), {
			mode: "settle",
			startDay: "2026-11-01",
			endDay: "2026-12-03",
		})
	})

	it("never reaches under its floor for the month before the watermark's", () => {
		const now = at("2026-12-03T12:00:00Z")
		const stalled: CostSyncState = {
			...PLANETSCALE_NEW,
			watermarkDate: "2025-12-20",
			backfillDate: "2025-12-01",
			lastSyncedAt: at("2025-12-20T12:00:00Z"),
			lastSettledAt: at("2025-12-05T12:00:00Z"),
		}
		assert.deepStrictEqual(planCostSync(stalled, now), {
			mode: "settle",
			startDay: "2025-12-01",
			endDay: "2026-12-03",
		})
	})

	it("walks history one invoice at a time and stops at the month twelve months back", () => {
		const now = at("2026-11-12T12:00:00Z")
		assert.strictEqual(historyFloor("planetscale", utcToday(now)), "2025-11-01")
		assert.deepStrictEqual(
			planCostSync(planetScalePulled(now, "2026-10-01", { head: HOUR_MS, settle: HOUR_MS }), now),
			{ mode: "backfill", startDay: "2026-09-01", endDay: "2026-09-30" },
		)
		assert.deepStrictEqual(
			planCostSync(planetScalePulled(now, "2025-11-01", { head: HOUR_MS, settle: HOUR_MS }), now),
			{ mode: "idle" },
		)
	})

	it("resumes at its floor after a hold of more than a year", () => {
		const now = at("2026-11-12T12:00:00Z")
		const state: CostSyncState = {
			...planetScalePulled(now, "2025-01-01", { head: 400 * DAY_MS, settle: 400 * DAY_MS }),
			watermarkDate: "2025-10-08",
		}
		assert.deepStrictEqual(planCostSync(state, now), {
			mode: "settle",
			startDay: "2025-11-01",
			endDay: "2026-11-12",
		})
	})
})

describe("planCostSync request budgets", () => {
	const now = at("2026-11-11T12:00:00Z")
	const current = { head: HOUR_MS, settle: HOUR_MS }
	const walking = pulled(now, "2026-10-01", current)
	const headDue = pulled(now, "2026-10-01", { head: DAY_MS, settle: 2 * DAY_MS })

	it("stops walking history at the backfill budget, not one request under it", () => {
		assert.strictEqual(
			planCostSync(billed(walking, now, BACKFILL_REQUEST_BUDGET - 1), now).mode,
			"backfill",
		)
		assert.deepStrictEqual(planCostSync(billed(walking, now, BACKFILL_REQUEST_BUDGET), now), {
			mode: "idle",
			budget: "backfill",
		})
	})

	it("still pulls the head and settles past the backfill budget", () => {
		assert.deepStrictEqual(planCostSync(billed(headDue, now, BACKFILL_REQUEST_BUDGET + 200), now), {
			mode: "head",
			startDay: "2026-11-08",
			endDay: "2026-11-11",
		})
	})

	it("names no budget when history is done anyway", () => {
		const done = pulled(now, historyFloor("aws", "2026-11-11"), current)
		assert.deepStrictEqual(planCostSync(billed(done, now, BACKFILL_REQUEST_BUDGET), now), {
			mode: "idle",
		})
	})

	it("pulls nothing at the monthly budget: no first pull, no head, no history", () => {
		const held = { mode: "idle", budget: "monthly" }
		assert.deepStrictEqual(planCostSync(billed(NEW, now, MONTHLY_REQUEST_BUDGET), now), held)
		assert.deepStrictEqual(planCostSync(billed(headDue, now, MONTHLY_REQUEST_BUDGET), now), held)
		assert.deepStrictEqual(planCostSync(billed(walking, now, MONTHLY_REQUEST_BUDGET + 1), now), held)
		assert.strictEqual(planCostSync(billed(headDue, now, MONTHLY_REQUEST_BUDGET - 1), now).mode, "head")
	})

	it("starts both budgets over with the next UTC month", () => {
		const december = nextMonthStartMs(now)
		assert.strictEqual(december, at("2026-12-01T00:00:00Z"))
		const spent = billed(walking, now, MONTHLY_REQUEST_BUDGET)
		// The count is November's: in December the head is due again and history may walk.
		assert.strictEqual(planCostSync(spent, december).mode, "settle")
		assert.strictEqual(
			planCostSync({ ...spent, lastSyncedAt: december - HOUR_MS }, december).mode,
			"backfill",
		)
		assert.strictEqual(nextMonthStartMs(at("2026-12-31T23:59:59Z")), at("2027-01-01T00:00:00Z"))
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
			toCostDailyRows(CONTEXT, [pullRow("2026-11-10", { estimated: true })], window).rows,
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
		const { rows } = toCostDailyRows(
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
		const { rows } = toCostDailyRows(CONTEXT, [], { startDay: "2026-02-27", endDay: "2026-03-01" })
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
		}).rows
		assert.notStrictEqual(row?.Tags, tags)
		assert.deepStrictEqual(row?.Tags, tags)
	})

	it("drops rows of days outside the window, counts them, and marks a day left empty by it", () => {
		const { rows, outsideWindow } = toCostDailyRows(
			CONTEXT,
			[
				pullRow("2026-11-09", { resourceId: "i-before" }),
				pullRow("2026-11-10"),
				pullRow("2026-11-12", { resourceId: "i-after" }),
				pullRow("2026-11-12", { resourceId: "i-after-2" }),
			],
			{ startDay: "2026-11-10", endDay: "2026-11-11" },
		)
		assert.strictEqual(outsideWindow, 3)
		assert.deepStrictEqual(
			Arr.map(rows, (row) => [row.Date, row.ResourceId, row.ChargeCategory]),
			[
				["2026-11-10 00:00:00", "i-0abc", "usage"],
				["2026-11-11 00:00:00", "", "none"],
			],
		)
	})

	it("counts nothing outside a window the pull kept to", () => {
		const window = { startDay: "2026-11-10", endDay: "2026-11-11" }
		assert.strictEqual(
			toCostDailyRows(CONTEXT, [pullRow("2026-11-10"), pullRow("2026-11-11")], window).outsideWindow,
			0,
		)
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

	it("counts the days to the last one a four-digit year holds, where the day after sorts before it", () => {
		assert.deepStrictEqual(daysOfWindow({ startDay: "9999-12-30", endDay: "9999-12-31" }), [
			"9999-12-30",
			"9999-12-31",
		])
		assert.deepStrictEqual(daysOfWindow({ startDay: "9999-12-31", endDay: "9999-12-31" }), ["9999-12-31"])
		// 2024 is a leap year: 366 days, each once.
		const year = daysOfWindow({ startDay: "2024-01-01", endDay: "2024-12-31" })
		assert.deepStrictEqual(
			[year.length, Arr.dedupe(year).length, year[59], year[365]],
			[366, 366, "2024-02-29", "2024-12-31"],
		)
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
		).rows
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

	it("never splits a day, not even one larger than a batch: it is a batch of its own", () => {
		assert.deepStrictEqual(daysIn(batchWholeDays(rowsOf([1, 5, 1]), 2)), ["01", "0202020202", "03"])
	})

	it("names the first day that is larger than a batch, and none when every day fits", () => {
		assert.deepStrictEqual(
			oversizedDay(rowsOf([1, 5, 6]), 4),
			Option.some({ day: "2026-11-02", rows: 5 }),
		)
		// Exactly a batch still fits, and so do days that only together are larger than one.
		assert.deepStrictEqual(oversizedDay(rowsOf([4, 4, 4]), 4), Option.none())
		assert.deepStrictEqual(oversizedDay([], 4), Option.none())
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
