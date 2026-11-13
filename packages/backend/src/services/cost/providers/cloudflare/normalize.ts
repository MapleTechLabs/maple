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
		const unit = first.ConsumedUnit ?? ""
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
			// Rows of one key are one cost. Only quantities in the row's own unit add up.
			consumedQuantity: sum(group, (item) =>
				(item.ConsumedUnit ?? "") === unit ? (item.ConsumedQuantity ?? 0) : 0,
			),
			consumedUnit: unit,
			tags: {},
			estimated: day >= openDay,
		}
	})
}

/** States whose listed price was not charged: a trial is free, the other two were never paid. */
const UNCHARGED_STATES = ["Trial", "Failed", "Expired"]

/** Months back a fee is stepped over: the sync reads a year, and a period starts within the last one. */
const MONTHS_BACK = 14

/** How often a subscription bills, as the step between its period starts and how many reach `MONTHS_BACK`. */
const FREQUENCIES = new Map<
	string,
	{ readonly step: { readonly months?: number; readonly days?: number }; readonly periods: number }
>([
	["weekly", { step: { days: 7 }, periods: 62 }],
	["monthly", { step: { months: 1 }, periods: MONTHS_BACK }],
	["quarterly", { step: { months: 3 }, periods: 5 }],
	// A year back is before anything the sync reads.
	["yearly", { step: { months: 12 }, periods: 1 }],
])

const monthOf = (day: string): string => Str.slice(0, 7)(day)
const dayOfMonth = (day: string): number => Number(Str.slice(8, 10)(day))
/** A month step can only move a start earlier in its month from this day on. */
const SHORTEST_MONTH_DAYS = 28

/**
 * The days a subscription's billing periods started on, newest first: stepped back from the
 * current one, never before the subscription was made. None when it cannot be placed on a day.
 */
const periodStarts = (subscription: Subscription): ReadonlyArray<string> => {
	const start = subscription.current_period_start
	const frequency = FREQUENCIES.get(subscription.frequency ?? "")
	if (start === undefined || start === null || frequency === undefined) return []
	const current = dayOf(start)
	const made = subscription.created_date
	// Without the day it was made there is no telling which earlier periods existed: only this one.
	if (made === undefined || made === null) return [current]
	const created = dayOf(made)
	const from = DateTime.makeUnsafe(`${current}T00:00:00Z`)
	const starts = Arr.makeBy(frequency.periods, (index) => {
		const day = DateTime.formatIsoDateUtc(
			DateTime.subtract(from, {
				months: (frequency.step.months ?? 0) * index,
				days: (frequency.step.days ?? 0) * index,
			}),
		)
		// A start on the 29th to 31st is clamped in shorter months, which shifts every step before
		// it: the first period then lands days before the subscription was made, in the same month.
		const isClamped =
			frequency.step.months !== undefined &&
			day < created &&
			monthOf(day) === monthOf(created) &&
			dayOfMonth(day) >= SHORTEST_MONTH_DAYS
		return isClamped ? created : day
	})
	return Arr.dedupe(Arr.filter(starts, (day) => day >= created))
}

/** Whether a subscription's listed price is charged: it has one, and its state is not a free or unpaid one. */
const isCharged = (subscription: Subscription): boolean =>
	(subscription.price ?? 0) > 0 && !Arr.contains(UNCHARGED_STATES, subscription.state ?? "")

/** Charged subscriptions whose fee is in no row: they bill by a frequency Maple does not step, or name no period. */
export const unplacedFees = (subscriptions: ReadonlyArray<Subscription>): number =>
	Arr.filter(
		subscriptions,
		(subscription) => isCharged(subscription) && periodStarts(subscription).length === 0,
	).length

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
		return isCharged(subscription)
			? Arr.map(
					Arr.filter(periodStarts(subscription), (day) => inWindow(day, window)),
					(day) => ({
						day,
						price,
						plan: subscription.rate_plan?.public_name ?? subscription.product?.name ?? "",
						zone: subscription.zone?.name ?? "",
						currency: subscription.currency ?? "USD",
					}),
				)
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
