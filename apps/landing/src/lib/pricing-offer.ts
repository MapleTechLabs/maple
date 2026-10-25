/**
 * The single priced offer, resolved from Autumn.
 *
 * Lifted out of `PricingTable.astro` so the HTML pricing page and the
 * agent-readable `/pricing.md` twin render the same numbers by construction.
 * A second source of truth here would be a pricing page that disagrees with
 * itself depending on which representation a reader got.
 *
 * **Messages are called inside the exported functions, never at module scope.**
 * Paraglide resolves the active locale per call through an AsyncLocalStorage the
 * astro integration sets up around each page render (see `page-registry.ts`
 * rule 1). Module scope evaluates once per build, so a module-level
 * `label: m.pricing_logs()` freezes whichever locale rendered first and every
 * other locale inherits it.
 */
import { PRICING_CARD_FEATURE_IDS, isPricingCardFeature } from "@maple/domain/billing"
import { Autumn } from "autumn-js"
import * as m from "../paraglide/messages.js"

const AUTUMN_API_VERSION = "2.3.0"

/**
 * browser_sessions is metered per session, product_events per event, and
 * ai_credits in dollars of model usage; every other signal is per GB.
 */
export type Unit = "gb" | "sessions" | "events" | "usd"

export interface Allotment {
	featureId: string
	label: string
	unit: Unit
	included: number
	/**
	 * Autumn `unlimited`: no cap and no overage. The row reads "Unlimited · free
	 * during beta" instead of a number and a rate. `included`/`rate` are ignored.
	 */
	unlimited?: boolean
	/** Price per `rateUnits` units once `included` is used up. */
	rate?: number
	/**
	 * Units the rate is quoted per: 1 for GB and sessions, 1M for events. Autumn's
	 * `billingUnits` except for events, which bill per 1,000 but are quoted per
	 * million. The rate is the price of one such block.
	 */
	rateUnits: number
}

export interface Offer {
	name: string
	price: number
	interval?: string
	hasTrial: boolean
	trialDuration?: number
	allotments: Allotment[]
	ctaLabel: string
}

/** Canonical row order: Autumn can return items in any order. */
const DATA_FEATURE_ORDER: ReadonlyArray<string> = PRICING_CARD_FEATURE_IDS

const dataFeatureRank = (id: string) => DATA_FEATURE_ORDER.indexOf(id)

const FEATURE_UNITS = {
	browser_sessions: "sessions",
	product_events: "events",
	ai_credits: "usd",
} as const satisfies Record<string, Unit>

const hasOwnUnit = (featureId: string): featureId is keyof typeof FEATURE_UNITS => featureId in FEATURE_UNITS

const unitFor = (featureId: string): Unit => (hasOwnUnit(featureId) ? FEATURE_UNITS[featureId] : "gb")

/** "$5 / 1M events" reads better than the billed "$0.005 / 1,000 events". */
const EVENTS_QUOTE_UNITS = 1_000_000

/**
 * Capitalized, localized labels for the metered rows, keyed by Autumn featureId
 * (Autumn returns lowercase names like "logs").
 */
const dataFeatureLabels = (): Record<string, string> => ({
	logs: m.pricing_logs(),
	traces: m.pricing_traces(),
	metrics: m.pricing_metrics(),
	browser_sessions: m.nav_browser_sessions(),
	product_events: m.pricing_product_events(),
	ai_credits: m.pricing_ai_usage(),
})

/**
 * Everything the plan carries, as one run. With a single plan there is nothing
 * to compare against, so this is a "and all of this too" line rather than a
 * checklist, since a checklist implies some rows might have been withheld.
 */
export const platformFeatures = (): string[] => [
	m.pricing_30day_retention(),
	m.pricing_private_channel(),
	m.pricing_unlimited_dashboards(),
	m.pricing_advanced_alerting(),
	m.pricing_mcp_server(),
	m.pricing_ai_chat(),
	m.pricing_ai_triage(),
	m.pricing_full_api(),
]

/**
 * The live offer, or the `autumn.config.ts` mirror if Autumn is unreachable at
 * build time. The fallback carries browser sessions and product events too, since a
 * short fallback would render a meter that disagrees with the live one.
 */
export async function getOffer(): Promise<Offer> {
	const labels = dataFeatureLabels()

	try {
		const autumn = new Autumn({
			secretKey: import.meta.env.AUTUMN_SECRET_KEY,
			xApiVersion: AUTUMN_API_VERSION,
		})
		const result = await autumn.plans.list()
		const products = (result.list ?? []).filter((p) => !p.addOn)

		if (products.length > 1) {
			// The layout renders one offer. A second tier must fail loudly at build
			// time rather than silently vanishing off the pricing page.
			console.warn(
				`[pricing-offer] Autumn returned ${products.length} non-add-on plans (${products
					.map((p) => p.id)
					.join(", ")}); only the first is rendered. Update PricingTable for multiple tiers.`,
			)
		}

		const product = products[0]

		if (product) {
			return {
				name: product.name,
				price: product.price?.amount ?? 0,
				interval: product.price?.interval ? `/${product.price.interval}` : undefined,
				hasTrial: !!product.freeTrial,
				trialDuration: product.freeTrial?.durationLength,
				allotments: product.items
					.filter((item) => isPricingCardFeature(item.featureId))
					.map((item) => {
						const featureId = item.featureId
						const unit = unitFor(featureId)
						const billingUnits = Math.max(1, item.price?.billingUnits ?? 1)
						const rateUnits = unit === "events" ? EVENTS_QUOTE_UNITS : billingUnits
						const amount = item.price?.amount
						return {
							featureId,
							label: labels[featureId] ?? item.feature?.name ?? featureId,
							unit,
							included: Number(item.included ?? 0),
							unlimited: item.unlimited === true,
							rate: amount == null ? undefined : (amount / billingUnits) * rateUnits,
							rateUnits,
						}
					})
					.sort((a, b) => dataFeatureRank(a.featureId) - dataFeatureRank(b.featureId)),
				ctaLabel: product.freeTrial
					? m.pricing_start_trial({ duration: String(product.freeTrial.durationLength) })
					: m.cta_get_started(),
			}
		}
	} catch (e) {
		console.error("Failed to fetch pricing from Autumn:", e)
	}

	return {
		name: "Startup",
		price: 39,
		interval: "/month",
		hasTrial: true,
		trialDuration: 14,
		allotments: [
			{ featureId: "logs", label: labels.logs!, unit: "gb", included: 100, rate: 0.3, rateUnits: 1 },
			{
				featureId: "traces",
				label: labels.traces!,
				unit: "gb",
				included: 100,
				rate: 0.3,
				rateUnits: 1,
			},
			{
				featureId: "metrics",
				label: labels.metrics!,
				unit: "gb",
				included: 100,
				rate: 0.3,
				rateUnits: 1,
			},
			{
				featureId: "browser_sessions",
				label: labels.browser_sessions!,
				unit: "sessions",
				included: 5000,
				rate: 0.002,
				rateUnits: 1,
			},
			{
				featureId: "product_events",
				label: labels.product_events!,
				unit: "events",
				// Mirrors `apps/api/autumn.config.ts`: $0.005 per 1,000, quoted per 1M.
				included: 1_000_000,
				rate: 5,
				rateUnits: EVENTS_QUOTE_UNITS,
			},
			{
				featureId: "ai_credits",
				label: labels.ai_credits!,
				unit: "usd",
				included: 10,
				rate: 1,
				rateUnits: 1,
			},
		],
		ctaLabel: m.pricing_start_trial({ duration: "14" }),
	}
}

// ── Formatting ───────────────────────────────────────────────────────────────
// Every number on the pricing surface is money or volume, so it all runs
// through one of these three.

const round2 = (n: number) => Math.round(n * 100) / 100

export const money = (n: number) => {
	const r = round2(n)
	return Number.isInteger(r) ? `$${r}` : `$${r.toFixed(2)}`
}

/** Sub-cent rates (per session) need three places; per-GB rates need two. */
export const rateLabel = (n: number) => `$${n < 0.01 ? n.toFixed(3) : n.toFixed(2)}`

/** Whole millions as "1M"; anything else exact. */
const count = (n: number) =>
	n >= 1_000_000 && n % 1_000_000 === 0 ? `${n / 1_000_000}M` : n.toLocaleString("en-US")

/**
 * The block a rate is quoted per, for the "then {rate} / …" sentence: 1 for
 * GB and sessions, "1M" for events. Localized unit words come from the
 * message catalog; this only supplies the number.
 */
export const rateBlock = (a: Allotment) => count(a.rateUnits)

export const volume = (a: Allotment, n: number) =>
	a.unlimited ? m.pricing_unlimited() : a.unit === "gb" ? `${n} GB` : a.unit === "usd" ? money(n) : count(n)

/**
 * AI usage has no flat rate: a credit is a dollar of model spend, priced per
 * model from its token rates, so the row states how it bills instead of "$1 / $1".
 */
export const isUsageCredit = (a: Allotment) => a.unit === "usd"
