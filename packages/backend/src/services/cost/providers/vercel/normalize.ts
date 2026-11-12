// Vercel billing charges as `cost_daily` rows: one per day, product, SKU, project, region and kind of charge.
import { CostChargeCategory } from "@maple/domain/cost"
import { Array as Arr, Option, Schema, String as Str } from "effect"
import type { VercelCharge } from "../../../integrations/vercel/api"
import type { CostPullRow, CostPullWindow } from "../../CostProvider"

const decodeChargeCategory = Schema.decodeUnknownOption(CostChargeCategory)

/** A FOCUS `ChargeCategory` (`Usage`, `Credit`, ...) as the domain names it; one it does not know is `unknown`. */
const chargeCategoryOf = (value: string | null | undefined): CostChargeCategory =>
	Option.getOrElse(decodeChargeCategory(Str.toLowerCase(value ?? "")), (): CostChargeCategory => "unknown")

/** What a missing or empty field reads as. */
const orElse = (value: string | null | undefined, fallback: string): string =>
	value === undefined || value === null || value === "" ? fallback : value

/** One charge as a row of its day. Vercel reports no list price, so the billed cost stands in. */
const toCostRow = (charge: VercelCharge, accountId: string, openDay: string): CostPullRow => {
	const day = Str.slice(0, 10)(charge.ChargePeriodStart)
	const sku = orElse(charge.SkuId, "")
	const project = orElse(charge.Tags?.ProjectName, orElse(charge.Tags?.ProjectId, ""))
	return {
		day,
		accountId,
		cloudService: charge.ServiceName,
		serviceCategory: orElse(charge.ServiceCategory, "Other"),
		usageType: sku === charge.ServiceName ? "" : sku,
		region: orElse(charge.RegionId, "global"),
		resourceId: project,
		resourceType: project === "" ? "" : "project",
		serviceName: "",
		chargeCategory: chargeCategoryOf(charge.ChargeCategory),
		basis: "billed",
		currency: orElse(charge.BillingCurrency, "USD"),
		billedCost: charge.BilledCost,
		effectiveCost: charge.EffectiveCost ?? charge.BilledCost,
		listCost: charge.BilledCost,
		consumedQuantity: charge.ConsumedQuantity ?? 0,
		consumedUnit: orElse(charge.ConsumedUnit, ""),
		tags: {},
		estimated: day >= openDay,
	}
}

// NUL cannot be in any of the fields, so the key keeps them apart.
const keyOf = (row: CostPullRow): string =>
	Arr.join(
		[
			row.day,
			row.cloudService,
			row.usageType,
			row.resourceId,
			row.region,
			row.chargeCategory,
			row.currency,
		],
		"\u0000",
	)

/** The window's charges so far, summed by day, product, SKU, project, region and kind of charge. */
export type ChargeTotals = Map<string, CostPullRow>

export const emptyChargeTotals = (): ChargeTotals => new Map()

/**
 * Adds a charge to `totals`, in place; a charge of a day outside the window is left out. Days from
 * `openDay` on can still change: Vercel keeps counting a day for a while after it ends.
 */
export const addCharge = (
	totals: ChargeTotals,
	charge: VercelCharge,
	accountId: string,
	window: CostPullWindow,
	openDay: string,
): ChargeTotals => {
	const row = toCostRow(charge, accountId, openDay)
	if (row.day < window.startDay || row.day > window.endDay) return totals
	const key = keyOf(row)
	const sum = totals.get(key)
	return totals.set(
		key,
		sum === undefined
			? row
			: {
					...sum,
					billedCost: sum.billedCost + row.billedCost,
					effectiveCost: sum.effectiveCost + row.effectiveCost,
					listCost: sum.listCost + row.listCost,
					consumedQuantity: sum.consumedQuantity + row.consumedQuantity,
				},
	)
}

/** The rows worth storing: a sum Vercel billed nothing for is left out, a credit (negative) is kept. */
export const rowsOf = (totals: ChargeTotals): ReadonlyArray<CostPullRow> =>
	Arr.filter(Arr.fromIterable(totals.values()), (row) => row.billedCost !== 0 || row.effectiveCost !== 0)

/** A whole answer's charges as rows. The adapter folds the same way, line by line as they arrive. */
export const toCostRows = (
	charges: ReadonlyArray<VercelCharge>,
	accountId: string,
	window: CostPullWindow,
	openDay: string,
): ReadonlyArray<CostPullRow> =>
	rowsOf(
		Arr.reduce(charges, emptyChargeTotals(), (totals, charge) =>
			addCharge(totals, charge, accountId, window, openDay),
		),
	)
