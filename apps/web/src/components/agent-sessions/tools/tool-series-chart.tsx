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
import { useMediaQuery } from "@maple/ui/hooks/use-media-query"

import { CHART_EMPTY_MESSAGE, bucketDate, makeBucketAxis } from "@/components/infra/chart-utils"
import { CHART_HEIGHT, ChartCard, ChartCardMessage } from "@/components/infra/primitives/chart-card"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import {
	OTHER_SERIES_KEY,
	foldSeries,
	formatToolMetric,
	metricValue,
	toolChartTitle,
	toolSeriesColors,
	type ToolMetric,
	type ToolPercentile,
	type ToolSeriesPoint,
} from "@/lib/agent-sessions/tool-analytics"

const STROKE_WIDTH = 1.5

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
			const row = byBucket.get(point.bucket) ?? { bucket: iso, date: bucketDate(iso) }
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
		() => makeBucketAxis(rows.map((row) => row.bucket), effectiveTimezone),
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
							format: (value: number) =>
								value === 0 ? "0" : formatToolMetric(value, metric),
						},
					},
				},
			},
			margin: { left: narrow ? 40 : 56, right: 8, top: 4 },
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

	// Only where there is more than one line to tell apart — a single series is
	// already named by the title, and a legend restating it is one accessory too
	// many. The number beside each name is its call volume, which is what the
	// series are ranked by and is not otherwise visible on a rate or a latency.
	const legend =
		keys.length > 1 ? (
			<>
				{keys.map((key) => (
					<span key={key} className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
						<span
							aria-hidden
							className="size-1.5 rounded-full"
							style={{ backgroundColor: colors.get(key) ?? chromeColors.border }}
						/>
						<span className="max-w-40 truncate">{seriesLabel(key)}</span>
						<span className="font-mono tabular-nums text-muted-foreground/70">
							{formatToolMetric(totals.get(key) ?? 0, "calls")}
						</span>
					</span>
				))}
			</>
		) : undefined

	return (
		<ChartCard title={title} legend={legend} className={waiting ? "opacity-60" : undefined}>
			{rows.length === 0 ? (
				<ChartCardMessage>{CHART_EMPTY_MESSAGE}</ChartCardMessage>
			) : (
				<div className="w-full" style={{ height: CHART_HEIGHT }}>
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
		</ChartCard>
	)
}
