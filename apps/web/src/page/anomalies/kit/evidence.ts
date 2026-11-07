import type { AnomalyIncidentDocument } from "@maple/domain/http"
import type { V2AnomalyIncidentTimeseries } from "@maple/domain/http/v2"
import { cn } from "@maple/ui/lib/utils"
import {
	deviation,
	formatSignalValue,
	isStaleOpenIncident,
	severityToneFor,
} from "@maple/web-data/anomalies/format"
import { Option, Array as Arr } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { bucketTooltipBody } from "@maple/views/charts/bucket-tooltip"
import type * as Chart from "@maple/views/charts/chart"
import { type ChartRuntime, isChartRuntimeReady } from "@maple/views/charts/chart-runtime"
import { ChartSpec } from "@maple/views/charts/chart-spec"
import { plotFrame } from "@maple/views/charts/plot-frame"
import { resolveColor, type ThemeColors } from "@maple/views/charts/theme-colors"
import type { LoadFailure } from "@maple/views/data/load-failure"
import { chartError, chartLoading } from "@maple/views/ui/chart-state"
import { emptyMessage } from "@maple/views/ui/empty"
import { statusDot } from "@maple/views/ui/status-dot"
import { truncatedId } from "@maple/views/ui/truncated-id"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { hstack } from "@maple/views/ui/stack"
import { anomalyTimeseriesFromV2 } from "../../../lib/services/anomalies"
import { AppRoute, hrefOf } from "../../../route"
import { relativeTime } from "../../kit/relative-time"
import { seriesLegend } from "../../kit/series-legend"
import { shortIssueId } from "./row"
import { textLink } from "@maple/views/ui/text-link"

// The anomaly detector's evidence: the observed value against its baseline, the signal chart with
// its baseline and threshold, and the error fingerprints grouped into it. The anomaly page and the
// alert incident page of an anomaly rule both draw these.

/** The theme tokens the signal chart resolves; a page that draws it resolves these on mount. */
export const ANOMALY_CHART_TOKENS: ReadonlyArray<string> = [
	"--destructive",
	"--severity-error",
	"--severity-warn",
	"--muted-foreground",
	"--border",
	"--background",
]

const SEVERITY_STROKE = { critical: "--severity-error", warning: "--severity-warn" } as const

/** One sentence: the observed value against its 7-day baseline, the deviation and the threshold. */
export const anomalySummary = <M>(
	h: HtmlBuilder<M>,
	incident: AnomalyIncidentDocument,
	nowMs: number,
	timeZone: string,
): Html => {
	const tone = severityToneFor(incident)
	const isStale = isStaleOpenIncident(incident, nowMs)
	const dev = deviation(incident)
	const accent = cn(
		typographyClass({ weight: "medium", mono: true }),
		incident.status === "open" && !isStale ? tone.text : "text-foreground",
	)
	const fmt = (value: number) => formatSignalValue(incident.signalType, value)
	return h.p(
		[h.Class("max-w-2xl text-sm text-muted-foreground")],
		[
			isStale ? "Last recorded" : "Observed",
			" ",
			h.span([h.Class(accent)], [fmt(incident.lastObservedValue)]),
			" ",
			"against a ",
			typography(h, { tone: "foreground", mono: true }, [fmt(incident.baselineMedian)]),
			" 7-day baseline:",
			" ",
			h.span([h.Class(accent)], [dev.label]),
			dev.kind === "sigma" ? " above median" : dev.kind === "percent" ? " vs baseline" : "",
			", threshold ",
			typography(h, { tone: "foreground", mono: true }, [fmt(incident.thresholdValue)]),
			".",
			...(isStale
				? [
						" Last triggered ",
						relativeTime(h, { value: incident.lastTriggeredAt, nowMs, timeZone }),
						"; this stale detector state does not represent current service health.",
					]
				: []),
		],
	)
}

type ChartViewInputs = Readonly<{ spec: ChartSpec; chartId: string }>

const chartView = Submodel.defineView<Chart.Model, Chart.Message, ChartViewInputs>((model, inputs, h) =>
	plotFrame(h, {
		chartId: inputs.chartId,
		spec: inputs.spec,
		ariaLabel: "Observed signal",
		className: "h-64 w-full",
		tooltipBody: (portal) =>
			Option.flatMap(model.tooltip, (tooltip) =>
				tooltip._tag === "Bucket"
					? Option.some(bucketTooltipBody(h, tooltip, portal))
					: Option.none(),
			),
	}),
)

export type AnomalySignalChartInputs<M> = Readonly<{
	/** Unique per page: the chart's submodel slot and plot id derive from it. */
	chartId: string
	chart: Chart.Model
	toChartMessage: (message: Chart.Message) => M
	timeseries: AsyncData.AsyncData<V2AnomalyIncidentTimeseries, LoadFailure>
	incident: AnomalyIncidentDocument
	colors: ThemeColors | null
	chartRuntime: ChartRuntime
	timeZone: string
}>

/** The observed signal with its baseline and threshold; loading until the series, theme and runtime are in. */
export const anomalySignalChart = <M>(h: HtmlBuilder<M>, inputs: AnomalySignalChartInputs<M>): Html => {
	const { incident, colors } = inputs
	const isReady = colors !== null && isChartRuntimeReady(inputs.chartRuntime)
	const loaded = (wire: V2AnomalyIncidentTimeseries): Html => {
		if (!isReady || colors === null) return chartLoading(h, { variant: "line", height: 256 })
		const series = anomalyTimeseriesFromV2(wire)
		if (series.buckets.length === 0)
			return emptyMessage(
				h,
				{
					dashed: true,
					className:
						"flex h-64 w-full items-center justify-center border-border-subtle py-0 text-xs",
				},
				["No signal data in this window"],
			)
		const stroke = resolveColor(colors, SEVERITY_STROKE[incident.severity])
		// Both threshold rules draw in `--destructive`.
		const rule = resolveColor(colors, "--destructive")
		const fmt = (value: number) => formatSignalValue(series.signalType, value)
		return h.div(
			[h.Class("space-y-2")],
			[
				h.submodel({
					slotId: `${inputs.chartId}-chart`,
					model: inputs.chart,
					view: chartView,
					viewInputs: {
						chartId: inputs.chartId,
						spec: ChartSpec.AnomalySignal({
							points: Arr.map(series.buckets, (bucket) => ({
								bucket: bucket.bucket,
								value: bucket.value,
							})),
							signalType: series.signalType,
							baselineMedian: series.baselineMedian,
							thresholdValue: series.thresholdValue,
							firstTriggeredAt: incident.firstTriggeredAt,
							resolvedAt: incident.resolvedAt,
							colors: {
								stroke,
								muted: rule,
								threshold: rule,
								border: resolveColor(colors, "--border"),
								background: resolveColor(colors, "--background"),
							},
							gradientId: `${inputs.chartId}-observed`,
							timeZone: inputs.timeZone,
						}),
					},
					toParentMessage: inputs.toChartMessage,
				}),
				seriesLegend(h, {
					className: "justify-start gap-x-4",
					swatch: "dashed",
					items: [
						{ key: "observed", label: "Observed", color: stroke, swatch: "line" },
						{
							key: "baseline",
							label: "Baseline median",
							value: fmt(series.baselineMedian),
							color: "var(--muted-foreground)",
						},
						{
							key: "threshold",
							label: "Threshold",
							value: fmt(series.thresholdValue),
							color: "var(--severity-error)",
						},
					],
				}),
			],
		)
	}
	return AsyncData.match(inputs.timeseries, {
		onIdle: () => chartLoading(h, { variant: "line", height: 256 }),
		onLoading: () => chartLoading(h, { variant: "line", height: 256 }),
		onFailure: () => chartError(h, { height: 256 }, ["Couldn't load signal data."]),
		onStale: () => chartError(h, { height: 256 }, ["Couldn't load signal data."]),
		onSuccess: loaded,
		onRefreshing: loaded,
	})
}

/** One grouped error fingerprint: its issue (or hash) and its last value, or "resolved". */
export const anomalyFingerprintRow = <M>(
	h: HtmlBuilder<M>,
	incident: AnomalyIncidentDocument,
	fingerprint: AnomalyIncidentDocument["fingerprints"][number],
): Html =>
	h.div(
		[
			h.Key(fingerprint.fingerprintHash),
			h.Class("grid min-h-7 grid-cols-[1fr_auto] items-center gap-x-2 py-0.5"),
			h.Title(fingerprint.fingerprintHash),
		],
		[
			hstack(h, { gap: "1.5", shrink: true, as: "span" }, [
				statusDot(h, {
					tone:
						fingerprint.resolvedAt !== null
							? "neutral"
							: fingerprint.severity === "critical"
								? "crit"
								: "warn",
				}),
				fingerprint.errorIssueId !== null
					? textLink(
							h,
							{
								href: hrefOf(
									AppRoute.ErrorIssue({
										issueId: fingerprint.errorIssueId,
										search: {},
									}),
								),
								tone: "muted",
								isMono: true,
								className: "block truncate text-xs hover:no-underline active:no-underline",
							},
							[shortIssueId(fingerprint.errorIssueId)],
						)
					: truncatedId(h, {
							value: fingerprint.fingerprintHash,
							length: 10,
							className: typographyClass({ size: "xs", tone: "muted", truncate: true }),
						}),
			]),
			typography(h, { size: "xs", tone: "muted", mono: true, numeric: true }, [
				fingerprint.resolvedAt !== null
					? "resolved"
					: formatSignalValue(incident.signalType, fingerprint.lastValue),
			]),
		],
	)
