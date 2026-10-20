import { Array as Arr } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { FixedMetricRow } from "../../charts/chart-spec"
import { MountLinkedCursor } from "../../charts/linked-cursor"
import { ResolveThemeColors } from "../../charts/theme-colors"
import { CHART_TOKENS, metricsGridOf } from "../../page/services/detail/view-charts"
import { isReady, Message, type Model } from "./chart-bench"

// `/lab/bench/service-detail` and
// `/lab/bench/overview`): the service-detail chart grid over synthetic rows.

const BUCKET_COUNT = 145
const BUCKET_MS = 5 * 60 * 1000
const END_TIME_MS = Date.UTC(2026, 6, 17, 18, 30)

/** `SERVICE_DETAIL_POINTS`, the same formulas. */
export const SERVICE_DETAIL_POINTS: ReadonlyArray<FixedMetricRow> = Arr.makeBy(BUCKET_COUNT, (index) => {
	const phase = (index / (BUCKET_COUNT - 1)) * Math.PI * 6
	const traffic = 1_250 + Math.sin(phase) * 410 + Math.cos(phase * 0.37) * 190
	const errorRate = 0.18 + Math.max(0, Math.sin(phase * 0.73)) * 0.42
	const p50LatencyMs = 320 + Math.sin(phase * 0.63) * 85
	return {
		bucket: new Date(END_TIME_MS - (BUCKET_COUNT - 1 - index) * BUCKET_MS).toISOString(),
		p50LatencyMs,
		p95LatencyMs: p50LatencyMs * 1.8,
		p99LatencyMs: p50LatencyMs * 2.75,
		throughput: traffic * (BUCKET_MS / 1000),
		tracedThroughput: traffic * 0.14 * (BUCKET_MS / 1000),
		hasSampling: true,
		errorRate,
		apdexScore: Math.max(0.72, 0.97 - errorRate * 0.12 - Math.sin(phase * 0.41) * 0.025),
	}
})

/** The bench page: `MetricsGrid` with `yAxisWidth={72}` under a padded full-height frame. */
export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	h.div(
		[
			h.DataAttribute("testid", "service-detail-chart-bench"),
			h.Class("min-h-screen bg-background p-6 text-foreground"),
			h.OnMount(ResolveThemeColors({ tokens: CHART_TOKENS })),
		],
		[
			metricsGridOf(
				h,
				{
					charts: model.charts,
					rows: SERVICE_DETAIL_POINTS,
					markers: [],
					toChartMessage: (chartId, message) => Message.GotChartMessage({ chartId, message }),
					linkedCursorMount: MountLinkedCursor(),
				},
				{
					isLoading: !isReady(model),
					isWaiting: false,
					context:
						model.themeColors === null
							? null
							: { theme: model.themeColors, timeZone: model.timeZone, nowMs: model.nowMs },
				},
			),
		],
	)
