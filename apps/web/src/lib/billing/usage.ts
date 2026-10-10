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
