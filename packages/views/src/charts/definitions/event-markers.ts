import { rect, ruleX, text } from "@tanstack/charts"
import { decorative } from "@tanstack/charts/mark/decorative"
import { toEpochMs } from "@maple/ui/lib/time-format"
import { type ChartEventMarker, EventTone, type MarkerColors } from "../event-marker-spec"
import { Array as Arr, Order } from "effect"

// Chart event marker marks and their placement in the window, colours resolved by the page.

interface PlacedMarker {
	readonly marker: ChartEventMarker
	readonly x: Date
	readonly x2?: Date
}

/**
 * Markers inside the window from the first bucket to the end of the last one, at their own instant.
 * A band keeps the part of it that overlaps the window. `extent` replaces that window with the x
 * scale's own, so nothing lands past the plot.
 */
export const placeMarkersInWindow = (
	markers: ReadonlyArray<ChartEventMarker>,
	bucketIsos: ReadonlyArray<string>,
	extent?: Readonly<{ startMs: number; endMs: number }>,
): ReadonlyArray<PlacedMarker> => {
	if (bucketIsos.length === 0 || markers.length === 0) return []
	const times = Arr.sort(
		Arr.filter(
			Arr.map(bucketIsos, (iso) => toEpochMs(iso)),
			(ms) => Number.isFinite(ms),
		),
		Order.Number,
	)
	const first = times[0]
	const last = times[times.length - 1]
	if (first === undefined || last === undefined) return []
	const width = times.length > 1 ? (times[1] ?? first) - first : 0
	const lo = extent?.startMs ?? first
	const hi = extent?.endMs ?? last + width
	const inWindow = (t: number) => Number.isFinite(t) && t >= lo && t <= hi
	return Arr.flatMap(markers, (marker): ReadonlyArray<PlacedMarker> => {
		const at = toEpochMs(marker.at)
		const until = marker.endsAt === undefined ? Number.NaN : toEpochMs(marker.endsAt)
		if (Number.isFinite(at) && Number.isFinite(until) && until > at) {
			const from = Math.max(at, lo)
			const to = Math.min(until, hi)
			// A window with no width (one bucket) keeps an overlapping band as a line.
			return to > from
				? [{ marker, x: new Date(from), x2: new Date(to) }]
				: to === from
					? [{ marker, x: new Date(from) }]
					: []
		}
		return inWindow(at) ? [{ marker, x: new Date(at) }] : []
	})
}

const MAX_LABELLED_MARKERS = 3

export const chartEventMarkerMarks = (
	placed: ReadonlyArray<PlacedMarker>,
	yDomain: readonly [number, number],
	colors: MarkerColors,
) => {
	if (placed.length === 0) return []
	const labelled = placed.length <= MAX_LABELLED_MARKERS
	const lines = Arr.filter(placed, (entry) => entry.x2 === undefined)
	const bands = Arr.filter(placed, (entry) => entry.x2 !== undefined)
	const bandMarks = Arr.flatMap(EventTone.literals, (tone) => {
		const ofTone = Arr.filter(bands, (entry) => entry.marker.tone === tone)
		return ofTone.length === 0
			? []
			: [
					decorative(
						rect(ofTone, {
							x1: (entry: PlacedMarker) => entry.x,
							x2: (entry: PlacedMarker) => entry.x2 ?? entry.x,
							y1: () => yDomain[0],
							y2: () => yDomain[1],
							fill: colors[tone],
							fillOpacity: 0.08,
							stroke: "none",
						}),
					),
				]
	})
	const lineMarks =
		lines.length === 0
			? []
			: [
					decorative(
						ruleX(lines, {
							x: (entry: PlacedMarker) => entry.x,
							stroke: (entry: PlacedMarker) => colors[entry.marker.tone],
							strokeOpacity: 1,
							strokeWidth: 1,
							strokeDasharray: "3 3",
						}),
					),
					...(labelled
						? [
								decorative(
									text(lines, {
										x: (entry: PlacedMarker) => entry.x,
										y: () => yDomain[1],
										text: (entry: PlacedMarker) => entry.marker.label,
										fill: colors.label,
										anchor: "middle",
										dy: -4,
										fontSize: 9,
									}),
								),
							]
						: []),
				]
	return [...bandMarks, ...lineMarks]
}
