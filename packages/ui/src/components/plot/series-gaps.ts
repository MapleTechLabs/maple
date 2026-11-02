import { lineY } from "@tanstack/charts"
import { decorative } from "@tanstack/charts/mark/decorative"

/**
 * There is no `connectNulls`.
 *
 * `lineY` validates each y with `isFiniteNumber` and starts a NEW keyed segment
 * on failure (`dist/line.js:103-152`), so a null always produces a visible gap
 * and one path per run. Recharts' `connectNulls` has no equivalent option at any
 * level; the only way to bridge a hole is to remove it from the data before the
 * mark sees it.
 *
 * Time-series lines bridge a short silence and break on a long one (see
 * `seriesRuns`); `silenceBridges` draws each long silence as a faint dashed line,
 * so a quiet series still reads as one line without inventing readings.
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

/** The longest silence a line draws straight through, unless one empty bucket is longer. */
export const MAX_BRIDGED_GAP_MS = 5 * 60_000

export interface SeriesRuns<T> {
	/** Readings close enough to share a line; each run draws as its own line. */
	readonly runs: ReadonlyArray<ReadonlyArray<T>>
	/** Readings alone in their run: a line needs two, so these draw as dots. */
	readonly lone: ReadonlyArray<T>
	/** The silences between runs, from one run's last reading to the next run's first. */
	readonly silences: ReadonlyArray<SeriesSilence<T>>
}

export interface SeriesSilence<T> {
	readonly from: T
	readonly to: T
}

/** The bucket width: the smallest step between consecutive rows. */
const smallestStep = (times: ReadonlyArray<number>): number =>
	times.reduce<{ min: number; previous: number | null }>(
		(acc, time) => ({
			min:
				acc.previous !== null && time > acc.previous
					? Math.min(acc.min, time - acc.previous)
					: acc.min,
			previous: time,
		}),
		{ min: Number.POSITIVE_INFINITY, previous: null },
	).min

/**
 * Splits a series' readings into runs. Neighbouring readings share a run when the
 * silence between them is at most `MAX_BRIDGED_GAP_MS`, or one empty bucket when the
 * buckets are coarser, so a short hole is bridged and a long one stays a visible gap.
 */
export function seriesRuns<T>(
	rows: readonly T[],
	value: (row: T) => SeriesValue,
	at: (row: T) => Date,
): SeriesRuns<T> {
	const step = smallestStep(rows.map((row) => at(row).getTime()))
	const limit = Number.isFinite(step) ? Math.max(MAX_BRIDGED_GAP_MS, 2 * step) : MAX_BRIDGED_GAP_MS
	const runs = dropNullPoints(rows, value).reduce<Array<Array<T>>>((acc, row) => {
		const current = acc.at(-1)
		const last = current?.at(-1)
		if (current === undefined || last === undefined || at(row).getTime() - at(last).getTime() > limit) {
			acc.push([row])
		} else {
			current.push(row)
		}
		return acc
	}, [])
	const silences = runs.flatMap((run, index) => {
		const from = run.at(-1)
		const to = runs[index + 1]?.[0]
		return from === undefined || to === undefined ? [] : [{ from, to }]
	})
	return { runs, lone: runs.flatMap((run) => (run.length === 1 ? run : [])), silences }
}

/**
 * The silences of a series as faint dashed straight lines in the series colour. Decorative,
 * so the cursor and tooltip only ever land on real readings.
 */
export function silenceBridges<T>(
	id: string,
	silences: ReadonlyArray<SeriesSilence<T>>,
	at: (row: T) => Date,
	value: (row: T) => SeriesValue,
	color: string,
) {
	const ends = silences.flatMap((silence, index) => [
		{ key: String(index), row: silence.from },
		{ key: String(index), row: silence.to },
	])
	return decorative(
		lineY(ends, {
			id,
			x: (end) => at(end.row),
			y: (end) => value(end.row),
			// One segment per silence; the colour channel stays empty so no colour scale forms.
			z: (end) => end.key,
			color: () => null,
			stroke: color,
			strokeWidth: 1.25,
			strokeOpacity: 0.55,
			strokeDasharray: "2 4",
		}),
	)
}
