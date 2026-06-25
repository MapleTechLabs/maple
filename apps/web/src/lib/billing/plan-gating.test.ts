import { describe, expect, it } from "vitest"
import { useCustomer } from "autumn-js/react"
import {
	getFeatureQuotas,
	getLegacyPlanInfo,
	getOverageSummary,
	getPastDueSubscription,
	getQuotaStatus,
	hasBringYourOwnCloudAddOn,
	hasSelectedPlan,
	isLegacyPlan,
	isUsableCustomer,
	isUsageBasedPlan,
} from "./plan-gating"
import type { AggregatedUsage } from "./usage"

type Customer = NonNullable<ReturnType<typeof useCustomer>["data"]>
type Subscription = Customer["subscriptions"][number]
type Balance = NonNullable<Customer["balances"]>[string]

function buildBalance(featureId: string, partial: Partial<Balance> = {}): Balance {
	return {
		featureId,
		granted: 50,
		remaining: 50,
		usage: 0,
		unlimited: false,
		overageAllowed: false,
		maxPurchase: null,
		nextResetAt: null,
		...partial,
	} as Balance
}

function buildCustomer(
	subscriptions: Subscription[],
	overrides: { flags?: Customer["flags"]; balances?: Customer["balances"] } = {},
): Customer {
	return {
		id: "cus_1",
		createdAt: Date.now(),
		name: "Test",
		email: "test@maple.dev",
		fingerprint: null,
		stripeId: null,
		env: "sandbox" as Customer["env"],
		metadata: {},
		sendEmailReceipts: false,
		billingControls: {},
		subscriptions,
		purchases: [],
		balances: overrides.balances ?? {},
		flags: overrides.flags ?? {},
	}
}

function buildSubscription(partial: Partial<Subscription> = {}): Subscription {
	return {
		id: "sub_1",
		planId: "starter",
		plan: {
			id: "starter",
			name: "Starter",
			description: null,
			group: null,
			version: 1,
			addOn: false,
			autoEnable: false,
			price: null,
			items: [],
			createdAt: Date.now(),
			env: "sandbox",
			archived: false,
			baseVariantId: null,
			config: { ignorePastDue: false },
		},
		autoEnable: false,
		addOn: false,
		status: "active" as Subscription["status"],
		pastDue: false,
		canceledAt: null,
		expiresAt: null,
		trialEndsAt: null,
		startedAt: Date.now(),
		currentPeriodStart: null,
		currentPeriodEnd: null,
		quantity: 1,
		...partial,
	}
}

type Plan = NonNullable<Subscription["plan"]>
type Item = Plan["items"][number]

function buildPlanItem(featureId: string, included: number, amount: number | null): Item {
	return {
		featureId,
		included,
		unlimited: false,
		reset: { interval: "month" },
		price:
			amount == null
				? null
				: {
						amount,
						billingUnits: 1,
						interval: "month",
					},
	} as Item
}

function buildPlan(partial: Partial<Plan> = {}): Plan {
	return {
		id: "startup",
		name: "Startup",
		description: null,
		group: null,
		version: 1,
		addOn: false,
		autoEnable: false,
		price: { amount: 39, interval: "month" },
		items: [],
		createdAt: Date.now(),
		env: "sandbox",
		archived: false,
		baseVariantId: null,
		config: { ignorePastDue: false },
		...partial,
	}
}

const ZERO_USAGE: AggregatedUsage = { logsGB: 0, tracesGB: 0, metricsGB: 0, browserSessions: 0 }

describe("hasSelectedPlan", () => {
	it("returns false when customer is missing", () => {
		expect(hasSelectedPlan(null)).toBe(false)
		expect(hasSelectedPlan(undefined)).toBe(false)
	})

	it("returns true for active paid base plans", () => {
		const customer = buildCustomer([buildSubscription()])
		expect(hasSelectedPlan(customer)).toBe(true)
	})

	it("returns true for trialing plans (active status with trialEndsAt set)", () => {
		const trialingCustomer = buildCustomer([
			buildSubscription({ status: "active", trialEndsAt: Date.now() + 86400000 }),
		])
		expect(hasSelectedPlan(trialingCustomer)).toBe(true)
	})

	it("returns false for free, add-on, auto-enabled, or scheduled-only subscriptions", () => {
		const freeCustomer = buildCustomer([
			buildSubscription({
				planId: "free",
				plan: {
					id: "free",
					name: "Free",
					description: null,
					group: null,
					version: 1,
					addOn: false,
					autoEnable: true,
					price: null,
					items: [],
					createdAt: Date.now(),
					env: "sandbox",
					archived: false,
					baseVariantId: null,
					config: { ignorePastDue: false },
				},
			}),
		])
		const addOnCustomer = buildCustomer([buildSubscription({ addOn: true })])
		const defaultCustomer = buildCustomer([buildSubscription({ autoEnable: true })])
		const scheduledCustomer = buildCustomer([
			buildSubscription({ status: "scheduled" as Subscription["status"] }),
		])

		expect(hasSelectedPlan(freeCustomer)).toBe(false)
		expect(hasSelectedPlan(addOnCustomer)).toBe(false)
		expect(hasSelectedPlan(defaultCustomer)).toBe(false)
		expect(hasSelectedPlan(scheduledCustomer)).toBe(false)
	})
})

describe("hasBringYourOwnCloudAddOn", () => {
	it("returns false when customer is missing", () => {
		expect(hasBringYourOwnCloudAddOn(null)).toBe(false)
		expect(hasBringYourOwnCloudAddOn(undefined)).toBe(false)
	})

	it("returns true when bringyourowncloud flag is present", () => {
		const customer = buildCustomer([], {
			flags: {
				bringyourowncloud: {
					id: "flag_1",
					planId: null,
					expiresAt: null,
					featureId: "bringyourowncloud",
				},
			},
		})

		expect(hasBringYourOwnCloudAddOn(customer)).toBe(true)
	})

	it("returns false when bringyourowncloud flag is missing", () => {
		const customer = buildCustomer([])

		expect(hasBringYourOwnCloudAddOn(customer)).toBe(false)
	})
})

describe("malformed / error-shaped customer payloads", () => {
	// Autumn's `useCustomer` surfaces an upstream response-validation failure as a
	// `200` whose body is `{ code: "autumn_api_error" }` — it has no
	// `subscriptions`/`flags`. The gating helpers must treat it as "no usable
	// customer" rather than throwing `Cannot read properties of undefined
	// (reading 'find')`, which previously took down every route.
	const errorPayload = {
		message: "Response validation failed",
		code: "autumn_api_error",
		statusCode: 200,
	} as unknown as Customer

	it("isUsableCustomer distinguishes real customers from error payloads", () => {
		expect(isUsableCustomer(null)).toBe(false)
		expect(isUsableCustomer(undefined)).toBe(false)
		expect(isUsableCustomer(errorPayload)).toBe(false)
		expect(isUsableCustomer(buildCustomer([]))).toBe(true)
	})

	it("gating helpers never throw on an error payload and fail closed", () => {
		expect(() => hasSelectedPlan(errorPayload)).not.toThrow()
		expect(hasSelectedPlan(errorPayload)).toBe(false)
		expect(hasBringYourOwnCloudAddOn(errorPayload)).toBe(false)
		expect(isUsageBasedPlan(errorPayload)).toBe(false)
		expect(getQuotaStatus(errorPayload)).toBe("ok")
		expect(getFeatureQuotas(errorPayload)).toEqual([])
	})
})

describe("isUsageBasedPlan", () => {
	it("returns false when customer or balances are missing", () => {
		expect(isUsageBasedPlan(null)).toBe(false)
		expect(isUsageBasedPlan(buildCustomer([]))).toBe(false)
	})

	it("returns false for a base plan (no overage allowed)", () => {
		const customer = buildCustomer([buildSubscription()], {
			balances: { logs: buildBalance("logs"), traces: buildBalance("traces") },
		})
		expect(isUsageBasedPlan(customer)).toBe(false)
	})

	it("returns true when any metered feature allows overage", () => {
		const customer = buildCustomer([buildSubscription()], {
			balances: {
				logs: buildBalance("logs", { overageAllowed: true }),
				traces: buildBalance("traces"),
			},
		})
		expect(isUsageBasedPlan(customer)).toBe(true)
	})
})

describe("getQuotaStatus / getFeatureQuotas", () => {
	it("returns ok when under 80% of grant", () => {
		const customer = buildCustomer([buildSubscription()], {
			balances: { logs: buildBalance("logs", { granted: 50, usage: 30 }) },
		})
		expect(getQuotaStatus(customer)).toBe("ok")
	})

	it("returns approaching between 80% and 100%", () => {
		const customer = buildCustomer([buildSubscription()], {
			balances: { logs: buildBalance("logs", { granted: 50, usage: 45 }) },
		})
		expect(getQuotaStatus(customer)).toBe("approaching")
	})

	it("returns over at or above 100%", () => {
		const customer = buildCustomer([buildSubscription()], {
			balances: { logs: buildBalance("logs", { granted: 50, usage: 55 }) },
		})
		expect(getQuotaStatus(customer)).toBe("over")
	})

	it("takes the worst standing across features", () => {
		const customer = buildCustomer([buildSubscription()], {
			balances: {
				logs: buildBalance("logs", { granted: 50, usage: 10 }),
				traces: buildBalance("traces", { granted: 50, usage: 60 }),
			},
		})
		expect(getQuotaStatus(customer)).toBe("over")
	})

	it("never flags usage-based features (overage allowed)", () => {
		const customer = buildCustomer([buildSubscription()], {
			balances: { logs: buildBalance("logs", { granted: 50, usage: 200, overageAllowed: true }) },
		})
		expect(getQuotaStatus(customer)).toBe("ok")
		expect(getFeatureQuotas(customer)).toHaveLength(0)
	})

	it("never flags unlimited features", () => {
		const customer = buildCustomer([buildSubscription()], {
			balances: { logs: buildBalance("logs", { unlimited: true, usage: 999 }) },
		})
		expect(getQuotaStatus(customer)).toBe("ok")
	})

	it("ignores features with no grant", () => {
		const customer = buildCustomer([buildSubscription()], {
			balances: { logs: buildBalance("logs", { granted: 0, usage: 5 }) },
		})
		expect(getFeatureQuotas(customer)).toHaveLength(0)
		expect(getQuotaStatus(customer)).toBe("ok")
	})
})

describe("getPastDueSubscription", () => {
	it("returns null when customer is missing or error-shaped", () => {
		expect(getPastDueSubscription(null)).toBeNull()
		expect(getPastDueSubscription(buildCustomer([]))).toBeNull()
	})

	it("returns the past-due subscription", () => {
		const sub = buildSubscription({ pastDue: true })
		expect(getPastDueSubscription(buildCustomer([sub]))?.id).toBe(sub.id)
	})

	it("returns null when no subscription is past due", () => {
		expect(getPastDueSubscription(buildCustomer([buildSubscription()]))).toBeNull()
	})

	it("ignores add-on subscriptions", () => {
		const addOn = buildSubscription({ addOn: true, pastDue: true })
		expect(getPastDueSubscription(buildCustomer([addOn]))).toBeNull()
	})
})

describe("isLegacyPlan / getLegacyPlanInfo", () => {
	it("flags archived plans", () => {
		const sub = buildSubscription({ plan: buildPlan({ archived: true }) })
		expect(isLegacyPlan(sub)).toBe(true)
	})

	it("flags the legacy free tier (by id or name)", () => {
		expect(isLegacyPlan(buildSubscription({ planId: "free" }))).toBe(true)
		expect(
			isLegacyPlan(buildSubscription({ planId: "old", plan: buildPlan({ name: "Free" }) })),
		).toBe(true)
	})

	it("does not flag a current active plan", () => {
		expect(isLegacyPlan(buildSubscription())).toBe(false)
	})

	it("getLegacyPlanInfo reflects the active plan", () => {
		const archived = buildCustomer([
			buildSubscription({ plan: buildPlan({ name: "Old Startup", archived: true }) }),
		])
		expect(getLegacyPlanInfo(archived)).toEqual({ isLegacy: true, planName: "Old Startup" })

		const current = buildCustomer([buildSubscription({ plan: buildPlan({ name: "Startup" }) })])
		expect(getLegacyPlanInfo(current)).toEqual({ isLegacy: false, planName: "Startup" })

		expect(getLegacyPlanInfo(buildCustomer([]))).toEqual({ isLegacy: false, planName: null })
	})
})

describe("getOverageSummary", () => {
	const startupPlan = buildPlan({
		items: [
			buildPlanItem("logs", 100, 0.3),
			buildPlanItem("traces", 100, 0.3),
			buildPlanItem("metrics", 100, 0.3),
			buildPlanItem("browser_sessions", 5000, 0.003),
		],
	})

	it("is empty when there is no usable customer", () => {
		expect(getOverageSummary(null, ZERO_USAGE)).toEqual({
			features: [],
			total: 0,
			hasOverage: false,
		})
	})

	it("computes per-feature overage from balances, usage, and live plan rates", () => {
		const customer = buildCustomer([buildSubscription({ plan: startupPlan })], {
			balances: {
				logs: buildBalance("logs", { granted: 100, overageAllowed: true }),
				traces: buildBalance("traces", { granted: 100, overageAllowed: true }),
				browser_sessions: buildBalance("browser_sessions", {
					granted: 5000,
					overageAllowed: true,
				}),
			},
		})
		const usage: AggregatedUsage = {
			logsGB: 150,
			tracesGB: 100, // exactly at cap → no overage
			metricsGB: 0,
			browserSessions: 6000,
		}

		const summary = getOverageSummary(customer, usage)
		expect(summary.hasOverage).toBe(true)
		expect(summary.features.map((f) => f.featureId)).toEqual(["logs", "browser_sessions"])

		const logs = summary.features.find((f) => f.featureId === "logs")
		expect(logs).toMatchObject({ overageUnits: 50, rate: 0.3, cost: 15 })

		const sessions = summary.features.find((f) => f.featureId === "browser_sessions")
		expect(sessions).toMatchObject({ overageUnits: 1000, rate: 0.003 })
		expect(sessions?.cost).toBeCloseTo(3, 5)

		expect(summary.total).toBeCloseTo(18, 5)
	})

	it("excludes features that do not allow overage", () => {
		const customer = buildCustomer([buildSubscription({ plan: startupPlan })], {
			balances: { logs: buildBalance("logs", { granted: 100, overageAllowed: false }) },
		})
		const usage: AggregatedUsage = { ...ZERO_USAGE, logsGB: 200 }
		expect(getOverageSummary(customer, usage).hasOverage).toBe(false)
	})

	it("excludes features under their included grant", () => {
		const customer = buildCustomer([buildSubscription({ plan: startupPlan })], {
			balances: { logs: buildBalance("logs", { granted: 100, overageAllowed: true }) },
		})
		const usage: AggregatedUsage = { ...ZERO_USAGE, logsGB: 80 }
		expect(getOverageSummary(customer, usage).hasOverage).toBe(false)
	})

	it("excludes features whose plan item has no per-unit price", () => {
		const plan = buildPlan({ items: [buildPlanItem("logs", 100, null)] })
		const customer = buildCustomer([buildSubscription({ plan })], {
			balances: { logs: buildBalance("logs", { granted: 100, overageAllowed: true }) },
		})
		const usage: AggregatedUsage = { ...ZERO_USAGE, logsGB: 200 }
		expect(getOverageSummary(customer, usage).hasOverage).toBe(false)
	})
})
