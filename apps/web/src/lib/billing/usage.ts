export interface AggregatedUsage {
	logsGB: number
	tracesGB: number
	metricsGB: number
	/** Browser session count for the current billing cycle (track-only — no plan limit). */
	browserSessions: number
}

export function usagePercentage(usedGB: number, limitGB: number): number {
	if (limitGB === Infinity) return 0
	if (limitGB === 0) return 100
	return (usedGB / limitGB) * 100
}

export function formatUsage(gb: number): string {
	if (gb === 0) return "0 GB"
	if (gb < 1) return `${(gb * 1000).toFixed(2)} MB`
	return `${gb.toFixed(2)} GB`
}

/** Format a raw count for display: "0", "1,234", "1,200,000". */
export function formatCount(value: number): string {
	return Math.max(0, Math.round(value)).toLocaleString("en-US")
}

const usdFormatter = new Intl.NumberFormat("en-US", {
	style: "currency",
	currency: "USD",
	minimumFractionDigits: 2,
})

/** Format a USD amount: 1.5 -> "$1.50", 0.003 -> "$0.00". For costs/totals. */
export function formatCurrency(amount: number): string {
	return usdFormatter.format(amount)
}

const usdRateFormatter = new Intl.NumberFormat("en-US", {
	style: "currency",
	currency: "USD",
	minimumFractionDigits: 2,
	maximumFractionDigits: 4,
})

/** Format a per-unit price, keeping small fractions: 0.3 -> "$0.30", 0.003 -> "$0.003". */
export function formatRate(amount: number): string {
	return usdRateFormatter.format(amount)
}
