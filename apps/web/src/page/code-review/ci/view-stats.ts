import type { CodeReviewCiAnalytics, CodeReviewCiTotals } from "@maple/domain/http"
import { rateChange, successRate } from "../../../components/code-review/ci/ci-format"
import { bucketIso, formatCount, formatSpan } from "../../../components/code-review/code-review-format"
import { EMPTY_VALUE, formatDuration, formatPercent } from "@maple/ui/lib/format"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as AreaChart from "../../../charts/area-chart"
import * as BarChart from "../../../charts/bar-chart"
import type * as Chart from "../../../charts/chart"
import type { ThemeColors } from "../../../charts/theme-colors"
import { delta, relativeChange } from "../../../ui/delta"
import { statRail, statRailItem } from "../../kit/stat-rail"
import { changeOf } from "../analytics/view-stats"
import { analyticsPanel, chartFrame } from "../kit/analytics-panel"
import { Message, type Model } from "./model"

// `HeadlineStrip`, `RunsCard` and `DurationCard`.

type H = HtmlBuilder<Message>

/** Series names the shared palette colours as run results. */
export const RESULT_SERIES = { succeeded: "Succeeded", failed: "Failed", cancelled: "Cancelled" } as const

const durationOf = (ms: number | null) => (ms === null ? EMPTY_VALUE : formatDuration(ms))
const rateOf = (rate: number | null) => (rate === null ? EMPTY_VALUE : formatPercent(rate))
const points = (magnitude: number) => `${(magnitude * 100).toFixed(1)}pp`

/** The headline tiles' labels, in order; the loading skeleton shows them too. */
export const CI_HEADLINE_LABELS = {
	runs: "Runs",
	successRate: "Success rate",
	p50: "p50 run time",
	p95: "p95 run time",
	runnerWait: "Runner wait",
	ciTime: "CI time",
} as const

export const headlineStrip = (
	h: H,
	current: CodeReviewCiTotals,
	previous: CodeReviewCiTotals,
	windowLabel: string,
) => {
	const versus = `vs previous ${windowLabel}`
	const rate = successRate(current)
	const rateDelta = rateChange(rate, successRate(previous))
	const runsRatio = relativeChange(current.runs, previous.runs)
	const stats: ReadonlyArray<{ label: string; value: string; delta: Html | undefined; hint?: string }> = [
		{
			label: CI_HEADLINE_LABELS.runs,
			value: formatCount(current.runs),
			delta: runsRatio === null ? undefined : delta(h, { ratio: runsRatio, muteWorse: true }),
		},
		{
			label: CI_HEADLINE_LABELS.successRate,
			value: rateOf(rate),
			delta: rateDelta === null ? undefined : delta(h, { ratio: rateDelta, format: points }),
			hint: "Passed runs over passed and failed ones; cancelled runs are left out",
		},
		{
			label: CI_HEADLINE_LABELS.p50,
			value: durationOf(current.p50DurationMs),
			delta: changeOf(h, current.p50DurationMs, previous.p50DurationMs, true),
		},
		{
			label: CI_HEADLINE_LABELS.p95,
			value: durationOf(current.p95DurationMs),
			delta: changeOf(h, current.p95DurationMs, previous.p95DurationMs, true),
		},
		{
			label: CI_HEADLINE_LABELS.runnerWait,
			value: durationOf(current.p50QueueMs),
			delta: changeOf(h, current.p50QueueMs, previous.p50QueueMs, true),
			hint: "Median time a job waited for a runner to pick it up",
		},
		{
			label: CI_HEADLINE_LABELS.ciTime,
			value: formatSpan(current.totalDurationMs / 1000),
			delta: changeOf(h, current.totalDurationMs, previous.totalDurationMs, true),
			hint: "Wall-clock time of every run added up",
		},
	]
	return statRail(
		h,
		{ columns: 3, className: "xl:grid-cols-6" },
		stats.map((stat) =>
			h.div(
				[h.Key(stat.label), ...(stat.hint === undefined ? [] : [h.Title(stat.hint)])],
				[
					statRailItem(h, {
						compact: true,
						eyebrow: stat.label,
						value: stat.value,
						delta: stat.delta,
						// No previous runs: an older period the tables no longer hold, or a new workflow.
						subline: previous.runs === 0 ? undefined : versus,
					}),
				],
			),
		),
	)
}

type ChartContext = Readonly<{ theme: ThemeColors; nowMs: number; timeZone: string }>

export const chartsRow = (
	h: H,
	model: Model,
	analytics: CodeReviewCiAnalytics,
	context: ChartContext,
): Html => {
	const isEmpty = analytics.current.runs === 0
	const runRows = analytics.series.map((point) => ({
		bucket: bucketIso(point.bucket),
		[RESULT_SERIES.succeeded]: point.succeeded,
		[RESULT_SERIES.failed]: point.failed,
		[RESULT_SERIES.cancelled]: point.cancelled,
	}))
	const durationRows = analytics.series.map((point) => ({
		bucket: bucketIso(point.bucket),
		p50: point.p50DurationMs ?? "",
		p95: point.p95DurationMs ?? "",
	}))
	return h.div(
		[h.Class("grid gap-6 lg:grid-cols-2")],
		[
			analyticsPanel(h, { title: "Runs by result" }, [
				chartFrame(h, isEmpty, () =>
					h.submodel({
						slotId: "code-review-ci-runs-chart",
						model: model.runsChart,
						view: BarChart.view,
						toParentMessage: (message: Chart.Message) =>
							Message.GotChartMessage({ chart: "runs", message }),
						viewInputs: {
							chartId: "code-review-ci-runs",
							data: runRows,
							stacked: true,
							className: "h-full w-full",
							...context,
						},
					}),
				),
			]),
			analyticsPanel(h, { title: "Run time" }, [
				chartFrame(h, isEmpty, () =>
					h.submodel({
						slotId: "code-review-ci-duration-chart",
						model: model.durationChart,
						view: AreaChart.view,
						toParentMessage: (message: Chart.Message) =>
							Message.GotChartMessage({ chart: "duration", message }),
						viewInputs: {
							chartId: "code-review-ci-duration",
							mark: "line",
							data: durationRows,
							unit: "duration_ms",
							className: "h-full w-full",
							...context,
						},
					}),
				),
			]),
		],
	)
}
