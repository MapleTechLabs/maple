/**
 * What a feature costs, how long it keeps data, and where its setup doc is:
 * the facts a buyer or an agent asks a feature page for first.
 *
 * Rates come from `getOffer()`, the same source as `/pricing` and `/pricing.md`,
 * so a feature page can't quote a different number. Retention mirrors
 * `/docs/reference/retention`. Messages are called inside the functions, never
 * at module scope (`page-registry.ts` rule 1).
 */
import * as m from "../paraglide/messages.js"
import { Array as Arr } from "effect"
import {
	isUsageCredit,
	money,
	rateBlock,
	rateLabel,
	volume,
	type Allotment,
	type Offer,
} from "./pricing-offer"

/** The Autumn features a page's data is billed under. */
export type MeterId = "traces" | "logs" | "metrics" | "browser_sessions" | "product_events" | "ai_credits"

export interface FeaturePlan {
	/** Empty when the feature has no meter of its own. */
	meters: MeterId[]
	retention: (() => string) | null
	/** A hard allowance or other limit worth stating, e.g. a monitor count. */
	limit: (() => string) | null
	/** Docs path for setting the feature up, e.g. "/docs/explore/traces". Null when no page covers it. */
	docs: string | null
}

export interface PlanRow {
	key: string
	value: string
}

const rateText = (a: Allotment): string => {
	if (a.unlimited) return m.pricing_free_beta()
	if (isUsageCredit(a) || a.rate === undefined) return m.pricing_rate_ai_usage()
	const rate = rateLabel(a.rate)
	if (a.unit === "sessions") return m.pricing_rate_session({ rate })
	if (a.unit === "events") return m.pricing_rate_events({ rate, block: rateBlock(a) })
	return m.pricing_rate_gb({ rate })
}

/** "Traces: 100 GB included, then $0.30 / GB". */
export const meterLine = (a: Allotment): string =>
	`${a.label}: ${m.pricing_rate_included({ amount: volume(a, a.included) })}, ${rateText(a)}`

export const planRows = (plan: FeaturePlan, offer: Offer): PlanRow[] => {
	const price = `${money(offer.price)}${offer.interval ?? ""}`
	const trialDays = offer.hasTrial ? (offer.trialDuration ?? 0) : 0
	const meters = Arr.filter(offer.allotments, (a) => Arr.some(plan.meters, (id) => id === a.featureId))

	return [
		{
			key: m.feat_plan_row_plan(),
			value:
				trialDays > 0
					? m.feat_plan_value_trial({ name: offer.name, price, days: String(trialDays) })
					: m.feat_plan_value({ name: offer.name, price }),
		},
		{
			key: m.feat_plan_row_billed(),
			value: meters.length > 0 ? Arr.join(Arr.map(meters, meterLine), " · ") : m.feat_plan_no_meter(),
		},
		...(plan.retention ? [{ key: m.feat_plan_row_retention(), value: plan.retention() }] : []),
		...(plan.limit ? [{ key: m.feat_plan_row_limit(), value: plan.limit() }] : []),
	]
}
