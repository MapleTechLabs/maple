import { bucketTimeScale, zonedTimeScale } from "@maple/ui/components/plot/plot-scales"
import { formatBucketLabel } from "@maple/ui/lib/format"
import { toEpochMs } from "@maple/ui/lib/time-format"

// copied: `makeBucketAxis` (packages/ui/src/components/plot/bucket-axis.ts) with `timeseriesXAxis`
// and `edgeTickAnchor` (plot/timeseries.tsx, a React module), so the chart host stays React-free.

export interface TimeseriesAxisContext {
	rangeMs: number
	bucketSeconds: number | undefined
	domainMs?: readonly [number, number]
	timeZone?: string
}

const NOMINAL_PLOT_WIDTH = 600
const HALF_CHAR_PX = 2.8
const MAX_EDGE_FRACTION = 0.2

/** Keeps the end tick labels inside the plot instead of overhanging it. */
const edgeTickAnchor = (axisContext: TimeseriesAxisContext) => {
	const domain = axisContext.domainMs
	if (!domain) return undefined
	const spanMs = domain[1] - domain[0]
	if (spanMs <= 0) return undefined
	return ({ value }: { value: Date }): "start" | "middle" | "end" => {
		const at = value.getTime()
		if (!Number.isFinite(at)) return "middle"
		const label = formatBucketLabel(value.toISOString(), axisContext, "tick")
		const fraction = Math.min(MAX_EDGE_FRACTION, (label.length * HALF_CHAR_PX) / NOMINAL_PLOT_WIDTH)
		const slackMs = spanMs * fraction
		if (at >= domain[1] - slackMs) return "end"
		if (at <= domain[0] + slackMs) return "start"
		return "middle"
	}
}

export const timeseriesXAxis = (axisContext: TimeseriesAxisContext) => ({
	scale: zonedTimeScale(axisContext.timeZone),
	axis: {
		line: false,
		ticks: {
			size: 0,
			padding: 8,
			spacing: 104,
			format: (value: Date) => formatBucketLabel(value.toISOString(), axisContext, "tick"),
		},
		tickLabels: { thin: { minGap: 12 }, anchor: edgeTickAnchor(axisContext) },
	},
})

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
