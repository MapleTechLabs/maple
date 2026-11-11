import { errorRateLevel } from "@maple/ui/lib/error-rate"
import {
	EMPTY_VALUE,
	formatErrorRate,
	formatLatency,
	formatNumber,
	formatPercent,
} from "@maple/ui/lib/format"
import { Array as Arr, Order } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Chart from "@maple/views/charts/chart"
import * as InfraMetricChart from "@maple/views/charts/infra-metric-chart"
import type { ThemeColors } from "@maple/views/charts/theme-colors"
import { errorState } from "@maple/views/ui/error-state"
import { panel } from "@maple/views/ui/panel"
import { skeleton } from "@maple/views/ui/skeleton"
import { type TypographyTone, typography } from "@maple/views/ui/typography"
import { requestClassRows } from "../list-model"
import {
	cacheHitRows,
	functionLatencyRows,
	functionLatencySummary,
	peakServerErrorRate,
	serverErrorRateRows,
} from "../overview-model"
import { correlationStrips, type StripSeries } from "../../../infra/kit/correlation-strips"
import { dataOf, failureOf } from "../view-parts"
import { MountLinkedCursor } from "./command"
import type { Overview } from "./derive"
import { Message, type Model } from "./model"

// `VercelOverviewStrips`: requests, 5xx rate, cache hits and function p95 on one time axis, with the
// team's production deploys marked on every strip.

type H = HtmlBuilder<Message>

export type ChartContext = Readonly<{ theme: ThemeColors; timeZone: string }>

const STATUS_COLORS = {
	"2xx": "--severity-info",
	"3xx": "--chart-2",
	"4xx": "--severity-warn",
	"5xx": "--severity-error",
	unknown: "--muted-foreground",
}

const LATENCY_COLORS = { p95: "--chart-p95", p50: "--chart-p50" }

const RATE_TONE = { crit: "error", warn: "warning", neutral: "muted" } as const satisfies Record<
	ReturnType<typeof errorRateLevel>,
	TypographyTone
>

const summary = (h: H, value: string, caption: string, tone: TypographyTone = "foreground") => [
	typography(h, { size: "sm", tone, weight: "semibold", mono: true, numeric: true }, [value]),
	typography(h, { size: "3xs", tone: "muted", mono: true }, [caption]),
]

const requestStrips = (h: H, o: Overview): ReadonlyArray<StripSeries> => {
	const sum = (pick: (b: Overview["buckets"][number]) => number) =>
		Arr.reduce(o.buckets, 0, (n, b) => n + pick(b))
	const requests = sum((b) => b.requests)
	const requests5xx = sum((b) => b.requests5xx)
	const lookups = sum((b) => b.cacheLookups)
	const rate = requests === 0 ? null : requests5xx / requests
	const peak = peakServerErrorRate(o.buckets)
	return [
		{
			id: "vercel-requests",
			label: "Requests",
			source: "log drain · by status",
			rows: requestClassRows(o.buckets),
			unit: "count",
			stacked: true,
			colors: STATUS_COLORS,
			summary: summary(h, formatNumber(requests), "every forwarded project"),
		},
		{
			id: "vercel-5xx",
			label: "5xx rate",
			source: "log drain · status ≥ 500",
			rows: serverErrorRateRows(o.buckets),
			unit: "percent",
			colors: { "5xx": "--severity-error" },
			summary: summary(
				h,
				rate === null ? EMPTY_VALUE : formatErrorRate(rate),
				peak === null ? "no requests" : `peak ${formatErrorRate(peak)}`,
				rate === null ? "foreground" : RATE_TONE[errorRateLevel(rate)],
			),
		},
		{
			id: "vercel-cache",
			label: "Cache hit",
			source: "x-vercel-cache",
			rows: cacheHitRows(o.buckets),
			unit: "percent",
			summary: summary(
				h,
				lookups === 0 ? EMPTY_VALUE : formatPercent(sum((b) => b.cacheHits) / lookups),
				lookups === 0 ? "no cache lookups" : "of cache lookups",
			),
		},
	]
}

const latencyStrip = (h: H, latency: NonNullable<Overview["latency"]>): StripSeries => {
	const stats = functionLatencySummary(latency)
	return {
		id: "vercel-fn-p95",
		label: "Function p95",
		source: "trace drain · Invoke Function",
		rows: functionLatencyRows(latency),
		unit: "milliseconds",
		colors: LATENCY_COLORS,
		summary:
			stats === null
				? summary(h, EMPTY_VALUE, "no invocations")
				: summary(
						h,
						formatLatency(stats.p95),
						`typical bucket · peak ${formatLatency(stats.peakP95)}${stats.p50 === null ? "" : ` · p50 ${formatLatency(stats.p50)}`}`,
					),
	}
}

const loading = (h: H): Html =>
	panel(h, { padded: true, attributes: [h.AriaBusy(true)] }, [skeleton(h, "h-72 w-full")])

/** The strips the drains feed: request strips with logs on, function p95 with traces on. */
export const overviewStrips = (
	h: H,
	model: Model,
	o: Overview,
	ctx: ChartContext | null,
): ReadonlyArray<Html> => {
	const logs = o.status.logsEnabled
	const traces = o.status.tracesEnabled
	const bucketsFailure = logs ? failureOf(model.buckets.data) : null
	const latencyFailure = traces ? failureOf(model.latency.data) : null
	const latency = o.latency
	const failures = [
		...(bucketsFailure === null
			? []
			: [
					errorState(h, {
						failure: bucketsFailure,
						title: "Couldn't load the request series",
						onRetry: Message.ClickedRetryBuckets(),
						variant: "row",
					}),
				]),
		...(latencyFailure === null
			? []
			: [
					errorState(h, {
						failure: latencyFailure,
						title: "Couldn't load function latency",
						onRetry: Message.ClickedRetryLatency(),
						variant: "row",
					}),
				]),
	]
	const bucketsReady = !logs || bucketsFailure !== null || dataOf(model.buckets.data) !== null
	const latencyReady = !traces || latencyFailure !== null || latency !== null
	if (ctx === null || !bucketsReady || !latencyReady) return [...failures, loading(h)]
	const strips = [
		...(logs && bucketsFailure === null ? requestStrips(h, o) : []),
		...(latency === null ? [] : [latencyStrip(h, latency)]),
	]
	if (strips.length === 0) return failures
	return [
		...failures,
		correlationStrips(h, {
			strips,
			xDomain: Arr.sort(
				[
					...new Set([
						...Arr.map(o.buckets, (b) => b.bucket),
						...Arr.map(latency ?? [], (b) => b.bucket),
					]),
				],
				Order.String,
			),
			markers: o.markers,
			deploys: { markers: o.commits, plotOf: (chartId) => (model.charts[chartId] ?? Chart.init()).plot },
			theme: ctx.theme,
			timeZone: ctx.timeZone,
			mountCursor: h.OnMount(MountLinkedCursor()),
			chart: (chartId, inputs) =>
				h.submodel({
					slotId: chartId,
					model: model.charts[chartId] ?? Chart.init(),
					view: InfraMetricChart.view,
					toParentMessage: (message: Chart.Message) =>
						Message.GotChartMessage({ chartId, message }),
					viewInputs: { ...inputs, chartId },
				}),
		}),
	]
}
