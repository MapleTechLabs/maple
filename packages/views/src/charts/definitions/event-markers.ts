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

/** Markers inside the window from the first bucket to the end of the last one, at their own instant. */
export const placeMarkersInWindow = (
	markers: ReadonlyArray<ChartEventMarker>,
	bucketIsos: ReadonlyArray<string>,
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
	const end = last + width
	const inWindow = (t: number) => Number.isFinite(t) && t >= first && t <= end
	return Arr.flatMap(markers, (marker): ReadonlyArray<PlacedMarker> => {
		const at = toEpochMs(marker.at)
		if (!inWindow(at)) return []
		const x = new Date(at)
		if (marker.endsAt === undefined) return [{ marker, x }]
		const until = toEpochMs(marker.endsAt)
		return [inWindow(until) && until > at ? { marker, x, x2: new Date(until) } : { marker, x }]
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
