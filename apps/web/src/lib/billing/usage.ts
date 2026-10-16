const usageFormat = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export function formatUsage(gb: number): string {
	if (!Number.isFinite(gb) || gb <= 0) return "0 GB"
	if (gb < 1) return `${(gb * 1000).toFixed(2)} MB`
	if (gb >= 10_000) return `${usageFormat.format(gb / 1000)} TB`
	return `${usageFormat.format(gb)} GB`
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
