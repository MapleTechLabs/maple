import { describe, expect, it } from "vitest"
import {
	BillingBalance,
	BillingControls,
	BillingCustomer,
	BillingSubscription,
	BillingSpendLimit,
	BillingUsageFeature,
	CatalogPlan,
	CatalogPlanItem,
	CatalogPlanItemPrice,
	CatalogPlanPrice,
	DailySpendResponse,
	DailyVolume,
	type BillingUsage,
} from "@maple/domain/http"
import {
	buildCumulativeSeries,
	buildSpendModel,
	costBreakdown,
	featureUnit,
	formatRateLabel,
	rateCaption,
	usageMeter,
} from "./spend"
import { Array as Arr, Record as Rec } from "effect"

// Mock builders construct only the consumed subset of each domain schema.
const CYCLE_START = Date.UTC(2026, 6, 1)
const CYCLE_END = Date.UTC(2026, 7, 1)
const NOW = Date.UTC(2026, 6, 29, 12)

const item = (featureId: string, included: number, amount: number, billingUnits?: number) =>
	new CatalogPlanItem({
		featureId,
		included,
		price: new CatalogPlanItemPrice(billingUnits === undefined ? { amount } : { amount, billingUnits }),
	})

const startupPlanWith = (items: ReadonlyArray<CatalogPlanItem>) =>
	new CatalogPlan({
		id: "startup",
		name: "Startup",
		price: new CatalogPlanPrice({ amount: 39, interval: "month" }),
		items,
	})

const startupPlan = startupPlanWith([
	item("logs", 100, 0.3),
	item("traces", 100, 0.3),
	item("metrics", 100, 0.3),
	item("browser_sessions", 5_000, 0.002),
	// Billed per 1,000 events: `amount` is the price of one billing block.
	item("product_events", 1_000_000, 0.005, 1_000),
])

type SubscriptionInput = Pick<BillingSubscription, "planId" | "status"> & Partial<BillingSubscription>

const buildCustomer = (
	overrides: {
		subscriptions?: ReadonlyArray<SubscriptionInput>
		balances?: Record<string, Partial<BillingBalance>>
		overageCaps?: Record<string, number>
	} = {},
): BillingCustomer =>
	new BillingCustomer({
		id: "cus_1",
		billingControls:
			overrides.overageCaps === undefined
				? null
				: new BillingControls({
						spendLimits: Arr.map(
							Rec.toEntries(overrides.overageCaps),
							([featureId, overageLimit]) =>
								new BillingSpendLimit({
									featureId,
									enabled: true,
									limitType: "absolute",
									overageLimit,
								}),
						),
					}),
		subscriptions: Arr.map(
			overrides.subscriptions ?? [
				{
					planId: "startup",
					status: "active",
					addOn: false,
					currentPeriodStart: CYCLE_START,
					currentPeriodEnd: CYCLE_END,
				},
			],
			(subscription) => new BillingSubscription(subscription),
		),
		balances: Rec.fromEntries(
			Arr.map(
				Rec.toEntries(
					overrides.balances ?? {
						logs: { granted: 100 },
						traces: { granted: 100 },
						metrics: { granted: 100 },
						browser_sessions: { granted: 5_000 },
						product_events: { granted: 1_000_000 },
					},
				),
				([featureId, balance]) => [featureId, new BillingBalance(balance)],
			),
		),
	})

const usageOf = (sums: Record<string, number>): BillingUsage["total"] =>
	Rec.fromEntries(
		Arr.map(Rec.toEntries(sums), ([featureId, sum]) => [featureId, new BillingUsageFeature({ sum })]),
	)

const usage = usageOf({
	logs: 390,
	traces: 140,
	metrics: 160,
	browser_sessions: 26_700,
})

const model = () => buildSpendModel({ customer: buildCustomer(), plans: [startupPlan], usage, nowMs: NOW })

describe("buildSpendModel", () => {
	it("prices base + overage and projects to cycle end", () => {
		const result = model()
		if (result === null) throw new Error("expected a model")

		expect(result.baseCents).toBe(3_900)
		expect(result.overageCents).toBe(16_040)
		expect(result.spendCents).toBe(19_940)
		// Usage extrapolates on elapsed time (28.5 of 31 days at noon on the
		// 29th) and is then priced; the base fee stays flat. Fractional elapsed on
		// purpose: rounding to whole days makes the projection jump at midnight.
		expect(result.projectedCents).toBe(22_224)
		expect(result.dayOfCycle).toBe(29)
		expect(result.cycleDays).toBe(31)
		expect(result.planName).toBe("Startup")
	})

	it("paces on this cycle's events when the balance still carries the trial", () => {
		const day = 86_400_000
		const paidStart = Date.UTC(2026, 6, 15)
		const customer = buildCustomer({
			subscriptions: [
				{
					planId: "startup",
					status: "active",
					addOn: false,
					currentPeriodStart: paidStart,
					currentPeriodEnd: paidStart + 30 * day,
				},
			],
			// Autumn didn't reset the balance at conversion: 280 GB of it is trial.
			balances: { logs: { granted: 100, usage: 320 } },
		})
		const result = buildSpendModel({
			customer,
			plans: [startupPlan],
			usage: usageOf({ logs: 40 }),
			nowMs: paidStart + 2 * day,
		})
		if (result === null) throw new Error("expected a model")

		expect(result.dayOfCycle).toBe(3)
		// 320 GB + 40 GB/2 days × 28 days = 880 GB, 780 GB over at $0.30.
		// Pacing the whole balance over 2 days would have projected 4,800 GB.
		expect(result.projectedCents).toBe(3_900 + 23_400)
	})

	it("never projects past the base fee when every overage cap is zero", () => {
		const day = 86_400_000
		const customer = buildCustomer({
			subscriptions: [
				{
					planId: "startup",
					status: "active",
					addOn: false,
					currentPeriodStart: CYCLE_START,
					currentPeriodEnd: CYCLE_START + 30 * day,
				},
			],
			balances: { logs: { granted: 100 }, traces: { granted: 100 } },
			overageCaps: { logs: 0, traces: 0, metrics: 0, browser_sessions: 0, product_events: 0 },
		})
		// 90 GB of logs in the first day paces to 2,700 GB: $780 uncapped.
		const result = buildSpendModel({
			customer,
			plans: [startupPlan],
			usage: usageOf({ logs: 90, traces: 10 }),
			nowMs: CYCLE_START + day,
		})
		if (result === null) throw new Error("expected a model")

		expect(result.projectedCents).toBe(3_900)
	})

	it("projects a capped feature up to its cap", () => {
		const day = 86_400_000
		const customer = buildCustomer({
			subscriptions: [
				{
					planId: "startup",
					status: "active",
					addOn: false,
					currentPeriodStart: CYCLE_START,
					currentPeriodEnd: CYCLE_START + 30 * day,
				},
			],
			balances: { logs: { granted: 100 } },
			overageCaps: { logs: 200 },
		})
		const result = buildSpendModel({
			customer,
			plans: [startupPlan],
			usage: usageOf({ logs: 90 }),
			nowMs: CYCLE_START + day,
		})
		if (result === null) throw new Error("expected a model")

		// 200 GB cap × $0.30 on top of the $39 base.
		expect(result.projectedCents).toBe(3_900 + 6_000)
	})

	it("names the top cost driver by overage dollars, not by volume", () => {
		const result = model()
		if (result === null) throw new Error("expected a model")

		// Sessions ingest 26,700 units vs logs' 390 GB, but logs cost more.
		expect(result.topDriver?.featureId).toBe("logs")
		expect(result.topDriver?.overageCents).toBe(8_700)
	})

	it("reads usage from the balance meter, not the event aggregate, when the feature has a balance", () => {
		// Autumn's aggregate window is a rolling cycle-length ending now, so on day 9
		// of a cycle it folds three weeks of the PREVIOUS cycle in. The balance's
		// `usage` is what the invoice is built from.
		const result = buildSpendModel({
			customer: buildCustomer({
				balances: {
					metrics: { granted: 100, usage: 379.75 },
					browser_sessions: { granted: 5_000, usage: 101_928 },
				},
			}),
			plans: [startupPlan],
			usage: usageOf({
				metrics: 433.98,
				browser_sessions: 401_015,
				// No balance for this one: the aggregate is all we have.
				product_events: 1_576,
			}),
			nowMs: NOW,
		})
		if (result === null) throw new Error("expected a model")
		const byId = Rec.fromEntries(Arr.map(result.features, (feature) => [feature.featureId, feature]))
		expect(byId.metrics?.used).toBe(379.75)
		expect(byId.metrics?.overageUnits).toBeCloseTo(279.75)
		expect(byId.browser_sessions?.used).toBe(101_928)
		expect(byId.browser_sessions?.overageUnits).toBe(96_928)
		expect(byId.product_events?.used).toBe(1_576)
	})

	it("has no top driver while everything is within its allotment", () => {
		const result = buildSpendModel({
			customer: buildCustomer(),
			plans: [startupPlan],
			usage: usageOf({ logs: 10 }),
			nowMs: NOW,
		})
		expect(result?.topDriver).toBeNull()
		expect(result?.spendCents).toBe(3_900)
	})

	it("adds an active add-on to the base fee", () => {
		const byoc = new CatalogPlan({
			id: "bringyourowncloud",
			name: "Bring Your Own Cloud",
			addOn: true,
			price: new CatalogPlanPrice({ amount: 99 }),
			items: [],
		})

		const result = buildSpendModel({
			customer: buildCustomer({
				subscriptions: [
					{
						planId: "startup",
						status: "active",
						addOn: false,
						currentPeriodStart: CYCLE_START,
						currentPeriodEnd: CYCLE_END,
					},
					{ planId: "bringyourowncloud", status: "active", addOn: true },
				],
			}),
			plans: [startupPlan, byoc],
			usage,
			nowMs: NOW,
		})

		expect(result?.baseCents).toBe(13_800)
		expect(result?.addOns.map((plan) => plan.id)).toEqual(["bringyourowncloud"])
	})

	it("marks a legacy plan absent from the catalog as partial", () => {
		const result = buildSpendModel({
			customer: buildCustomer({
				subscriptions: [{ planId: "legacy_pro", status: "active", addOn: false }],
			}),
			plans: [startupPlan],
			usage,
			nowMs: NOW,
		})
		expect(result?.partial).toBe(true)
	})

	it("prices product events per event from a rate billed per 1,000", () => {
		const result = buildSpendModel({
			customer: buildCustomer(),
			plans: [startupPlan],
			usage: usageOf({ product_events: 1_400_000 }),
			nowMs: NOW,
		})
		if (result === null) throw new Error("expected a model")

		const events = result.features.find((feature) => feature.featureId === "product_events")
		if (events === undefined) throw new Error("expected product_events")
		// 400,000 events over × $0.005 / 1,000 = $2, NOT 400,000 × $0.005.
		expect(events.overageUnits).toBe(400_000)
		expect(events.overageCents).toBe(200)
		expect(events.ratePerUnit).toBeCloseTo(0.000005, 12)
		expect(events.billingUnits).toBe(1_000)
		expect(result.topDriver?.featureId).toBe("product_events")
	})

	it("captions a feature with no rate in words, never a bare dash", () => {
		const customer = buildCustomer({
			balances: {
				logs: { granted: 100, overageAllowed: false },
				traces: { granted: 100 },
				metrics: { granted: 100 },
				browser_sessions: { granted: 5_000 },
				product_events: { unlimited: true },
			},
		})
		const plan = startupPlanWith(
			Arr.filter(startupPlan.items, (planItem) => planItem.featureId !== "metrics"),
		)
		const result = buildSpendModel({ customer, plans: [plan], usage, nowMs: NOW })
		if (result === null) throw new Error("expected a model")
		const captions = Rec.fromEntries(
			Arr.map(result.features, (feature) => [feature.featureId, rateCaption(feature)]),
		)
		expect(captions).toEqual({
			logs: "No overage",
			traces: "$0.30/GB",
			metrics: "Rate unavailable",
			browser_sessions: "$0.002/session",
			product_events: "Included",
		})
	})

	it("labels rates the way the price list quotes them", () => {
		const result = model()
		if (result === null) throw new Error("expected a model")
		const labels = Rec.fromEntries(
			Arr.map(result.features, (feature) => [feature.featureId, formatRateLabel(feature)]),
		)
		expect(labels).toEqual({
			logs: "$0.30/GB",
			traces: "$0.30/GB",
			metrics: "$0.30/GB",
			browser_sessions: "$0.002/session",
			product_events: "$5/1M events",
		})
		expect(featureUnit("product_events")).toBe("events")
		expect(featureUnit("browser_sessions")).toBe("sessions")
		expect(featureUnit("logs")).toBe("GB")
	})

	it("falls back to the calendar month with no active subscription", () => {
		const result = buildSpendModel({
			customer: buildCustomer({ subscriptions: [] }),
			plans: [startupPlan],
			usage,
			nowMs: NOW,
		})
		expect(result?.cycle.startMs).toBe(Date.UTC(2026, 6, 1))
		expect(result?.baseCents).toBe(0)
	})
})

describe("costBreakdown", () => {
	const byoc = new CatalogPlan({
		id: "bringyourowncloud",
		name: "Bring Your Own Cloud",
		addOn: true,
		price: new CatalogPlanPrice({ amount: 99, interval: "month" }),
		items: [],
	})
	const withAddOn = (addOn: Partial<BillingSubscription>) =>
		buildSpendModel({
			customer: buildCustomer({
				subscriptions: [
					{
						planId: "startup",
						status: "active",
						addOn: false,
						currentPeriodStart: CYCLE_START,
						currentPeriodEnd: CYCLE_END,
					},
					{ planId: "bringyourowncloud", status: "active", addOn: true, ...addOn },
				],
			}),
			plans: [startupPlan, byoc],
			usage,
			nowMs: NOW,
		})

	it("lists plan, add-on and one overage line that sum to the spend figure", () => {
		const result = withAddOn({})
		if (result === null) throw new Error("expected a model")
		const lines = costBreakdown(result)

		expect(Arr.map(lines, (line) => [line.label, line.cents])).toEqual([
			["Startup plan", 3_900],
			["Bring your own cloud add-on", 9_900],
			["Usage overage", result.overageCents],
		])
		expect(Arr.reduce(lines, 0, (sum, line) => sum + (line.cents ?? 0))).toBe(result.spendCents)
		expect(lines[2]?.detail).toBe(
			"Logs, traces, metrics and browser sessions past what's included, per feature in Usage",
		)
	})

	it("multiplies an add-on by its quantity in both the breakdown and the spend", () => {
		const result = withAddOn({ quantity: 2 })
		if (result === null) throw new Error("expected a model")

		expect(result.baseCents).toBe(3_900 + 2 * 9_900)
		expect(costBreakdown(result)[1]?.cents).toBe(2 * 9_900)
	})

	it("keeps an add-on missing from the catalog as an unitemized charge and marks the spend partial", () => {
		const result = buildSpendModel({
			customer: buildCustomer({
				subscriptions: [
					{
						planId: "startup",
						status: "active",
						addOn: false,
						currentPeriodStart: CYCLE_START,
						currentPeriodEnd: CYCLE_END,
					},
					{ planId: "retired_addon", status: "active", addOn: true },
				],
			}),
			plans: [startupPlan],
			usage,
			nowMs: NOW,
		})
		if (result === null) throw new Error("expected a model")

		expect(result.partial).toBe(true)
		expect(result.baseCents).toBe(3_900)
		expect(Arr.map(costBreakdown(result), (line) => [line.label, line.cents])).toEqual([
			["Startup plan", 3_900],
			["retired_addon add-on", null],
			["Usage overage", result.overageCents],
		])
	})

	it("stays complete for an add-on billed by usage alone", () => {
		const result = buildSpendModel({
			customer: buildCustomer({
				subscriptions: [
					{
						planId: "startup",
						status: "active",
						addOn: false,
						currentPeriodStart: CYCLE_START,
						currentPeriodEnd: CYCLE_END,
					},
					{ planId: "usage_addon", status: "active", addOn: true },
				],
			}),
			plans: [
				startupPlan,
				new CatalogPlan({
					id: "usage_addon",
					name: "Usage add-on",
					addOn: true,
					items: [new CatalogPlanItem({ featureId: "logs", included: 10 })],
				}),
			],
			usage,
			nowMs: NOW,
		})
		if (result === null) throw new Error("expected a model")

		expect(result.partial).toBe(false)
		expect(costBreakdown(result)[1]?.cents).toBe(0)
	})

	it("does not itemize fixed fees for a plan it cannot price", () => {
		const result = buildSpendModel({
			customer: buildCustomer({
				subscriptions: [{ planId: "legacy_pro", status: "active", addOn: false }],
			}),
			plans: [startupPlan],
			usage,
			nowMs: NOW,
		})
		if (result === null) throw new Error("expected a model")

		expect(Arr.map(costBreakdown(result), (line) => line.cents)).toEqual([null, result.overageCents])
	})
})

describe("buildCumulativeSeries", () => {
	const daily = (days: ReadonlyArray<{ date: string; logsGB: number }>): DailySpendResponse =>
		new DailySpendResponse({
			days: Arr.map(
				days,
				(day) =>
					new DailyVolume({
						date: day.date,
						logsGB: day.logsGB,
						tracesGB: 0,
						metricsGB: 0,
						browserSessions: 0,
					}),
			),
			cycleStart: CYCLE_START,
			cycleEnd: CYCLE_END,
		})

	// A model whose metered logs total equals the series' own sum, so these tests
	// exercise the accrual walk itself rather than the scaling above it.
	const unscaledModel = (loggedGB: number) => {
		const result = buildSpendModel({
			customer: buildCustomer(),
			plans: [startupPlan],
			usage: usageOf({ logs: loggedGB }),
			nowMs: NOW,
		})
		if (result === null) throw new Error("expected a model")
		return result
	}

	it("accrues overage only after the included allotment is crossed", () => {
		const spendModel = unscaledModel(180)

		// 60 GB/day against a 100 GB allotment: day 1 is fully included, day 2
		// crosses at 120 GB (20 GB over = $6), day 3 adds another 60 GB ($18).
		const series = buildCumulativeSeries({
			daily: daily([
				{ date: "2026-07-01", logsGB: 60 },
				{ date: "2026-07-02", logsGB: 60 },
				{ date: "2026-07-03", logsGB: 60 },
			]),
			model: spendModel,
		})

		expect(Arr.map(series, (point) => point.logs)).toEqual([0, 6, 24])
		// The base fee is owed on day 1, so it's a flat band, never a slope.
		expect(Arr.map(series, (point) => point.base)).toEqual([39, 39, 39])
		expect(series[2]?.total).toBe(63)
	})

	it("is monotonic — a zero-ingest day holds the line flat instead of dipping", () => {
		const spendModel = unscaledModel(200)

		const series = buildCumulativeSeries({
			daily: daily([
				{ date: "2026-07-01", logsGB: 150 },
				{ date: "2026-07-02", logsGB: 0 },
				{ date: "2026-07-03", logsGB: 50 },
			]),
			model: spendModel,
		})

		expect(Arr.map(series, (point) => point.logs)).toEqual([15, 15, 30])
	})

	it("stops the actual bands at today and carries the projection to the cycle end", () => {
		const spendModel = unscaledModel(0)

		const series = buildCumulativeSeries({
			daily: daily([
				{ date: "2026-07-28", logsGB: 0 },
				{ date: "2026-07-29", logsGB: 0 },
				{ date: "2026-07-30", logsGB: 0 },
				{ date: "2026-07-31", logsGB: 0 },
			]),
			model: spendModel,
		})

		expect(Arr.map(series, (point) => point.future)).toEqual([false, false, true, true])
		// Future days carry no bands: a flat line to the end of the cycle would
		// read as "spend stops here" rather than "these days haven't happened".
		expect(Arr.map(series, (point) => point.base)).toEqual([39, 39, null, null])
		expect(Arr.map(series, (point) => point.total)).toEqual([39, 39, null, null])

		// Exactly two projection anchors — today's actual total and the projected
		// total on the last day — so the dashed segment is a straight line.
		expect(Arr.map(series, (point) => point.projected)).toEqual([
			null,
			39,
			null,
			spendModel.projectedCents / 100,
		])
	})

	it("has no projection anchor when the series already ends today", () => {
		const spendModel = unscaledModel(0)

		const series = buildCumulativeSeries({
			daily: daily([
				{ date: "2026-07-28", logsGB: 0 },
				{ date: "2026-07-29", logsGB: 0 },
			]),
			model: spendModel,
		})

		expect(Arr.map(series, (point) => point.projected)).toEqual([null, 39])
	})

	it("scales the warehouse shape onto the metered total, so the chart matches the KPI", () => {
		const spendModel = model()
		if (spendModel === null) throw new Error("expected a model")

		// The metered total for logs is 390 GB; the warehouse series here sums to
		// 39 GB (a 10x metering gap). The last point must still price 390 GB of
		// logs — 290 GB over the 100 GB allotment at $0.30 = $87 — or the chart
		// would contradict the "spend so far" card directly above it.
		const series = buildCumulativeSeries({
			daily: daily([
				{ date: "2026-07-01", logsGB: 13 },
				{ date: "2026-07-02", logsGB: 13 },
				{ date: "2026-07-03", logsGB: 13 },
			]),
			model: spendModel,
		})

		expect(series[2]?.logs).toBeCloseTo(87, 6)
		// The daily shape survives the scaling — thirds of the cycle's overage.
		expect(series[0]?.logs).toBeCloseTo(9, 6)
	})

	it("returns an empty series when the warehouse read is unavailable", () => {
		const spendModel = model()
		if (spendModel === null) throw new Error("expected a model")
		expect(buildCumulativeSeries({ daily: undefined, model: spendModel })).toEqual([])
	})
})

describe("usageMeter", () => {
	const meters = (balances: Record<string, Partial<BillingBalance>>, total: BillingUsage["total"]) => {
		const result = buildSpendModel({
			customer: buildCustomer({ balances }),
			plans: [startupPlan],
			usage: total,
			nowMs: NOW,
		})
		if (result === null) throw new Error("expected a model")
		return Rec.fromEntries(
			Arr.map(result.features, (feature) => [feature.featureId, usageMeter(feature)]),
		)
	}

	it("leaves an unlimited feature's bar empty instead of full", () => {
		const result = meters(
			{ logs: { granted: 100 }, product_events: { unlimited: true } },
			usageOf({
				logs: 50,
				product_events: 2_000_000,
			}),
		)
		expect(result.product_events).toEqual({ included: 0, overage: 0 })
		expect(result.logs).toEqual({ included: 50, overage: 0 })
	})

	it("splits the bar at the allotment once usage runs past it", () => {
		const result = meters({ logs: { granted: 100 } }, usageOf({ logs: 400 }))
		expect(result.logs).toEqual({ included: 25, overage: 75 })
	})
})
