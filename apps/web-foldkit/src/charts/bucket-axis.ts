import { bucketTimeScale } from "@maple/ui/components/plot/plot-scales"
import { formatBucketLabel } from "@maple/ui/lib/format"
import { toEpochMs } from "@maple/ui/lib/time-format"

// copied: `makeBucketAxis` (packages/ui/src/components/plot/bucket-axis.ts) on the shared
// `timeseriesXAxis`, so the chart host stays React-free.

import { timeseriesXAxis } from "./timeseries"
import type { TimeseriesAxisContext } from "./timeseries-rows"

export const bucketDate = (iso: string): Date => new Date(toEpochMs(iso))

/** `makeBucketAxis`: the x axis of a bucketed chart, unpadded (`x`) and half-bucket padded (`xBand`). */
export const makeBucketAxis = (bucketIsos: ReadonlyArray<string>, timeZone?: string) => {
	const epochs = bucketIsos
		.map((iso) => toEpochMs(iso))
		.filter((ms) => Number.isFinite(ms))
		.toSorted((a, b) => a - b)
	const first = epochs[0]
	const last = epochs[epochs.length - 1]
	const domainMs: readonly [number, number] | undefined =
		first !== undefined && last !== undefined ? [first, last] : undefined
	const gaps = epochs.slice(1).map((epoch, index) => epoch - (epochs[index] ?? epoch))
	const positive = gaps.filter((gap) => gap > 0)
	const stepMs = positive.length === 0 ? undefined : Math.min(...positive)
	const context: TimeseriesAxisContext = {
		rangeMs: domainMs ? domainMs[1] - domainMs[0] : 0,
		bucketSeconds: stepMs === undefined ? undefined : stepMs / 1000,
		domainMs,
		timeZone,
	}
	const axis = timeseriesXAxis(context)
	return {
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
		context,
		heading: (bucketIso: string) => formatBucketLabel(bucketIso, context, "tooltip"),
	}
}
