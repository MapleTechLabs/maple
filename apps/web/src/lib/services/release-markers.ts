export interface ReleaseMarker {
	bucket: string
	commitSha: string
	label: string
}

export function detectReleaseMarkers(
	timeline: Array<{ bucket: string; commitSha: string; count: number }>,
): ReleaseMarker[] {
	if (timeline.length === 0) return []

	// A single-version window has no deploy to mark (nothing changed).
	const distinct = new Set(timeline.map((point) => point.commitSha))
	if (distinct.size <= 1) return []

	const sorted = timeline.toSorted((a, b) => a.bucket.localeCompare(b.bucket))

	// One marker per SHA, at the earliest bucket it shows up in.
	const seen = new Set<string>()
	const markers: ReleaseMarker[] = []
	for (const point of sorted) {
		if (seen.has(point.commitSha)) continue
		seen.add(point.commitSha)
		markers.push({
			bucket: point.bucket,
			commitSha: point.commitSha,
			label: point.commitSha.slice(0, 7),
		})
	}

	return markers
}
