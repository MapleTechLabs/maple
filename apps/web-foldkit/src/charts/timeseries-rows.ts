// The row and axis-context types of packages/ui's plot/timeseries.tsx, React- and chart-library-free
// so views can read them; the axes that use them live in `timeseries.ts`.

/** One normalised row: the bucket, its parsed date, and every series value by key. */
export interface TimeseriesRow extends Record<string, unknown> {
	bucket: string
	date: Date
	partial?: boolean
}

export interface TimeseriesAxisContext {
	readonly rangeMs: number
	readonly bucketSeconds: number | undefined
	readonly domainMs?: readonly [number, number]
	readonly timeZone?: string
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
