// The bucket width the overview's grid of small multiples is cut at, and the
// name the page prints for it.
//
// Here rather than beside the infra charts' helpers: the ladder is sized for a
// ~100px-tall plot in a nine-cell grid, which is this page's layout and nothing
// else's.

import { toEpochMs } from "@maple/ui/lib/time-format"

/**
 * Bucket widths a small multiple can be read at: whole, recognisable steps from
 * five minutes to a day, every one of them a multiple of 300 so the width also
 * satisfies the API's `BucketSeconds`.
 */
const SMALL_MULTIPLE_CEILING = 86_400
const SMALL_MULTIPLE_LADDER: ReadonlyArray<number> = [
	300,
	900,
	1_800,
	3_600,
	10_800,
	21_600,
	43_200,
	SMALL_MULTIPLE_CEILING,
]

/** Points a ~100px-tall plot can separate. A hundred of them land under a pixel each. */
const SMALL_MULTIPLE_TARGET_POINTS = 30

/**
 * Bucket width for a grid of small multiples: about thirty points, snapped up
 * to the ladder above.
 *
 * Two things differ from `chartBucketSeconds`, which a full-width chart wants.
 * The count: a plot barely a hundred pixels tall cannot show a hundred buckets.
 * And the snapping: dividing a window into a hundred equal parts produces
 * widths like 105 minutes, which an axis note has to call "2h" while the
 * buckets are something else. A day reads at 1h, a week at 6h, a month at 1d.
 */
export function smallMultipleBucketSeconds(startTime: string, endTime: string): number {
	const windowSeconds = Math.max((toEpochMs(endTime) - toEpochMs(startTime)) / 1000, 300)
	const target = windowSeconds / SMALL_MULTIPLE_TARGET_POINTS
	return SMALL_MULTIPLE_LADDER.find((width) => width >= target) ?? SMALL_MULTIPLE_CEILING
}

/** The bucket width, as the Trends note states it: `15m`, `6h`, `1d`. */
export function bucketWidthLabel(seconds: number): string {
	if (seconds >= 86_400) return `${Math.round(seconds / 86_400)}d`
	if (seconds >= 3_600) return `${Math.round(seconds / 3_600)}h`
	return `${Math.round(seconds / 60)}m`
}
