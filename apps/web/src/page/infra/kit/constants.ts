import { toEpochMs } from "@maple/ui/lib/time-format"
import { Array as Arr, Option } from "effect"

/**
 * Bucket widths a kubelet-sampled series can honestly be drawn at. The floor is
 * the scrape interval — anything finer would draw gaps, not resolution.
 */
const BUCKET_CEILING = 14400
const BUCKET_LADDER: ReadonlyArray<number> = [
	15,
	30,
	60,
	120,
	300,
	600,
	900,
	1800,
	3600,
	7200,
	BUCKET_CEILING,
]

/**
 * Chart bucket for an arbitrary window: about a hundred points, snapped up to
 * the ladder, so a custom range in the URL needs no preset to look up.
 */
export function bucketSecondsForRange(startTime: string, endTime: string): number {
	const windowSeconds = Math.max((toEpochMs(endTime) - toEpochMs(startTime)) / 1000, 60)
	const target = windowSeconds / 100
	return Option.getOrElse(
		Arr.findFirst(BUCKET_LADDER, (width) => width >= target),
		() => BUCKET_CEILING,
	)
}
