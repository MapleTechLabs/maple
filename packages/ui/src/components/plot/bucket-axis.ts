import { formatBucketLabel } from "../../lib/format"
import { toEpochMs } from "../../lib/time-format"
import { bucketTimeScale } from "./plot-scales"
import { timeseriesXAxis, type TimeseriesAxisContext } from "./timeseries"

/** A warehouse bucket as an instant: tz-less buckets are read as UTC, never as local time. */
export function bucketDate(iso: string): Date {
	return new Date(toEpochMs(iso))
}

/**
 * The x axis for a chart over warehouse buckets: a TIME scale over each
 * bucket's instant, pinned to the extent of `bucketIsos`.
 *
 * Every infra chart used to plot the bucket's formatted LABEL on a point scale,
 * and a label is not an identity: a 24-hour window starting at 17:00 has
 * "05:00 PM" at both ends, so the scale put the first and last buckets on the
 * same x. A multi-day window collapsed once per day. Plotting the instant makes
 * the position honest, and identical ranges get identical ticks on every chart;
 * the shared axis builder puts them on round clock boundaries and keeps the end
 * labels inside the plot. Daily buckets tick as "Feb 14".
 *
 * Pass the union of every sibling's buckets when charts are read down one
 * vertical line, so they agree on where a minute sits. `timeZone` is the
 * viewer's selected zone: ticks and labels follow it.
 */
export function makeBucketAxis(bucketIsos: ReadonlyArray<string>, timeZone?: string) {
	const epochs = bucketIsos
		.map((iso) => toEpochMs(iso))
		.filter((ms) => Number.isFinite(ms))
		.sort((a, b) => a - b)
	const first = epochs[0]
	const last = epochs[epochs.length - 1]
	const domainMs: readonly [number, number] | undefined =
		first !== undefined && last !== undefined ? [first, last] : undefined

	// The bucket width is the smallest positive gap, so an irregular union of two
	// cadences still reports the finer one rather than whatever came first.
	let stepMs: number | undefined
	let previous: number | undefined
	for (const epoch of epochs) {
		const gap = previous === undefined ? 0 : epoch - previous
		if (gap > 0 && (stepMs === undefined || gap < stepMs)) stepMs = gap
		previous = epoch
	}

	const context: TimeseriesAxisContext = {
		rangeMs: domainMs ? domainMs[1] - domainMs[0] : 0,
		bucketSeconds: stepMs === undefined ? undefined : stepMs / 1000,
		domainMs,
		timeZone,
	}
	const axis = timeseriesXAxis(context)

	return {
		/** Feed to `defineChart({ scales: { x } })`. */
		x:
			domainMs && domainMs[0] < domainMs[1]
				? {
						...axis,
						scale: bucketTimeScale([new Date(domainMs[0]), new Date(domainMs[1])], timeZone),
					}
				: axis,
		/**
		 * `x` padded by half a bucket each way, for marks with WIDTH (bars): they
		 * are centred on the bucket, so the unpadded extent cuts the end bars in
		 * half (see `timeseriesBandXAxis`).
		 */
		xBand:
			domainMs && stepMs !== undefined
				? {
						...axis,
						scale: bucketTimeScale(
							[new Date(domainMs[0] - stepMs / 2), new Date(domainMs[1] + stepMs / 2)],
							timeZone,
						),
					}
				: axis,
		/** `[first, last]` epoch ms, absent when there is nothing to plot. */
		domainMs,
		/** The bucket width in ms (the smallest positive gap), absent under two buckets. */
		stepMs,
		/** The context the tick labels print with, for a caller formatting its own labels. */
		context,
		/** The tooltip heading for a bucket: the full date, since the ticks stay terse. */
		heading: (bucketIso: string) => formatBucketLabel(bucketIso, context, "tooltip"),
	}
}

export type BucketAxis = ReturnType<typeof makeBucketAxis>
