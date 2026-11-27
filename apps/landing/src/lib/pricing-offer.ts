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
import { PRICING_CARD_FEATURE_IDS, TRIAL_PLAN_ID, isAdvertisedPricingFeature } from "@maple/domain/billing"
import * as m from "../paraglide/messages.js"
import { isStorageFeatureId } from "@maple/domain/storage-pricing"
import { Array as Arr, Effect, Option, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"

/** Same base URL and pinned version as the backend's `autumn-api.ts`. */
const AUTUMN_API_URL = "https://api.useautumn.com"
const AUTUMN_API_VERSION = "2.3.0"
const AUTUMN_PLANS_LIST_PATH = "/v1/plans.list"

const PlanItem = Schema.Struct({
	feature_id: Schema.String,
	feature: Schema.optionalKey(
		Schema.NullOr(Schema.Struct({ name: Schema.optionalKey(Schema.NullOr(Schema.String)) })),
	),
	included: Schema.optionalKey(Schema.NullOr(Schema.Number)),
	unlimited: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
	price: Schema.optionalKey(
		Schema.NullOr(
			Schema.Struct({
				amount: Schema.optionalKey(Schema.NullOr(Schema.Number)),
				billing_units: Schema.optionalKey(Schema.NullOr(Schema.Number)),
			}),
		),
	),
})

const Plan = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	add_on: Schema.Boolean,
	price: Schema.optionalKey(
		Schema.NullOr(
			Schema.Struct({
				amount: Schema.Number,
				interval: Schema.optionalKey(Schema.NullOr(Schema.String)),
			}),
		),
	),
	free_trial: Schema.optionalKey(Schema.NullOr(Schema.Struct({ duration_length: Schema.Number }))),
	items: Schema.Array(PlanItem),
})

/** The `POST /v1/plans.list` body, narrowed to the fields the offer reads. */
export const PlansListResponse = Schema.Struct({ list: Schema.Array(Plan) })
export type PlansListResponse = typeof PlansListResponse.Type

/**
 * browser_sessions is metered per session, product_events per event, ai_credits
 * in dollars of model usage and storage per GB-month; every other signal is per GB.
 */
export type Unit = "gb" | "gb_month" | "sessions" | "events" | "usd"

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
/** The card's one storage row: Autumn bills it per signal, each at the same rate. */
const STORAGE_ROW_ID = "storage"

const DATA_FEATURE_ORDER: ReadonlyArray<string> = Arr.flatMap(PRICING_CARD_FEATURE_IDS, (id) =>
	// Storage reads right after the GB signals whose volume it keeps.
	id === "metrics" ? [id, STORAGE_ROW_ID] : [id],
)

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
	m.pricing_ai_triage(),
	m.pricing_full_api(),
	m.pricing_audit_log(),
]

/**
 * Autumn's plans, or None when the key is missing or the call fails for any reason: the caller
 * falls back to the mirror, so a build never breaks on billing being down.
 */
export const loadPlans = (secretKey: string | undefined) =>
	Effect.gen(function* () {
		if (secretKey === undefined || secretKey === "") {
			return yield* Effect.fail("AUTUMN_SECRET_KEY is not set")
		}
		const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk)
		const request = HttpClientRequest.post(`${AUTUMN_API_URL}${AUTUMN_PLANS_LIST_PATH}`, {
			headers: { Authorization: `Bearer ${secretKey}`, "x-api-version": AUTUMN_API_VERSION },
		}).pipe(HttpClientRequest.bodyJsonUnsafe({}))
		const response = yield* client.execute(request)
		return yield* HttpClientResponse.schemaBodyJson(PlansListResponse)(response)
	}).pipe(
		Effect.asSome,
		Effect.catchCause((cause) =>
			Effect.as(Effect.logError("Failed to fetch pricing from Autumn", cause), Option.none()),
		),
	)

/**
 * One Autumn request per build: every feature page reads the offer, in three
 * locales. The response carries no localized text, so sharing it is safe; labels
 * are still resolved per call. The site is fully static, so nothing outlives a build.
 */
let plansRequest: Promise<Option.Option<PlansListResponse>> | undefined

const listPlans = () =>
	(plansRequest ??= Effect.runPromise(
		loadPlans(import.meta.env.AUTUMN_SECRET_KEY).pipe(Effect.provide(FetchHttpClient.layer)),
	))

/**
 * The live offer, or the `autumn.config.ts` mirror if Autumn is unreachable at
 * build time. The fallback carries browser sessions and product events too, since a
 * short fallback would render a meter that disagrees with the live one.
 */
export async function getOffer(): Promise<Offer> {
	return resolveOffer(await listPlans())
}

/** The offer from a plans.list response; the mirror when there is none or it has no base plan. */
export const resolveOffer = (plans: Option.Option<PlansListResponse>): Offer => {
	const labels = dataFeatureLabels()
	const list = Option.match(plans, { onNone: () => [], onSome: (r) => r.list })
	// The no-card trial is a plan of its own: it sets the trial copy, never a pricing tier.
	const trialPlan = Arr.findFirst(list, (p) => p.id === TRIAL_PLAN_ID)
	const products = Arr.filter(list, (p) => !p.add_on && p.id !== TRIAL_PLAN_ID)

	if (products.length > 1) {
		// The layout renders one offer. A second tier must fail loudly at build
		// time rather than silently vanishing off the pricing page.
		console.warn(
			`[pricing-offer] Autumn returned ${products.length} non-add-on plans (${Arr.join(
				Arr.map(products, (p) => p.id),
				", ",
			)}); only the first is rendered. Update PricingTable for multiple tiers.`,
		)
	}

	const product = products[0]
	if (product === undefined) return fallbackOffer(labels)
	const freeTrial =
		Option.flatMap(trialPlan, (p) => Option.fromNullishOr(p.free_trial)).pipe(Option.getOrUndefined) ??
		product.free_trial ??
		undefined
	const interval = product.price?.interval

	return {
		name: product.name,
		price: product.price?.amount ?? 0,
		interval: interval == null || interval === "" ? undefined : `/${interval}`,
		hasTrial: freeTrial !== undefined,
		trialDuration: freeTrial?.duration_length,
		allotments: Arr.map(
			Arr.filter(product.items, (item) => isAdvertisedPricingFeature(item.feature_id)),
			(item): Allotment => {
				const featureId = item.feature_id
				const unit = unitFor(featureId)
				const billingUnits = Math.max(1, item.price?.billing_units ?? 1)
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
			},
		)
			.concat(storageAllotment(product.items))
			.sort((a, b) => dataFeatureRank(a.featureId) - dataFeatureRank(b.featureId)),
		ctaLabel:
			freeTrial === undefined
				? m.cta_get_started()
				: m.pricing_start_trial({ duration: String(freeTrial.duration_length) }),
	}
}

/**
 * One storage row for the per-signal storage features, or none when the plan has none. The
 * rate is per GB-month: Autumn bills it per 0.01 GB-month, so it is not floored to one unit.
 */
const storageAllotment = (items: ReadonlyArray<typeof PlanItem.Type>): ReadonlyArray<Allotment> =>
	Option.match(
		Arr.findFirst(items, (item) => isStorageFeatureId(item.feature_id)),
		{
			onNone: () => [],
			onSome: (item) => {
				const amount = item.price?.amount
				const billingUnits = item.price?.billing_units ?? 1
				return [
					{
						featureId: STORAGE_ROW_ID,
						label: m.pricing_storage(),
						unit: "gb_month",
						included: 0,
						unlimited: item.unlimited === true,
						rate: amount == null || billingUnits <= 0 ? undefined : amount / billingUnits,
						rateUnits: 1,
					},
				]
			},
		},
	)

const fallbackOffer = (labels: Record<string, string>): Offer => ({
	name: "Startup",
	price: 39,
	interval: "/month",
	hasTrial: true,
	trialDuration: 14,
	allotments: [
		{ featureId: "logs", label: labels.logs, unit: "gb", included: 100, rate: 0.15, rateUnits: 1 },
		{
			featureId: "traces",
			label: labels.traces,
			unit: "gb",
			included: 100,
			rate: 0.15,
			rateUnits: 1,
		},
		{
			featureId: "metrics",
			label: labels.metrics,
			unit: "gb",
			included: 100,
			rate: 0.15,
			rateUnits: 1,
		},
		{
			featureId: STORAGE_ROW_ID,
			label: m.pricing_storage(),
			unit: "gb_month",
			included: 0,
			rate: 0.15,
			rateUnits: 1,
		},
		{
			featureId: "browser_sessions",
			label: labels.browser_sessions,
			unit: "sessions",
			included: 5000,
			rate: 0.002,
			rateUnits: 1,
		},
		{
			featureId: "product_events",
			label: labels.product_events,
			unit: "events",
			// Mirrors `apps/api/autumn.config.ts`: $0.005 per 1,000, quoted per 1M.
			included: 1_000_000,
			rate: 5,
			rateUnits: EVENTS_QUOTE_UNITS,
		},
		{
			featureId: "ai_credits",
			label: labels.ai_credits,
			unit: "usd",
			included: 10,
			rate: 1,
			rateUnits: 1,
		},
	],
	ctaLabel: m.pricing_start_trial({ duration: "14" }),
})

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
	a.unlimited
		? m.pricing_unlimited()
		: a.unit === "gb"
			? `${n} GB`
			: a.unit === "gb_month"
				? // Each signal's storage is included up to what its own volume needs at the default retention.
					m.pricing_storage_included()
				: a.unit === "usd"
					? money(n)
					: count(n)

/**
 * AI usage has no flat rate: a credit is a dollar of model spend, priced per
 * model from its token rates, so the row states how it bills instead of "$1 / $1".
 */
export const isUsageCredit = (a: Allotment) => a.unit === "usd"
