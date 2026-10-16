/**
 * The pricing FAQ, resolved once for every representation of the page.
 *
 * `/pricing`, its `/ja` and `/ko` twins, and the agent-readable `/pricing.md`
 * all render this list. It lived inline in each page before, which is how the
 * localized pages ended up hardcoding an older English answer while the main
 * page read the catalog. Answers that quote a number take it from `getOffer()`
 * so the FAQ can't disagree with the offer card above it.
 *
 * Messages are called inside the function, not at module scope: Paraglide
 * resolves the locale per render (see `pricing-offer.ts`).
 */
import * as m from "../paraglide/messages.js"
import { getOffer, money, rateLabel, volume } from "./pricing-offer"

export interface FaqItem {
	question: string
	answer: string
}

export async function pricingFaq(): Promise<FaqItem[]> {
	const offer = await getOffer()
	const gb = offer.allotments.find((a) => a.unit === "gb")
	const sessions = offer.allotments.find((a) => a.unit === "sessions")

	const includedGB = String(gb?.included ?? 0)
	const gbRate = rateLabel(gb?.rate ?? 0)
	const includedSessions = (sessions?.included ?? 0).toLocaleString("en-US")
	const sessionRate = rateLabel(sessions?.rate ?? 0)
	// Quote an events rate only when the catalog prices them; an unlimited item has none.
	const events = offer.allotments.find((a) => a.unit === "events")
	const eventsAnswer =
		events === undefined || events.unlimited || events.rate === undefined
			? m.faq_events_beta()
			: m.faq_events_priced({ included: volume(events, events.included), rate: money(events.rate) })

	return [
		{ question: m.faq_measure_q(), answer: m.faq_measure_a({ included: includedGB }) },
		{ question: m.faq_limits_q(), answer: m.faq_limits_a() },
		{ question: m.faq_spend_q(), answer: m.faq_spend_a() },
		{ question: m.faq_metrics_q(), answer: m.faq_metrics_a({ included: includedGB, rate: gbRate }) },
		{
			question: m.faq_sessions_q(),
			answer: `${m.faq_sessions_a({ included: includedSessions, rate: sessionRate })} ${eventsAnswer}`,
		},
		{ question: m.faq_retention_q(), answer: m.faq_retention_a() },
		{ question: m.faq_trial_q(), answer: m.faq_trial_a() },
		{ question: m.faq_otel_q(), answer: m.faq_otel_a() },
		{ question: m.faq_selfhost_q(), answer: m.faq_selfhost_a() },
		{ question: m.faq_region_q(), answer: m.faq_region_a() },
	]
}
