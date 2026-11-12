// Cloudflare billing as `cost_daily` rows: usage charges per day and priced metric, and each paid
// subscription's fee on the day its billing period starts.
import { DateTime, Array as Arr, Record as Rec, String as Str } from "effect"
import type { CostPullRow, CostPullWindow } from "../../CostProvider"
import type { Subscription, UsageRow } from "./cloudflare-billing-api"

/** FOCUS `ServiceCategory` of each Cloudflare product family; one not listed is "Other". */
const FAMILY_CATEGORIES = new Map([
	["Workers", "Compute"],
	["Durable Objects", "Compute"],
	["Containers", "Compute"],
	["Queues", "Compute"],
	["R2", "Storage"],
	["D1", "Databases"],
	["Workers KV", "Databases"],
	["Workers AI", "AI and Machine Learning"],
])
const OTHER_CATEGORY = "Other"

/** `CloudService` of every subscription fee: the plans are not products with usage of their own. */
const SUBSCRIPTIONS_SERVICE = "Subscriptions"

const dayOf = (timestamp: string): string => Str.slice(0, 10)(timestamp)

const inWindow = (day: string, window: CostPullWindow): boolean =>
	day >= window.startDay && day <= window.endDay

// NUL cannot be in a day, a name or a currency, so the key keeps the parts apart.
const keyOf = (parts: ReadonlyArray<string>): string => Arr.join(parts, "\u0000")

const sum = <A>(items: ReadonlyArray<A>, of: (item: A) => number): number =>
	Arr.reduce(items, 0, (total, item) => total + of(item))

/**
 * The window's usage charges, one row per day, product and priced metric. Cloudflare answers a
 * row for every metric every day, and most are inside the included allowance: a row with no
 * billed and no list cost is left out. Days from `openDay` on can still change.
 */
export const toUsageRows = (
	items: ReadonlyArray<UsageRow>,
	accountId: string,
	window: CostPullWindow,
	openDay: string,
): ReadonlyArray<CostPullRow> => {
	const charged = Arr.filter(
		items,
		(item) =>
			inWindow(dayOf(item.ChargePeriodStart), window) && (item.BilledCost !== 0 || item.ListCost !== 0),
	)
	// A day's rows are replaced whole and read per key, so two rows of one key would count once.
	const groups = Arr.groupBy(charged, (item) =>
		keyOf([
			dayOf(item.ChargePeriodStart),
			item.ServiceFamilyName ?? "",
			item.ServiceName,
			item.BillingCurrency,
		]),
	)
	return Arr.map(Rec.values(groups), (group): CostPullRow => {
		const first = Arr.headNonEmpty(group)
		const day = dayOf(first.ChargePeriodStart)
		const family = first.ServiceFamilyName ?? ""
		return {
			day,
			accountId,
			cloudService: family,
			serviceCategory: FAMILY_CATEGORIES.get(family) ?? OTHER_CATEGORY,
			usageType: first.ServiceName,
			region: "global",
			resourceId: "",
			resourceType: "",
			serviceName: "",
			chargeCategory: "usage",
			basis: "billed",
			currency: first.BillingCurrency,
			billedCost: sum(group, (item) => item.BilledCost),
			effectiveCost: sum(group, (item) => item.EffectiveCost),
			listCost: sum(group, (item) => item.ListCost),
			consumedQuantity: sum(group, (item) => item.ConsumedQuantity ?? 0),
			consumedUnit: first.ConsumedUnit ?? "",
			tags: {},
			estimated: day >= openDay,
		}
	})
}

/** States whose listed price was not charged: a trial is free, the other two were never paid. */
const UNCHARGED_STATES = ["Trial", "Failed", "Expired"]

/** Monthly periods a fee is stepped back over: the sync reads a year, and a period starts within the last month. */
const MONTHLY_PERIODS = 14

/** `day` moved back by `months`, on the same day of the month or the month's last. */
const monthsBefore = (day: string, months: number): string =>
	DateTime.formatIsoDateUtc(DateTime.subtract(DateTime.makeUnsafe(`${day}T00:00:00Z`), { months }))

/** The days in the window a subscription's billing period started on, by how often it bills. */
const periodStarts = (subscription: Subscription, window: CostPullWindow): ReadonlyArray<string> => {
	const start = subscription.current_period_start
	if (start === undefined || start === null) return []
	const current = dayOf(start)
	const created = dayOf(subscription.created_date ?? "")
	const starts =
		subscription.frequency === "monthly"
			? Arr.makeBy(MONTHLY_PERIODS, (months) => monthsBefore(current, months))
			: subscription.frequency === "yearly"
				? [current]
				: []
	return Arr.filter(starts, (day) => inWindow(day, window) && day >= created)
}

/**
 * Each paid subscription's fee, as a purchase on the days its billing periods started in the window.
 * Cloudflare reports the current period only: earlier ones use today's price, as if it never changed.
 */
export const toSubscriptionRows = (
	subscriptions: ReadonlyArray<Subscription>,
	accountId: string,
	window: CostPullWindow,
	openDay: string,
): ReadonlyArray<CostPullRow> => {
	const fees = Arr.flatMap(subscriptions, (subscription) => {
		const price = subscription.price ?? 0
		return price > 0 && !Arr.contains(UNCHARGED_STATES, subscription.state ?? "")
			? Arr.map(periodStarts(subscription, window), (day) => ({
					day,
					price,
					plan: subscription.rate_plan?.public_name ?? subscription.product?.name ?? "",
					zone: subscription.zone?.name ?? "",
					currency: subscription.currency ?? "USD",
				}))
			: []
	})
	// Two subscriptions to one plan (and zone) on one day are one key, so their fees add up.
	const groups = Arr.groupBy(fees, (fee) => keyOf([fee.day, fee.plan, fee.zone, fee.currency]))
	return Arr.map(Rec.values(groups), (group): CostPullRow => {
		const first = Arr.headNonEmpty(group)
		const price = sum(group, (fee) => fee.price)
		return {
			day: first.day,
			accountId,
			cloudService: SUBSCRIPTIONS_SERVICE,
			serviceCategory: OTHER_CATEGORY,
			usageType: first.plan,
			region: "global",
			resourceId: first.zone,
			resourceType: first.zone === "" ? "" : "zone",
			serviceName: "",
			chargeCategory: "purchase",
			basis: "billed",
			currency: first.currency,
			billedCost: price,
			effectiveCost: price,
			listCost: price,
			consumedQuantity: 0,
			consumedUnit: "",
			tags: {},
			estimated: first.day >= openDay,
		}
	})
}
