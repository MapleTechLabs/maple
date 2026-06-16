// Shared helpers for the infra detail charts (host + k8s). The two chart files
// keep their own <ChartView> (different units, container chrome, heights) but
// share the row→series transform, palette, and grid/empty conventions.

export const COLOR_PALETTE = [
	"var(--chart-1)",
	"var(--chart-2)",
	"var(--chart-3)",
	"var(--chart-4)",
	"var(--chart-5)",
	"var(--chart-p50)",
]

/** Recharts grid dash — one value across every infra chart. */
export const CHART_GRID_DASH = "3 3"

/** Shown when a series query returns no points for the selected window. */
export const CHART_EMPTY_MESSAGE = "No data for this metric in the selected window."

export interface TransformedPoint extends Record<string, string | number> {
	bucket: string
	time: string
}

export function isoToLabel(iso: string): string {
	const d = new Date(iso)
	return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })
}

/** Pivot long-form `{bucket, attributeValue, value}` rows into per-bucket points keyed by series. */
export function transformRows(
	rows: ReadonlyArray<{ bucket: string; attributeValue: string; value: number }>,
): { data: TransformedPoint[]; series: string[] } {
	const seriesSet = new Set<string>()
	const byBucket = new Map<string, TransformedPoint>()
	for (const row of rows) {
		const series = row.attributeValue || "value"
		seriesSet.add(series)
		const existing: TransformedPoint = byBucket.get(row.bucket) ?? {
			bucket: row.bucket,
			time: isoToLabel(row.bucket),
		}
		existing[series] = row.value
		byBucket.set(row.bucket, existing)
	}
	const data = Array.from(byBucket.values()).toSorted((a, b) =>
		String(a.bucket).localeCompare(String(b.bucket)),
	)
	return { data, series: [...seriesSet] }
}
