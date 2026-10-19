// The infra chart helpers: the framework-free ones live in `./chart-units` (shared with the
// Foldkit app); this adds the zone-aware bucket label, which reads the timezone preference.

import { formatTimeInTimezone } from "@maple/web-data/lib/timezone-format"
import { transformRows as transformRowsWith, type TransformedPoint } from "./chart-units"

export * from "./chart-units"

/** Axis label for a bucket timestamp ("14:35"), in `timeZone` or the browser's. */
export function isoToLabel(iso: string, timeZone?: string): string {
	return formatTimeInTimezone(iso, { timeZone: timeZone ?? "" })
}

/** Pivot long-form `{bucket, attributeValue, value}` rows into per-bucket points keyed by series. */
export function transformRows(
	rows: ReadonlyArray<{ bucket: string; attributeValue: string; value: number }>,
	labeler: (iso: string) => string = isoToLabel,
): { data: TransformedPoint[]; series: string[] } {
	return transformRowsWith(rows, labeler)
}
