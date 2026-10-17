import type { BillingCustomer, BillingUsage, CatalogPlan, DailySpendResponse } from "@maple/domain/http"
import {
	cycleSpend,
	isActivePlanSubscription,
	isPricedPlan,
	meteredUsage,
	projectCycleSpend,
	resolveSubscriptionPlan,
	type FeatureUsagePricing,
	type PlanLike,
} from "@maple/domain/billing"
import { sentenceCasePlanName } from "./plans"
import { formatQuoteUnits, quoteUnits } from "./usage"

/**
 * The billing page's spend model: one place that turns the Autumn snapshot plus
 * the warehouse's daily volume into every number the page renders — the KPI row,
 * the per-feature cards, and the cumulative chart.
 *
 * The dollars come from `@maple/domain/billing`, the shared pricing module.
 * Anything derived here is presentation: which day is
 * "today", how to stack the bands, what the projection line ends at.
 */

/** Features Maple meters, in the order they stack in the chart and read across the cards. */
export const SPEND_FEATURES = ["logs", "traces", "metrics", "browser_sessions", "product_events"] as const
export type SpendFeatureId = (typeof SPEND_FEATURES)[number]

export const FEATURE_LABELS: Record<SpendFeatureId, string> = {
	logs: "Logs",
	traces: "Traces",
	metrics: "Metrics",
	browser_sessions: "Browser sessions",
	product_events: "Product events",
} satisfies Record<SpendFeatureId, string>

/**
 * Series colors, validated for contrast on the card surface and for deutan CVD
 * separation. Amber is deliberately absent: it belongs to the limit line, the
 * projection, and the brand — a data band in amber would read as one of those.
 *
 * `product_events` takes the cyan/teal slot of the shared chart palette. That
 * hue lives on a different token per theme (`--chart-5` is cyan in light,
 * purple in dark; `--chart-4` is purple in light, teal in dark), so it is picked
 * per scheme rather than by one token name — the point is a stable hue that sits
 * between the blue of logs and the green of traces without touching either.
 */
export const FEATURE_COLORS: Record<SpendFeatureId, string> = {
	logs: "#3987e5",
	traces: "#199e70",
	metrics: "#9085e9",
	browser_sessions: "#d55181",
	product_events: "light-dark(var(--chart-5), var(--chart-4))",
} satisfies Record<SpendFeatureId, string>

/** Singular unit for the count-metered features; every other feature is per GB. */
const COUNT_UNITS = {
	browser_sessions: "session",
	product_events: "event",
} as const satisfies Partial<Record<SpendFeatureId, string>>

type CountFeatureId = keyof typeof COUNT_UNITS
const isCountFeature = (featureId: string): featureId is CountFeatureId => featureId in COUNT_UNITS
const countUnitOf = (featureId: string) => (isCountFeature(featureId) ? COUNT_UNITS[featureId] : undefined)

/** `browser_sessions` is metered per session and `product_events` per event; every other feature per GB. */
export const featureUnit = (featureId: string): "GB" | "sessions" | "events" => {
	const unit = countUnitOf(featureId)
	return unit === undefined ? "GB" : `${unit}s`
}

/**
 * The overage rate as the catalog quotes it: per GB for the byte signals, per
 * unit for sessions, and per million for events ("$5/1M events"):
 * the per-event rate is a fraction of a cent and would read as "$0" if rendered
 * through the currency formatter.
 */
export const formatRateLabel = (feature: FeatureSpend): string | null => {
	if (feature.ratePerUnit === null) return null
	const unit = countUnitOf(feature.featureId)
	if (unit === undefined) return `$${feature.ratePerUnit.toFixed(2)}/GB`
	const block = quoteUnits(feature.featureId, feature.billingUnits)
	if (block > 1) {
		const perBlock = feature.ratePerUnit * block
		return `$${Number(perBlock.toPrecision(6))}/${formatQuoteUnits(block)} ${unit}s`
	}
	return `$${feature.ratePerUnit}/${unit}`
}

/** The rate cell's caption: the quoted rate, or in words why there is none. */
export const rateCaption = (feature: FeatureSpend): string => {
	if (feature.unlimited) return "Included"
	if (feature.overageAllowed === false) return "No overage"
	const rate = formatRateLabel(feature)
	if (rate !== null) return rate
	return feature.included === null ? "Not on plan" : "Rate unavailable"
}

/**
 * The usage meter's two segments, in percent of the bar. An unlimited feature has no
 * allotment to fill, so its bar stays empty instead of reading as maxed out.
 */
export const usageMeter = (
	feature: FeatureSpend,
): { readonly included: number; readonly overage: number } => {
	if (feature.unlimited) return { included: 0, overage: 0 }
	const hardCapped = feature.overageAllowed === false
	if (feature.overageUnits > 0 && !hardCapped) {
		const included =
			feature.included === null || feature.used <= 0
				? 100
				: Math.min(100, (feature.included / feature.used) * 100)
		return { included, overage: 100 - included }
	}
	const fill =
		feature.included !== null && feature.included > 0
			? Math.min(100, (feature.used / feature.included) * 100)
			: 100
	return { included: fill, overage: 0 }
}

export interface FeatureSpend extends FeatureUsagePricing {
	readonly featureId: SpendFeatureId
	readonly label: string
	/**
	 * Units the catalog quotes the rate per (1 for GB and sessions, 1,000 for
	 * events). `ratePerUnit` is already normalized to ONE unit; this is kept only
	 * so the rate can be shown the way the price list states it.
	 */
	readonly billingUnits: number
	readonly overageUnits: number
	readonly overageCents: number
}

export interface SpendModel {
	readonly currency: string
	readonly baseCents: number
	readonly overageCents: number
	readonly spendCents: number
	readonly projectedCents: number
	readonly partial: boolean
	readonly features: ReadonlyArray<FeatureSpend>
	/** Highest-overage feature, or null when nothing is in overage yet. */
	readonly topDriver: FeatureSpend | null
	readonly cycle: { readonly startMs: number; readonly endMs: number; readonly nowMs: number }
	/** 1-based day of the cycle, and the cycle's length in days. */
	readonly dayOfCycle: number
	readonly cycleDays: number
	/** Name of the active plan, for the plan strip and the offer plate. */
	readonly planName: string | null
	/**
	 * The plan actually governing this cycle — the customer's own expanded plan
	 * when they have one, else the catalog entry. For a custom-priced customer
	 * this is NOT a catalog plan.
	 */
	readonly basePlan: PlanLike | null
	readonly addOns: ReadonlyArray<PlanLike>
	/**
	 * True when the governing plan isn't the public catalog entry it claims to be —
	 * a custom or grandfathered plan. The plans section must not advertise a
	 * catalog plan as theirs in that case.
	 */
	readonly isCustomPlan: boolean
	/** The fixed fees behind `baseCents`: the plan first, then each active add-on. */
	readonly charges: ReadonlyArray<BaseCharge>
}

export interface BaseCharge {
	readonly key: string
	readonly kind: "plan" | "addOn"
	readonly name: string
	/** Price times quantity, in dollars; null when the charge cannot be priced. */
	readonly dollars: number | null
	readonly interval: string | null
}

const DAY_MS = 86_400_000

const chargeOf = (
	kind: BaseCharge["kind"],
	sub: BillingCustomer["subscriptions"][number],
	plan: PlanLike | null,
): BaseCharge => {
	const amount = plan?.price?.amount
	const quantity = sub.quantity != null && sub.quantity > 1 ? sub.quantity : 1
	// An add-on priced by usage alone owes no fixed fee; null stays "unknown".
	const fixed = amount ?? (kind === "addOn" && isPricedPlan(plan) ? 0 : null)
	return {
		key: `${kind}:${plan?.id ?? sub.planId}`,
		kind,
		name: plan?.name ?? sub.plan?.name ?? sub.planId,
		dollars: fixed === null ? null : fixed * quantity,
		interval: plan?.price?.interval ?? null,
	}
}

const cycleWindow = (customer: BillingCustomer | undefined, nowMs: number) => {
	const active = customer?.subscriptions?.find((sub) => sub.status === "active")
	if (active?.currentPeriodStart != null && active.currentPeriodEnd != null) {
		return { startMs: active.currentPeriodStart, endMs: active.currentPeriodEnd }
	}
	const now = new Date(nowMs)
	return {
		startMs: Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
		endMs: Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
	}
}

/**
 * Everything the page needs about this cycle's spend. Returns null only when the
 * customer hasn't loaded — a customer with no plan still has a model (zero base,
 * real usage), because the page must show usage before it shows a bill.
 */
export function buildSpendModel({
	customer,
	plans,
	usage,
	nowMs,
}: {
	readonly customer: BillingCustomer | undefined
	readonly plans: ReadonlyArray<CatalogPlan> | undefined
	readonly usage: BillingUsage["total"] | undefined
	readonly nowMs: number
}): SpendModel | null {
	if (!customer) return null

	const catalog = plans ?? []
	const activeSub = customer.subscriptions.find((sub) => isActivePlanSubscription(sub))
	// The customer's own plan wins over the catalog — see `resolveSubscriptionPlan`.
	// This is what makes usage-based pricing correct on a custom plan.
	const basePlan = activeSub ? resolveSubscriptionPlan(activeSub, catalog) : null
	// An add-on we cannot resolve stays a charge (unpriced) so the spend reads as partial.
	const addOnSubs = customer.subscriptions
		.filter((sub) => sub.addOn === true && sub.status === "active")
		.map((sub) => ({ sub, plan: resolveSubscriptionPlan(sub, catalog) }))
	const addOns = addOnSubs.flatMap(({ plan }) => (plan === null ? [] : [plan]))
	const charges: BaseCharge[] =
		activeSub === undefined
			? []
			: [
					chargeOf("plan", activeSub, basePlan),
					...addOnSubs.map(({ sub, plan }) => chargeOf("addOn", sub, plan)),
				]

	// A plan we can't price (neither expanded nor in the catalog) must read as
	// partial rather than as a $0 base. Quantity multiplies, as on the invoice.
	const baseDollars =
		activeSub === undefined
			? 0
			: !isPricedPlan(basePlan)
				? null
				: charges.reduce((sum, charge) => sum + (charge.dollars ?? 0), 0)

	const pricing: Record<string, FeatureUsagePricing> = {}
	const billingUnitsByFeature: Record<string, number> = {}
	for (const featureId of SPEND_FEATURES) {
		const balance = customer.balances?.[featureId]
		const item = basePlan?.items?.find((entry) => entry.featureId === featureId)
		// The catalog quotes `amount` per `billingUnits` (e.g. $0.05 per 1,000
		// events); every consumer here prices ONE unit, so normalize once.
		const rawBillingUnits = item?.price?.billingUnits ?? 1
		const billingUnits = rawBillingUnits > 0 ? rawBillingUnits : 1
		billingUnitsByFeature[featureId] = billingUnits
		const amount = item?.price?.amount
		pricing[featureId] = {
			used: meteredUsage(balance, usage?.[featureId]?.sum),
			included: balance?.granted ?? item?.included ?? null,
			ratePerUnit: amount == null ? null : amount / billingUnits,
			unlimited: balance?.unlimited === true,
			// A hard-capped feature bills no overage — see `billsOverage`.
			overageAllowed: balance?.overageAllowed,
		}
	}

	const spend = cycleSpend({ baseDollars, features: pricing })
	const unpricedAddOn = charges.some((charge) => charge.kind === "addOn" && charge.dollars === null)

	const features: FeatureSpend[] = SPEND_FEATURES.map((featureId) => {
		const entry = pricing[featureId]
		const overUnits =
			entry.unlimited || entry.included == null ? 0 : Math.max(0, entry.used - entry.included)
		return {
			...entry,
			featureId,
			label: FEATURE_LABELS[featureId],
			billingUnits: billingUnitsByFeature[featureId] ?? 1,
			overageUnits: overUnits,
			overageCents: spend.overageByFeature[featureId] ?? 0,
		}
	})

	const topDriver =
		features.reduce<FeatureSpend | null>(
			(best, feature) =>
				feature.overageCents > 0 && (best === null || feature.overageCents > best.overageCents)
					? feature
					: best,
			null,
		) ?? null

	const cycle = cycleWindow(customer, nowMs)
	const cycleDays = Math.max(1, Math.round((cycle.endMs - cycle.startMs) / DAY_MS))
	const elapsedMs = Math.max(0, Math.min(nowMs, cycle.endMs) - cycle.startMs)
	const dayOfCycle = Math.min(cycleDays, Math.floor(elapsedMs / DAY_MS) + 1)

	return {
		currency: "usd",
		baseCents: spend.baseCents,
		overageCents: spend.overageCents,
		spendCents: spend.totalCents,
		projectedCents: projectCycleSpend({
			baseDollars,
			features: pricing,
			cycleUsage: Object.fromEntries(SPEND_FEATURES.map((id) => [id, usage?.[id]?.sum ?? undefined])),
			elapsedMs,
			totalMs: cycle.endMs - cycle.startMs,
		}),
		partial: spend.partial || unpricedAddOn,
		features,
		topDriver,
		cycle: { ...cycle, nowMs },
		dayOfCycle,
		cycleDays,
		planName: basePlan?.name ?? activeSub?.plan?.name ?? null,
		basePlan,
		addOns,
		isCustomPlan:
			activeSub !== undefined && !catalog.some((plan) => plan.id === activeSub.planId && !plan.addOn),
		charges,
	}
}

export interface CostLine {
	readonly key: string
	readonly label: string
	readonly detail: string
	/** Null when the plan cannot be priced: the line is listed but not itemized. */
	readonly cents: number | null
}

/** "Logs, traces and product events": a feature list as one sentence-case phrase. */
const joinFeatureLabels = (labels: ReadonlyArray<string>): string => {
	const lower = labels.map((label) => label.toLowerCase())
	const phrase =
		lower.length <= 1
			? (lower[0] ?? "")
			: `${lower.slice(0, -1).join(", ")} and ${lower[lower.length - 1]}`
	return phrase.charAt(0).toUpperCase() + phrase.slice(1)
}

/**
 * The cost breakdown, read off the spend model so its lines always sum to
 * `spendCents`: the plan, each add-on, and one usage overage line. The plan line
 * absorbs rounding so the fixed fees sum to `baseCents` exactly.
 */
export function costBreakdown(model: SpendModel): ReadonlyArray<CostLine> {
	const detailOf = (charge: BaseCharge) =>
		charge.interval === null ? "Base price" : `Base price per ${charge.interval}`
	// An unpriceable plan leaves `baseCents` at 0, so no fixed fee can be itemized.
	const baseKnown = isPricedPlan(model.basePlan)
	const addOnLines = model.charges
		.filter((charge) => charge.kind === "addOn")
		.map((charge) => ({
			key: charge.key,
			label: `${sentenceCasePlanName(charge.name)} add-on`,
			detail: detailOf(charge),
			cents: baseKnown && charge.dollars !== null ? Math.round(charge.dollars * 100) : null,
		}))
	const plan = model.charges.find((charge) => charge.kind === "plan")
	const planLine =
		plan === undefined
			? []
			: [
					{
						key: plan.key,
						label: `${sentenceCasePlanName(plan.name)} plan`,
						detail: detailOf(plan),
						cents: baseKnown
							? model.baseCents - addOnLines.reduce((sum, line) => sum + (line.cents ?? 0), 0)
							: null,
					},
				]
	const drivers = model.features.filter((feature) => feature.overageCents > 0)
	return [
		...planLine,
		...addOnLines,
		{
			key: "overage",
			label: "Usage overage",
			detail:
				drivers.length === 0
					? "Nothing past what's included so far"
					: `${joinFeatureLabels(drivers.map((feature) => feature.label))} past what's included, per feature in Usage`,
			cents: model.overageCents,
		},
	]
}

export interface CumulativePoint {
	readonly date: string
	/** Epoch ms at the start of this UTC day. */
	readonly dayMs: number
	/**
	 * Cumulative dollars, by band, at the end of this day. `null` on days that
	 * haven't happened: the stacked area has to STOP at today rather than run flat
	 * to the end of the cycle, which would read as "spend stops here".
	 */
	readonly base: number | null
	readonly logs: number | null
	readonly traces: number | null
	readonly metrics: number | null
	readonly browser_sessions: number | null
	readonly product_events: number | null
	/** Cumulative total so far, for the tooltip. `null` for future days. */
	readonly total: number | null
	/**
	 * The projection line: defined only at today (today's actual total) and at the
	 * final day of the cycle (the projected total), so a straight dashed segment
	 * connects where spend is to where it lands.
	 */
	readonly projected: number | null
	/** True for days that haven't happened yet. */
	readonly future: boolean
}

/**
 * Cumulative spend by feature, day by day.
 *
 * Overage only accrues after the included allotment is crossed, so this walks
 * the daily volumes forward and prices each day's *incremental* over-allotment
 * units. Charting each day's raw volume × rate instead would bill the first
 * (included) GB of the cycle and the chart would start above zero.
 *
 * The base fee is a flat band from day 1: it's owed on day 1, and drawing it as
 * an accruing slope would tell the customer their subscription is metered.
 *
 * The daily *shape* comes from the warehouse, but the cycle *total* comes from
 * the billing provider's meter — the number the invoice is built from. Those two
 * can disagree (a metering gap, a backfill, a replayed export), so each feature's
 * series is scaled to land on the metered total. Without that, the chart's last
 * point contradicts the "spend so far" KPI directly above it, and the customer
 * has no way to tell which one is their bill.
 */
export function buildCumulativeSeries({
	daily,
	model,
}: {
	readonly daily: DailySpendResponse | undefined
	readonly model: SpendModel
}): ReadonlyArray<CumulativePoint> {
	if (!daily || daily.days.length === 0) return []

	const baseDollars = model.baseCents / 100

	const volumeOf = (day: DailySpendResponse["days"][number], featureId: SpendFeatureId): number =>
		featureId === "logs"
			? day.logsGB
			: featureId === "traces"
				? day.tracesGB
				: featureId === "metrics"
					? day.metricsGB
					: featureId === "browser_sessions"
						? day.browserSessions
						: (day.productEvents ?? 0)

	const byFeature = new Map<
		SpendFeatureId,
		{ used: number; included: number; rate: number; scale: number }
	>()
	for (const feature of model.features) {
		const warehouseTotal = daily.days.reduce((sum, day) => sum + volumeOf(day, feature.featureId), 0)
		byFeature.set(feature.featureId, {
			used: 0,
			included: feature.unlimited
				? Number.POSITIVE_INFINITY
				: (feature.included ?? Number.POSITIVE_INFINITY),
			rate: feature.ratePerUnit ?? 0,
			// Only scale when both sides have something to compare; otherwise the
			// warehouse shape stands on its own.
			scale: warehouseTotal > 0 && feature.used > 0 ? feature.used / warehouseTotal : 1,
		})
	}

	const accrued: Record<SpendFeatureId, number> = {
		logs: 0,
		traces: 0,
		metrics: 0,
		browser_sessions: 0,
		product_events: 0,
	} satisfies Record<SpendFeatureId, number>

	const todayMs = Math.floor(model.cycle.nowMs / DAY_MS) * DAY_MS
	const lastDay = daily.days[daily.days.length - 1]
	const lastDayMs = lastDay ? Date.parse(`${lastDay.date}T00:00:00Z`) : todayMs
	const projectedTotal = model.projectedCents / 100

	return daily.days.map((day) => {
		const dayMs = Date.parse(`${day.date}T00:00:00Z`)
		const future = dayMs > todayMs

		if (!future) {
			for (const featureId of SPEND_FEATURES) {
				const state = byFeature.get(featureId)
				if (!state) continue
				const before = Math.max(0, state.used - state.included)
				state.used += volumeOf(day, featureId) * state.scale
				const after = Math.max(0, state.used - state.included)
				accrued[featureId] += (after - before) * state.rate
			}
		}

		const total =
			baseDollars +
			accrued.logs +
			accrued.traces +
			accrued.metrics +
			accrued.browser_sessions +
			accrued.product_events

		// Two anchors only. Recharts joins them into one straight dashed segment,
		// which is the honest shape for a linear projection — a curve through
		// interpolated points would imply we know the days in between.
		const projected =
			dayMs === todayMs ? total : dayMs === lastDayMs && lastDayMs > todayMs ? projectedTotal : null

		return {
			date: day.date,
			dayMs,
			base: future ? null : baseDollars,
			logs: future ? null : accrued.logs,
			traces: future ? null : accrued.traces,
			metrics: future ? null : accrued.metrics,
			browser_sessions: future ? null : accrued.browser_sessions,
			product_events: future ? null : accrued.product_events,
			total: future ? null : total,
			projected,
			future,
		}
	})
}
