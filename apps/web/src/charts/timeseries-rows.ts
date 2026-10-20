// The row type and helpers of packages/ui's plot/timeseries.tsx, chart-library-free so views can
// read them. The axis context and x axis are @maple/ui's framework-free `plot/timeseries-axis`.

export type { TimeseriesAxisContext } from "@maple/ui/components/plot/timeseries-axis"

/** One normalised row: the bucket, its parsed date, and every series value by key. */
export interface TimeseriesRow extends Record<string, unknown> {
	bucket: string
	date: Date
	partial?: boolean
}

export const asFiniteNumber = (value: unknown): number => {
	const parsed = typeof value === "number" ? value : Number(value)
	return Number.isFinite(parsed) ? parsed : 0
}

export const rowsDomainMs = (
	rows: ReadonlyArray<{ readonly date: Date }>,
): readonly [number, number] | undefined => {
	const first = rows[0]?.date.getTime()
	const last = rows[rows.length - 1]?.date.getTime()
	if (first === undefined || last === undefined || !Number.isFinite(first) || !Number.isFinite(last))
		return undefined
	return [Math.min(first, last), Math.max(first, last)]
}
