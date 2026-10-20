import { formatNumber, formatStorageBytes } from "@maple/ui/lib/format"

// How much a source stored: the list's Last 24h column and the overview's stat.

export type VolumeTotals = Readonly<{ spans: number; logs: number; metrics: number; bytes: number }>

/** "4.1K spans · 120 logs": the signals the source stored, zero ones left out. */
export const signalCounts = (totals: VolumeTotals): string => {
	const parts = [
		[totals.spans, "spans"],
		[totals.logs, "logs"],
		[totals.metrics, "metric points"],
	] as const
	const shown = parts.filter(([count]) => count > 0).map(([count, label]) => `${formatNumber(count)} ${label}`)
	return shown.length === 0 ? "Nothing stored" : shown.join(" · ")
}

/** Estimated stored size, in the decimal units billing uses. */
export const volumeSize = (totals: VolumeTotals): string => formatStorageBytes(totals.bytes)
