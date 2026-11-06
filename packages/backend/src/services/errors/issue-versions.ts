import { Array as Arr } from "effect"

/**
 * Cap on the per-issue build set, so a long-lived issue cannot grow unbounded.
 *
 * Overflow evicts the LEAST RECENTLY SEEN build, not the oldest-inserted one.
 * Those differ for exactly the builds that matter here: a stale client still
 * reporting the bug keeps re-observing its own version, and evicting it because
 * it was added first is what would make it look like a regression.
 */
export const MAX_TRACKED_VERSIONS = 50

/**
 * Union the builds observed this window into an issue's tracked set.
 *
 * Re-observing a build moves it to the end, so the cap evicts by least-recently-
 * seen rather than by insertion order.
 */
export const mergeVersions = (
	existing: ReadonlyArray<string>,
	observed: ReadonlyArray<string>,
): ReadonlyArray<string> => {
	const fresh = Arr.filter(observed, (version) => version !== "")
	if (fresh.length === 0) return existing
	const next = [...Arr.filter(existing, (version) => !fresh.includes(version)), ...new Set(fresh)]
	return next.length > MAX_TRACKED_VERSIONS ? next.slice(next.length - MAX_TRACKED_VERSIONS) : next
}
