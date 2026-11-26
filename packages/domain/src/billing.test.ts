import { Option } from "effect"
import { describe, expect, it } from "vitest"
import {
	aiCardGateOf,
	cycleSpend,
	hasHadPlan,
	hasPlanHistory,
	isActivePlanSubscription,
	isPlanSubscription,
	isPricedPlan,
	overageUnits,
	projectCycleSpend,
	resolveSubscriptionPlan,
	meteredUsage,
	startupTrialDays,
} from "./billing"

// The Startup plan as it ships in apps/api/autumn.config.ts: $39/mo, 100 GB of
// each byte signal at $0.30/GB, 5,000 sessions at $0.002 each.
const startupFeatures = {
	logs: { used: 390, included: 100, ratePerUnit: 0.3 },
	traces: { used: 140, included: 100, ratePerUnit: 0.3 },
	metrics: { used: 160, included: 100, ratePerUnit: 0.3 },
	browser_sessions: { used: 26_700, included: 5_000, ratePerUnit: 0.002 },
}

describe("meteredUsage", () => {
	it("prefers the balance meter Autumn invoices from over the event aggregate", () => {
		// The aggregate is a rolling cycle-length window, so mid-cycle it overstates.
		expect(meteredUsage({ usage: 379.75 }, 433.98)).toBe(379.75)
		expect(meteredUsage({ usage: 0 }, 12)).toBe(0)
	})

	it("falls back to the aggregate for a feature with no balance (not on the plan)", () => {
		expect(meteredUsage(undefined, 1_576)).toBe(1_576)
		expect(meteredUsage({ usage: null }, 1_576)).toBe(1_576)
		expect(meteredUsage({}, undefined)).toBe(0)
		expect(meteredUsage(undefined, undefined)).toBe(0)
	})
})

describe("overageUnits", () => {
	it("is the excess over included, floored at zero", () => {
		expect(overageUnits({ used: 390, included: 100, ratePerUnit: 0.3 })).toBe(290)
		expect(overageUnits({ used: 40, included: 100, ratePerUnit: 0.3 })).toBe(0)
	})

	it("is zero for unlimited features and for an unknown allotment", () => {
		expect(overageUnits({ used: 9_999, included: 100, ratePerUnit: 0.3, unlimited: true })).toBe(0)
		expect(overageUnits({ used: 9_999, included: null, ratePerUnit: 0.3 })).toBe(0)
	})
})

describe("cycleSpend", () => {
	it("prices base plus per-feature overage in cents", () => {
		const spend = cycleSpend({ baseDollars: 39, features: startupFeatures })

		expect(spend.baseCents).toBe(3_900)
		expect(spend.overageByFeature).toEqual({
			logs: 8_700,
			traces: 1_200,
			metrics: 1_800,
			browser_sessions: 4_340,
		})
		expect(spend.overageCents).toBe(16_040)
		expect(spend.totalCents).toBe(19_940)
		expect(spend.partial).toBe(false)
	})

	it("survives a sub-cent rate without rounding it away per feature", () => {
		// 1 session at $0.002 is 0.2c: rounding per feature would drop it, and an
		// org metered only in sessions would read as $0 spend forever.
		const spend = cycleSpend({
			baseDollars: 0,
			features: { browser_sessions: { used: 5_500, included: 5_000, ratePerUnit: 0.002 } },
		})
		expect(spend.overageCents).toBe(100)
	})

	it("flags a partial estimate when the base price or an overage rate is unknown", () => {
		const noBase = cycleSpend({ baseDollars: null, features: {} })
		expect(noBase.partial).toBe(true)
		expect(noBase.totalCents).toBe(0)

		const noRate = cycleSpend({
			baseDollars: 39,
			features: { logs: { used: 390, included: 100, ratePerUnit: null } },
		})
		expect(noRate.partial).toBe(true)
		expect(noRate.overageByFeature.logs).toBe(0)
		expect(noRate.totalCents).toBe(3_900)
	})
})

describe("projectCycleSpend", () => {
	const day = 86_400_000
	const logs = (used: number) => ({
		logs: { used, included: 100, ratePerUnit: 0.5, unlimited: false },
	})

	it("extrapolates usage, then prices only what crosses the allotment", () => {
		// Day 10 of 30 at 60 GB → 180 GB, 80 GB over at $0.50 → $39 + $40.
		expect(
			projectCycleSpend({
				baseDollars: 39,
				features: logs(60),
				elapsedMs: 10 * day,
				totalMs: 30 * day,
			}),
		).toBe(7_900)
	})

	it("paces on this cycle's usage, not on a balance carrying the trial", () => {
		// The balance holds 320 GB (trial + 2 paid days); only 40 GB landed in
		// the cycle. 320 + 40 GB/2 days × 28 days = 880 GB, 780 GB over at $0.50.
		// Pacing the whole balance over 2 days would have projected 4,800 GB.
		expect(
			projectCycleSpend({
				baseDollars: 39,
				features: logs(320),
				cycleUsage: { logs: 40 },
				elapsedMs: 2 * day,
				totalMs: 30 * day,
			}),
		).toBe(3_900 + 39_000)
	})

	it("stops at the overage cap, where the gateway rejects new data", () => {
		// Day 2 of 30 at 60 GB would project 900 GB, 800 GB over; a 50 GB cap
		// bounds it at 50 GB × $0.50 = $25.
		const capped = { logs: { ...logs(60).logs, overageLimit: 50 } }
		expect(
			projectCycleSpend({ baseDollars: 39, features: capped, elapsedMs: 2 * day, totalMs: 30 * day }),
		).toBe(3_900 + 2_500)
		// A zero cap means no paid overage: the projection is the base fee.
		const zero = { logs: { ...logs(60).logs, overageLimit: 0 } }
		expect(
			projectCycleSpend({ baseDollars: 39, features: zero, elapsedMs: 2 * day, totalMs: 30 * day }),
		).toBe(3_900)
	})

	it("returns spend as-is at cycle end or with nothing elapsed", () => {
		expect(
			projectCycleSpend({ baseDollars: 39, features: logs(200), elapsedMs: 100, totalMs: 100 }),
		).toBe(8_900)
		expect(projectCycleSpend({ baseDollars: 39, features: logs(200), elapsedMs: 0, totalMs: 100 })).toBe(
			8_900,
		)
	})
})

describe("isActivePlanSubscription", () => {
	it("is true for an active base plan (trials included — Autumn marks them active)", () => {
		expect(isActivePlanSubscription({ planId: "startup", status: "active" })).toBe(true)
	})

	it("is false for add-on, auto-enabled, and free plans", () => {
		expect(isActivePlanSubscription({ planId: "byoc", status: "active", addOn: true })).toBe(false)
		expect(isActivePlanSubscription({ planId: "starter", status: "active", autoEnable: true })).toBe(
			false,
		)
		expect(isActivePlanSubscription({ planId: "free", status: "active" })).toBe(false)
		expect(isActivePlanSubscription({ planId: "x", status: "active", plan: { name: "Free" } })).toBe(
			false,
		)
	})

	it("is false for non-active status and empty/missing input", () => {
		expect(isActivePlanSubscription({ planId: "startup", status: "scheduled" })).toBe(false)
		expect(isActivePlanSubscription({ planId: "startup", status: "expired" })).toBe(false)
		expect(isActivePlanSubscription({})).toBe(false)
		expect(isActivePlanSubscription(null)).toBe(false)
		expect(isActivePlanSubscription(undefined)).toBe(false)
	})
})

describe("isPlanSubscription", () => {
	it("is true for a real base plan whatever its status", () => {
		expect(isPlanSubscription({ planId: "startup", status: "active" })).toBe(true)
		expect(isPlanSubscription({ planId: "startup", status: "expired" })).toBe(true)
		expect(isPlanSubscription({ planId: "startup", status: "canceled" })).toBe(true)
		expect(isPlanSubscription({ planId: "startup", status: "scheduled" })).toBe(true)
	})

	it("is false for add-on, auto-enabled, and free plans", () => {
		expect(isPlanSubscription({ planId: "byoc", status: "expired", addOn: true })).toBe(false)
		expect(isPlanSubscription({ planId: "starter", status: "expired", autoEnable: true })).toBe(false)
		expect(isPlanSubscription({ planId: "free", status: "expired" })).toBe(false)
		expect(isPlanSubscription({ planId: "x", status: "expired", plan: { name: "Free" } })).toBe(false)
	})

	it("is false for missing input", () => {
		expect(isPlanSubscription(null)).toBe(false)
		expect(isPlanSubscription(undefined)).toBe(false)
	})
})

describe("resolveSubscriptionPlan", () => {
	const catalogStartup = {
		id: "startup",
		name: "Startup",
		price: { amount: 39 },
		items: [{ featureId: "logs", included: 100, price: { amount: 0.3 } }],
	}

	it("prefers the customer's own expanded plan over the catalog entry", () => {
		// The whole point: a customer on a custom-priced "startup" must be billed at
		// THEIR $19/50 GB, not at the catalog's $39/100 GB.
		const own = {
			id: "startup",
			name: "Startup (custom)",
			price: { amount: 19 },
			items: [{ featureId: "logs", included: 50, price: { amount: 0.1 } }],
		}
		const resolved = resolveSubscriptionPlan({ planId: "startup", status: "active", plan: own }, [
			catalogStartup,
		])

		expect(resolved?.price?.amount).toBe(19)
		expect(resolved?.items?.[0]?.included).toBe(50)
	})

	it("falls back to the catalog when the plan was not expanded", () => {
		// An unexpanded `plan` carries only a name; it must not shadow the catalog
		// entry that actually has prices.
		const resolved = resolveSubscriptionPlan(
			{ planId: "startup", status: "active", plan: { name: "Startup" } },
			[catalogStartup],
		)
		expect(resolved?.price?.amount).toBe(39)
	})

	it("returns the unpriced plan when neither source can price it", () => {
		const resolved = resolveSubscriptionPlan(
			{ planId: "legacy_pro", status: "active", plan: { name: "Legacy Pro" } },
			[catalogStartup],
		)
		expect(resolved?.name).toBe("Legacy Pro")
		expect(isPricedPlan(resolved)).toBe(false)
	})
})

describe("cycleSpend with hard-capped features", () => {
	it("bills nothing for a hard-capped feature and stays exact", () => {
		// An archived plan can grant 50 GB with no overage rate at all: the excess is
		// rejected at the gateway, so $0 is the correct AND knowable answer. Marking
		// it partial would tell the customer their bill might be higher.
		const spend = cycleSpend({
			baseDollars: 19,
			features: {
				logs: { used: 90, included: 50, ratePerUnit: null, overageAllowed: false },
			},
		})

		expect(spend.overageByFeature.logs).toBe(0)
		expect(spend.totalCents).toBe(1_900)
		expect(spend.partial).toBe(false)
	})

	it("still flags a missing rate when the plan DOES allow overage", () => {
		const spend = cycleSpend({
			baseDollars: 19,
			features: {
				logs: { used: 90, included: 50, ratePerUnit: null, overageAllowed: true },
			},
		})
		expect(spend.partial).toBe(true)
	})
})

describe("the no-card trial", () => {
	const DAY = 24 * 60 * 60 * 1000
	const NOW = 1_800_000_000_000
	const trial = (trialEndsAt: number | null, status = "active") => ({
		planId: "trial",
		status,
		trialEndsAt,
	})

	it("is once per org: any base plan, the trial included, counts as had", () => {
		expect(hasHadPlan([])).toBe(false)
		expect(hasHadPlan([{ planId: "bringyourowncloud", addOn: true, status: "active" }])).toBe(false)
		expect(hasHadPlan([trial(NOW - DAY, "expired")])).toBe(true)
		expect(hasHadPlan([{ planId: "startup", status: "expired" }])).toBe(true)
	})

	it("carries the trial's days left, rounded up, onto a Startup attach", () => {
		expect(startupTrialDays([trial(NOW + 8.5 * DAY)], [], NOW)).toBe(9)
		// The last hours still give a whole day: the first charge lands when the trial ends.
		expect(startupTrialDays([trial(NOW + 60_000)], [], NOW)).toBe(1)
	})

	it("bills a Startup attach now once the trial ended, and leaves a never-trialed org to the plan", () => {
		expect(startupTrialDays([trial(NOW - DAY, "expired")], [], NOW)).toBeNull()
		expect(startupTrialDays([trial(null)], [], NOW)).toBeUndefined()
		expect(
			startupTrialDays([{ planId: "startup", status: "expired", trialEndsAt: NOW + DAY }], [], NOW),
		).toBeUndefined()
	})

	it("bills a Startup attach now when the ended trial's row is gone but trials_used has it", () => {
		expect(startupTrialDays([], [{ planId: "trial" }], NOW)).toBeNull()
		// A Startup card trial alone leaves the attach to the plan's own terms.
		expect(startupTrialDays([], [{ planId: "startup" }], NOW)).toBeUndefined()
	})

	it("counts a recorded trial as plan history once Autumn drops the row", () => {
		expect(hasPlanHistory([], [{ planId: "trial" }])).toBe(true)
		expect(hasPlanHistory([], null)).toBe(false)
		expect(hasPlanHistory([{ planId: "openrouter_byok", addOn: true, status: "active" }], [])).toBe(false)
		expect(hasPlanHistory([{ planId: "startup", status: "expired" }], undefined)).toBe(true)
	})

	it("reads the latest trial row when Autumn kept several", () => {
		expect(startupTrialDays([trial(NOW - DAY, "expired"), trial(NOW + 2 * DAY)], [], NOW)).toBe(2)
	})

	it("holds Maple AI for a card while the trial runs, and for a plan once it ended", () => {
		const gate = (subs: Parameters<typeof aiCardGateOf>[0]) => Option.getOrNull(aiCardGateOf(subs))
		expect(gate([trial(NOW + DAY)])).toBe("trial")
		// An ended trial, one Autumn dropped, a lapsed plan and an add-on alone are not paid plans.
		expect(gate([trial(NOW - DAY, "expired")])).toBe("no_plan")
		expect(gate([])).toBe("no_plan")
		expect(gate([{ planId: "startup", status: "expired" }])).toBe("no_plan")
		expect(gate([{ planId: "bringyourowncloud", addOn: true, status: "active" }])).toBe("no_plan")
	})

	it("lets any active paid plan run Maple AI, a card added mid-trial and a custom plan included", () => {
		const gate = (subs: Parameters<typeof aiCardGateOf>[0]) => Option.getOrNull(aiCardGateOf(subs))
		expect(gate([trial(NOW + DAY, "expired"), { planId: "startup", status: "active" }])).toBeNull()
		expect(gate([{ planId: "enterprise_acme", status: "active" }])).toBeNull()
	})
})
