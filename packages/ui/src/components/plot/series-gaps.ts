/**
 * There is no `connectNulls`.
 *
 * `lineY` validates each y with `isFiniteNumber` and starts a NEW keyed segment
 * on failure (`dist/line.js:103-152`), so a null always produces a visible gap
 * and one path per run. Recharts' `connectNulls` has no equivalent option at any
 * level; the only way to bridge a hole is to remove it from the data before the
 * mark sees it.
 *
 * Time-series lines bridge missing buckets: a series that only reported some
 * buckets reads as one line through its readings, not as scattered fragments.
 * A chart that must show silence as a gap (a workload that stopped reporting)
 * opts in with explicit null rows and skips this.
 */
/** What a series accessor can yield — a reading, or the absence of one. */
export type SeriesValue = number | null | undefined

export function dropNullPoints<T>(rows: readonly T[], value: (row: T) => SeriesValue): readonly T[] {
	let hasNull = false
	for (const row of rows) {
		const candidate = value(row)
		if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
			hasNull = true
			break
		}
	}
	// Identity-stable when there is nothing to drop: the result feeds a mark, and
	// a fresh array every render would rebuild the scene on every commit.
	if (!hasNull) return rows

	return rows.filter((row) => {
		const candidate = value(row)
		return typeof candidate === "number" && Number.isFinite(candidate)
	})
}

/**
 * The reading of a series that has exactly one. A bridged line needs two
 * readings to draw a segment, so a lone one gets a dot instead.
 */
export function loneReading<T>(rows: readonly T[], value: (row: T) => SeriesValue): readonly T[] {
	const readings = dropNullPoints(rows, value)
	return readings.length === 1 ? readings : []
}
