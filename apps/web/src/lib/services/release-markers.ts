export interface ReleaseMarker {
	bucket: string
	commitSha: string
	label: string
}

/**
 * Turn a per-bucket commit-SHA timeline into deploy markers — one per distinct
 * commit SHA, placed at the earliest bucket it appears in.
 *
 * Every version seen in the range gets a marker (including the one already active
 * at the window's start), so a release is never silently dropped. A window with a
 * single SHA has nothing to mark.
 *
 * Earlier versions keyed markers off a single "dominant" (highest-span) SHA and
 * hid it as the assumed baseline. That wrongly disappeared a real release whenever
 * it happened to carry the most traffic in the window — e.g. a mid-sequence deploy
 * that accumulated more spans than the releases on either side of it. Marking the
 * first appearance of every SHA avoids that: the count is no longer load-bearing.
 */
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
