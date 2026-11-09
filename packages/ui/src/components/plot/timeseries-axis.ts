import { formatBucketLabel } from "../../lib/format"
import { zonedTimeScale } from "./plot-scales"

// The bucketed x axis, framework-free (moved out of timeseries.tsx so non-React charts share it).

/** What `formatBucketLabel` needs to choose a label's precision. */
export interface TimeseriesAxisContext {
	rangeMs: number
	bucketSeconds: number | undefined
	/**
	 * `[first, last]` epoch ms of the buckets actually DRAWN, when the caller
	 * knows them. Lets `timeseriesXAxis` clamp a tick label sitting on a domain
	 * edge instead of letting it overhang — see the `anchor` there.
	 */
	domainMs?: readonly [number, number]
	/**
	 * The IANA zone the labels print in and the ticks are chosen in; `undefined`
	 * is the browser's. `useTimeseriesModel` reads it off `PlotTimeZoneProvider`.
	 */
	timeZone?: string
}

/**
 * The x axis every bucketed chart shares.
 *
 * A d3 TIME scale over the precomputed `row.date`. A point scale over
 * bucket strings — which is what the categorical Recharts axis was —
 * puts ticks on arbitrary buckets ("08:25 PM") instead of clock
 * boundaries. The scale ticks in the same zone the labels below print
 * in (`zonedTimeScale`): only ticks chosen on that clock land on
 * boundaries that read as round.
 *
 * A FACTORY, so the domain is inferred. That is safe even though
 * the solid and dashed marks each cover a slice: a continuous domain is
 * min/max over the union, and the slices overlap at the bridge row.
 */
export function timeseriesXAxis(context: TimeseriesAxisContext) {
	const axisContext = dailyBucketContext(context)
	const dailyTicks = dailyTickValues(axisContext)
	return {
		scale: zonedTimeScale(axisContext.timeZone),
		axis: {
			line: false,
			ticks: {
				size: 0,
				padding: 8,
				// 72px put "01:00 AM 01:30 AM 02:00 AM" almost edge to edge on a card:
				// a bucket label runs ~55px, so the gap between two of them was single
				// digits. Widening the CANDIDATE spacing is what buys the room without
				// touching how the labels are chosen — the scale still lands them on
				// round clock boundaries, evenly spaced.
				// The chart accepts one candidate policy, so explicit daily ticks replace the spacing.
				...(dailyTicks === undefined ? { spacing: 104 } : { values: dailyTicks }),
				format: (value: Date) => formatBucketLabel(value.toISOString(), axisContext, "tick"),
			},
			// The port's missing `minTickGap={24}`. Thinning is the backstop, not the
			// spacing mechanism: it drops colliding labels — at a 4px default, almost
			// none — and a thinned time axis reads unevenly (01:00, 02:00, 03:30). A
			// gap wide enough to be legible, left to fire only where a long label or a
			// narrow tile still collides.
			tickLabels: { thin: { minGap: 12 }, anchor: edgeTickAnchor(axisContext) },
		},
	}
}

/** Day buckets (allowing a DST day of 23 hours) never tick finer than a day. */
const MIN_DAILY_BUCKET_SECONDS = 23 * 3600

const isMidnightIn = (epochMs: number, timeZone: string | undefined): boolean =>
	new Date(epochMs).toLocaleTimeString("en-GB", {
		timeZone,
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	}) === "00:00"

/**
 * Daily buckets are calendar days, labelled in the zone they start at midnight in. A UTC-midnight
 * day (Search Console's) read in Los Angeles is 4 PM the day before, so it labels in UTC instead.
 */
export function dailyBucketContext(axisContext: TimeseriesAxisContext): TimeseriesAxisContext {
	const domain = axisContext.domainMs
	const bucketSeconds = axisContext.bucketSeconds
	if (!domain || bucketSeconds === undefined || bucketSeconds < MIN_DAILY_BUCKET_SECONDS) return axisContext
	if (isMidnightIn(domain[0], axisContext.timeZone) || !isMidnightIn(domain[0], "UTC")) return axisContext
	return { ...axisContext, timeZone: "UTC" }
}
/** Under this many days the scale's 104px candidates would fall twelve hours apart on a wide card. */
const MAX_DAILY_TICK_DAYS = 16
/** Labels a short daily axis aims for; a longer run ticks every few days. */
const DAILY_TICK_TARGET = 8

/**
 * Explicit ticks for a short run of daily buckets. Left to the scale, a 7-day window on a wide
 * card ticks every 12 hours and each day prints twice ("Nov 1, Nov 1"); one tick per bucket (or
 * per few) fixes that. Longer runs and finer buckets keep the scale's own round ticks.
 */
function dailyTickValues(axisContext: TimeseriesAxisContext): ReadonlyArray<Date> | undefined {
	const domain = axisContext.domainMs
	const bucketSeconds = axisContext.bucketSeconds
	if (!domain || bucketSeconds === undefined || bucketSeconds < MIN_DAILY_BUCKET_SECONDS) return undefined
	const stepMs = bucketSeconds * 1000
	const buckets = Math.floor((domain[1] - domain[0]) / stepMs) + 1
	if (buckets > MAX_DAILY_TICK_DAYS) return undefined
	const stride = Math.max(1, Math.ceil(buckets / DAILY_TICK_TARGET))
	return Array.from(
		{ length: Math.ceil(buckets / stride) },
		(_, index) => new Date(domain[0] + index * stride * stepMs),
	)
}

/**
 * Keeps the end tick labels inside the plot instead of overhanging it.
 *
 * A tick label is centred on its tick, so one near a domain edge hangs half its
 * width past the plot. The layout solver measures that overhang and reserves it
 * as margin (`includeLabelMargin` in the library's `scene.js`), which pulls the
 * plot's edge inward by half a label — measured at 49px on a 672px card for
 * "Aug 19, 12:00 AM", against 4px when no tick lands near the edge. The series
 * then stops well short of where its own axis labels run, which is what reads as
 * a chart that has been cut off.
 *
 * Whether it bites is pure tick PHASE, which is why it looks intermittent: a
 * 6-day window ending at midnight puts a 2-day tick on the last bucket, while a
 * 7-day one lands the ticks a day inside and nothing overhangs.
 *
 * The threshold is HALF A LABEL, not one bucket: the tick that triggered this in
 * production sat two hours inside a six-day domain — a rounding error in bucket
 * terms, and still 45px of overhang. Half a label is converted to a fraction of
 * the domain against a NOMINAL plot width rather than a measured one, because
 * the measurement is the solver's output and reading it here would make the
 * layout depend on its own result. Over-estimating is the safe direction (it
 * anchors a label that would have just fitted) and the error is bounded: label
 * candidates are `spacing: 104` apart and a label is ~90px, so at most one tick
 * per edge can ever fall inside the threshold.
 */
const NOMINAL_PLOT_WIDTH = 600
/** Half the advance width of one character of the 11px mono tick label. */
const HALF_CHAR_PX = 2.8
/** A label can never be wide enough to claim this much of the domain. */
const MAX_EDGE_FRACTION = 0.2

function edgeTickAnchor(axisContext: TimeseriesAxisContext) {
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
