import { useMemo } from "react"
import { d3Curve, defineChart, lineY } from "@tanstack/charts"
import { scaleLinear } from "@tanstack/charts-scales/linear"
import { curveMonotoneX } from "d3-shape"

import type { AiToolsSeriesKind } from "@maple/domain/http"
import { formatWarehouseDateTime } from "@maple/query-engine"
import {
	PlotFrame,
	PlotTooltipBody,
	createTooltipFocusStore,
	cursorTooltip,
	dashedGridY,
	focusCrosshair,
	focusDot,
	usePlotChromeColors,
	useResolvedSeriesColors,
	type PlotTooltipSeries,
} from "@maple/ui/components/plot"
import { ChartEmpty } from "@maple/ui/components/charts"
import { useMediaQuery } from "@maple/ui/hooks/use-media-query"
import { cn } from "@maple/ui/lib/utils"

import { CHART_EMPTY_MESSAGE, bucketDate, makeBucketAxis } from "@/components/infra/chart-utils"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import {
	OTHER_SERIES_KEY,
	foldSeries,
	formatToolMetric,
	metricValue,
	toolChartTitle,
	toolMetricLabel,
	toolSeriesColors,
	toolSeriesMode,
	type ToolMetric,
	type ToolPercentile,
	type ToolSeriesPoint,
} from "@/lib/agent-sessions/tool-analytics"

const STROKE_WIDTH = 1.5
const PLOT_HEIGHT = 220

/** One bucket, carrying whichever series reported there. `null` is a genuine gap. */
interface ToolChartRow extends Record<string, string | number | Date | null> {
	bucket: string
	date: Date
}

interface ToolSeriesChartProps {
	series: ReadonlyArray<ToolSeriesPoint>
	metric: ToolMetric
	percentile: ToolPercentile
	tool: string | undefined
	model: string | undefined
	/** What the series are keyed by, as the read reported it. */
	seriesKind: AiToolsSeriesKind
	/**
	 * A model id as a reader should see it. Models arrive under the raw id an
	 * instrumentation reported (`openai/gpt-5.6`) and are named here the way the
	 * Models panel names them; the id itself stays the series identity, and its
	 * colour.
	 */
	modelLabel: (model: string) => string
	waiting?: boolean
}

/**
 * The selected metric over the window, split by whatever the scope has not
 * pinned down yet — one line per tool, then one per model, then one.
 *
 * Lines rather than stacked bands, for every metric including the counts. The
 * series here are alternatives being compared ("is `bash` slower than `read`?"),
 * not parts of a whole, and a stack answers a question nobody asked while making
 * the comparison impossible to read.
 *
 * A bucket a series has no row for stays a **gap**, not a zero. These are
 * per-tool series over a window someone chose: a tool that was not called in an
 * hour has no error rate and no p90 there, and joining across it would draw a
 * dive to zero that never happened.
 */
export function ToolSeriesChart({
	series,
	metric,
	percentile,
	tool,
	model,
	seriesKind,
	modelLabel,
	waiting,
}: ToolSeriesChartProps) {
	const seriesLabel = useMemo(
		() => (seriesKind === "model" ? modelLabel : (key: string) => key),
		[seriesKind, modelLabel],
	)
	const chromeColors = usePlotChromeColors()
	const focusStore = useMemo(() => createTooltipFocusStore(), [])
	const { effectiveTimezone } = useTimezonePreference()
	const narrow = useMediaQuery("max-sm")

	const { rows, keys, totals } = useMemo(() => {
		const folded = foldSeries(series)
		const byBucket = new Map<number, ToolChartRow>()
		const totals = new Map<string, number>()

		for (const point of folded.points) {
			const iso = formatWarehouseDateTime(point.bucket)
			const row = byBucket.get(point.bucket) ?? {
				bucket: iso,
				date: bucketDate(iso),
			}
			row[point.seriesKey] = metricValue(point, metric, percentile)
			byBucket.set(point.bucket, row)
			totals.set(point.seriesKey, (totals.get(point.seriesKey) ?? 0) + point.calls)
		}

		return {
			rows: [...byBucket.entries()].sort((a, b) => a[0] - b[0]).map(([, row]) => row),
			keys: folded.keys,
			totals,
		}
	}, [series, metric, percentile])

	// Ranked order in, so a tool keeps its colour while its rank holds.
	const colorTokens = useMemo(() => toolSeriesColors(keys), [keys])
	const colors = useResolvedSeriesColors(colorTokens, chromeColors.border)

	const axis = useMemo(
		() =>
			makeBucketAxis(
				rows.map((row) => row.bucket),
				effectiveTimezone,
			),
		[rows, effectiveTimezone],
	)

	const tooltipSeries = useMemo<PlotTooltipSeries<ToolChartRow>[]>(
		() =>
			keys.map((key) => ({
				label: key === OTHER_SERIES_KEY ? `${OTHER_SERIES_KEY} (approx.)` : seriesLabel(key),
				color: colors.get(key) ?? chromeColors.border,
				value: (row: ToolChartRow) => {
					const value = row[key]
					return typeof value === "number" ? value : null
				},
				format: (value: number) => formatToolMetric(value, metric),
			})),
		[keys, colors, chromeColors.border, metric, seriesLabel],
	)

	const definition = useMemo(() => {
		const at = (row: ToolChartRow) => row.date
		const valueOf = (key: string) => (row: ToolChartRow) => {
			const value = row[key]
			return typeof value === "number" ? value : null
		}
		const colorOf = (key: string) => colors.get(key) ?? chromeColors.border
		const curve = d3Curve(curveMonotoneX)

		return defineChart({
			marks: [
				dashedGridY(),
				...keys.map((key) =>
					lineY(rows, {
						id: key,
						x: at,
						y: valueOf(key),
						stroke: colorOf(key),
						strokeWidth: STROKE_WIDTH,
						curve,
					}),
				),
				...keys.map((key) => focusDot(rows, at, valueOf(key), colorOf(key), chromeColors)),
				focusCrosshair(chromeColors),
			],
			scales: {
				x: axis.x,
				y: {
					scale: scaleLinear,
					axis: {
						line: false,
						ticks: {
							size: 0,
							padding: 8,
							// The duration formatter renders zero as an em dash — right for
							// a headline ("never measured"), wrong for an axis baseline.
							format: (value: number) => (value === 0 ? "0" : formatToolMetric(value, metric)),
						},
					},
				},
			},
			margin: { left: narrow ? 40 : 48, right: 8, top: 4 },
			focus: "group-x",
			focusRing: false,
			tooltip: cursorTooltip(focusStore.anchor),
		})
	}, [rows, keys, colors, chromeColors, axis, metric, narrow, focusStore])

	const title = toolChartTitle({
		metric,
		percentile,
		tool,
		model: model === undefined ? undefined : modelLabel(model),
	})

	// The head is the title's parts, each drawn as what it is: the metric as a
	// heading, the scope in the primary (it is the same selection the chips and
	// the lit tile show), and the split as a note.
	const mode = toolSeriesMode(tool, model)
	const scopeParts = [tool, model === undefined ? undefined : modelLabel(model)].filter(
		(part): part is string => part !== undefined,
	)
	const bucketMs = rows.length > 1 ? rows[1]!.date.getTime() - rows[0]!.date.getTime() : null
	const note = [
		keys.length > 1 ? `${keys.length} ${seriesKind === "model" ? "models" : "tools"}` : null,
		bucketMs === null ? null : `${bucketLabel(bucketMs)} buckets`,
	]
		.filter((part) => part !== null)
		.join(" · ")

	return (
		<section
			className={cn(
				"flex flex-col gap-4 border-b border-border px-6 pt-[22px] pb-5",
				waiting && "opacity-60",
			)}
		>
			<div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 font-mono text-[12.5px]">
				<h2 className="font-sans text-[15px] font-semibold leading-5 tracking-[-0.01em] text-foreground">
					{toolMetricLabel(metric, percentile)}
				</h2>
				{scopeParts.map((part) => (
					<span key={part} className="contents">
						<Dot />
						<span className="text-primary">{part}</span>
					</span>
				))}
				{mode === "single" ? null : (
					<>
						<Dot />
						<span className="text-muted-foreground">
							by {mode === "tools" ? "tool" : "model"}
						</span>
					</>
				)}
				<span className="grow" />
				<span className="text-[11px] text-muted-foreground/60">{note}</span>
			</div>

			{/* Only where there is more than one line to tell apart — a single
			    series is already named by the head. The number beside each name is
			    its call volume, which is what the series are ranked by and is not
			    otherwise visible on a rate or a latency. */}
			{keys.length > 1 ? (
				<div className="-mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] leading-3.5">
					{keys.map((key) => (
						<span key={key} className="flex items-center gap-1.5">
							<span
								aria-hidden
								className="h-[2.5px] w-3 shrink-0 rounded-full"
								style={{
									backgroundColor: colors.get(key) ?? chromeColors.border,
								}}
							/>
							<span className="max-w-40 truncate text-foreground/75">{seriesLabel(key)}</span>
							<span className="tabular-nums text-muted-foreground/80">
								{formatToolMetric(totals.get(key) ?? 0, "calls")}
							</span>
						</span>
					))}
				</div>
			) : null}

			{rows.length === 0 ? (
				<ChartEmpty height={PLOT_HEIGHT}>{CHART_EMPTY_MESSAGE}</ChartEmpty>
			) : (
				<div className="w-full" style={{ height: PLOT_HEIGHT }}>
					<PlotFrame
						definition={definition}
						ariaLabel={title}
						className="h-full w-full"
						renderTooltipBody={({ points }) => (
							<PlotTooltipBody
								points={points}
								series={tooltipSeries}
								focusStore={focusStore}
								heading={(row: ToolChartRow) => axis.heading(row.bucket)}
							/>
						)}
					/>
				</div>
			)}
		</section>
	)
}

/** "1h" / "5m" — the bucket width, as a chart note rather than a measurement. */
function bucketLabel(ms: number): string {
	return ms >= 3_600_000 ? `${Math.round(ms / 3_600_000)}h` : `${Math.round(ms / 60_000)}m`
}

function Dot() {
	return (
		<span aria-hidden className="text-xs text-muted-foreground/60">
			·
		</span>
	)
}
