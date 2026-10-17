const usageFormat = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })

type SizeUnit = "MB" | "GB" | "TB"
const SIZE_SCALE = { MB: 1 / 1000, GB: 1, TB: 1000 } satisfies Record<SizeUnit, number>

const sizeUnitFor = (gb: number): SizeUnit => (gb < 1 ? "MB" : gb >= 10_000 ? "TB" : "GB")

const formatIn = (gb: number, unit: SizeUnit): string => {
	const scaled = Math.max(0, Number.isFinite(gb) ? gb : 0) / SIZE_SCALE[unit]
	// A real but sub-hundredth amount reads as "<0.01", never as a flat zero.
	return scaled > 0 && scaled < 0.005 ? `<0.01 ${unit}` : `${usageFormat.format(scaled)} ${unit}`
}

export function formatUsage(gb: number): string {
	if (!Number.isFinite(gb) || gb <= 0) return "0 GB"
	return formatIn(gb, sizeUnitFor(gb))
}

/**
 * "0.00 GB of 100.00 GB": both sides in one unit and precision, chosen by the larger
 * amount, so a quiet feature never reads in a different unit than its neighbours.
 */
export function formatUsageAgainst(usedGb: number, includedGb: number): string {
	const unit = sizeUnitFor(Math.max(Number.isFinite(usedGb) ? usedGb : 0, includedGb))
	return `${formatIn(usedGb, unit)} of ${formatIn(includedGb, unit)}`
}

/**
 * Format a raw count for display: "0", "1,234", "1,200,000". Exact, unlike `formatNumber`
 * (which compacts to "1.2M"): billed quantities must read to the unit.
 */
export function formatCount(value: number): string {
	return Math.max(0, Math.round(value)).toLocaleString("en-US")
}

/**
 * Events bill per 1,000 (so overage rounds to half a cent) but are quoted per
 * million: "$5/1M events" reads better than "$0.005/1,000 events".
 */
const QUOTE_UNITS = { product_events: 1_000_000 } as const
const hasQuoteUnits = (featureId: string): featureId is keyof typeof QUOTE_UNITS => featureId in QUOTE_UNITS

/** Units a feature's rate is quoted per: its own quote block, else the catalog's `billingUnits`. */
export function quoteUnits(featureId: string, billingUnits: number): number {
	return hasQuoteUnits(featureId) ? QUOTE_UNITS[featureId] : billingUnits
}

/** A quote block as a label: "1M" for whole millions, else exact ("1,000"). */
export function formatQuoteUnits(units: number): string {
	return units >= 1_000_000 && units % 1_000_000 === 0 ? `${units / 1_000_000}M` : formatCount(units)
}
