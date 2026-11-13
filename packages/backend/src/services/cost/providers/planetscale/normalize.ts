// PlanetScale invoices as `cost_daily` rows. An invoice is a month, so each line item is spread
// evenly over the days of the month its branch existed, then summed per day, database, branch and SKU.
// The resource is `database/branch`: a branch's name alone repeats across databases.
import { DateTime, Array as Arr, Record as Rec, String as Str } from "effect"
import type { CostPullRow, CostPullWindow } from "../../CostProvider"
import { daysOfWindow, maxDay, minDay } from "../../sync-plan"
import type { Invoice, InvoiceLineItem } from "./invoices-api"

/** FOCUS `ServiceCategory` of every PlanetScale charge. */
const SERVICE_CATEGORY = "Databases"
/** The service of a line that names no database and has no description. */
const UNNAMED_SERVICE = "PlanetScale"

export interface InvoiceWithLineItems {
	readonly invoice: Invoice
	readonly lineItems: ReadonlyArray<InvoiceLineItem>
}

const dayOf = (instant: DateTime.Utc): string => DateTime.formatIsoDateUtc(instant)

const dayOrElse = (instant: DateTime.Utc | null | undefined, orElse: string): string =>
	instant === null || instant === undefined ? orElse : dayOf(instant)

/** The days an invoice bills, both inclusive. Its end is exclusive: the first instant of the next period. */
export const invoicePeriod = (invoice: Invoice): CostPullWindow => {
	const startDay = dayOf(invoice.billing_period_start)
	const lastDay = dayOf(DateTime.subtract(invoice.billing_period_end, { milliseconds: 1 }))
	return { startDay, endDay: maxDay(startDay, lastDay) }
}

/** Whether any day of `period` is in `window`. */
export const periodInWindow = (period: CostPullWindow, window: CostPullWindow): boolean =>
	period.startDay <= window.endDay && period.endDay >= window.startDay

/**
 * The days of `period` a line's charge belongs to: from the day its branch was made to the day it
 * was deleted, inside the period. The whole period for a line with no branch, or one whose branch
 * dates lie outside it.
 */
export const chargedDays = (
	period: CostPullWindow,
	resource: InvoiceLineItem["resource"],
): ReadonlyArray<string> => {
	const startDay = maxDay(period.startDay, dayOrElse(resource?.created_at, period.startDay))
	const endDay = minDay(period.endDay, dayOrElse(resource?.deleted_at, period.endDay))
	return daysOfWindow(startDay > endDay ? period : { startDay, endDay })
}

export interface DayShare {
	readonly day: string
	readonly amount: number
}

/** `amount` in equal shares over `days`. The last day takes what rounding left, so they add up to it. */
export const spreadEvenly = (amount: number, days: ReadonlyArray<string>): ReadonlyArray<DayShare> => {
	const share = amount / days.length
	const last = days.length - 1
	// What the days before the last add up to, added as a reader of the rows adds them.
	const before = Arr.reduce(Arr.dropRight(days, 1), 0, (sum) => sum + share)
	return Arr.map(days, (day, index) => ({ day, amount: index === last ? amount - before : share }))
}

interface LineShare extends DayShare {
	readonly cloudService: string
	readonly usageType: string
	readonly resourceId: string
	readonly resourceType: string
}

const sharesOfLine = (
	line: InvoiceLineItem,
	period: CostPullWindow,
	window: CostPullWindow,
): ReadonlyArray<LineShare> => {
	const resource = line.resource ?? undefined
	const branch = resource?.name ?? ""
	const database = line.database_name ?? ""
	const named = {
		cloudService: line.database_name ?? line.description ?? UNNAMED_SERVICE,
		usageType: line.metric_name ?? "",
		// With its database: nearly every database has a `main`, and they are not one resource.
		resourceId: branch === "" || database === "" ? branch : `${database}/${branch}`,
		resourceType: resource === undefined ? "" : Str.toLowerCase(resource.type ?? "branch"),
	}
	return Arr.map(
		Arr.filter(
			spreadEvenly(line.subtotal, chargedDays(period, resource)),
			(share) => share.day >= window.startDay && share.day <= window.endDay,
		),
		(share) => ({ ...share, ...named }),
	)
}

/**
 * The window's days of the invoices that bill them. A discount line is negative and spread like
 * its charge, so a branch's days net out to what it cost. A line of zero is left out. Days from
 * `openDay` on are not final, as every provider's newest days are. The shares of the whole open
 * month can still move until its invoice closes: the source row says so, since marking a month of
 * days would dim every other provider's days with it.
 */
export const toCostRows = (
	invoices: ReadonlyArray<InvoiceWithLineItems>,
	accountId: string,
	window: CostPullWindow,
	openDay: string,
): ReadonlyArray<CostPullRow> => {
	const shares = Arr.flatMap(invoices, ({ invoice, lineItems }) => {
		const period = invoicePeriod(invoice)
		return Arr.flatMap(lineItems, (line) =>
			line.subtotal === 0 ? [] : sharesOfLine(line, period, window),
		)
	})
	// NUL separates the four parts of the key: PlanetScale's names hold none.
	const groups = Arr.groupBy(shares, (share) =>
		Arr.join([share.day, share.cloudService, share.resourceId, share.usageType], "\u0000"),
	)
	return Arr.map(Rec.values(groups), (group): CostPullRow => {
		const first = Arr.headNonEmpty(group)
		const usd = Arr.reduce(group, 0, (sum, share) => sum + share.amount)
		return {
			day: first.day,
			accountId,
			cloudService: first.cloudService,
			serviceCategory: SERVICE_CATEGORY,
			usageType: first.usageType,
			region: "global",
			resourceId: first.resourceId,
			resourceType: first.resourceType,
			serviceName: "",
			chargeCategory: "usage",
			basis: "billed",
			currency: "USD",
			billedCost: usd,
			effectiveCost: usd,
			listCost: usd,
			consumedQuantity: 0,
			consumedUnit: "",
			tags: {},
			estimated: first.day >= openDay,
		}
	})
}
