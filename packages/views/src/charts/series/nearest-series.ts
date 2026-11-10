/**
 * Pure geometry helper for highlighting the series nearest the cursor in a
 * multi-series time-chart tooltip.
 *
 * Each rendered series records the pixel-Y of its active point (the dot Recharts
 * draws at the hovered bucket) into a `{ [seriesKey]: y }` map. Given the
 * cursor's pixel-Y, this returns the key of the closest series — but only when
 * it falls within `maxDistancePx`, so nothing is emphasised when the pointer
 * hovers in empty space far from every line.
 *
 * Working in pixel space (rather than reconstructing the y-axis scale) is
 * deliberate: the y domain is frequently `[0, "auto"]`, so there is no stable
 * scale to invert.
 */
export function findNearestSeriesKey(
	seriesYByKey: Readonly<Record<string, number>>,
	candidateKeys: readonly string[],
	pointerY: number | undefined,
	maxDistancePx: number,
): string | undefined {
	if (pointerY == null || !Number.isFinite(pointerY)) return undefined

	let nearestKey: string | undefined
	let nearestDistance = Number.POSITIVE_INFINITY

	for (const key of candidateKeys) {
		const y = seriesYByKey[key]
		if (y == null || !Number.isFinite(y)) continue
		const distance = Math.abs(y - pointerY)
		if (distance < nearestDistance) {
			nearestDistance = distance
			nearestKey = key
		}
	}

	return nearestDistance <= maxDistancePx ? nearestKey : undefined
}
