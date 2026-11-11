import type { VercelInfraFunctionBucket } from "@maple/domain/http"
import { EMPTY_VALUE, formatLatency, formatNumber, formatPercent } from "@maple/ui/lib/format"
import { Array as Arr } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Chart from "@maple/views/charts/chart"
import * as InfraMetricChart from "@maple/views/charts/infra-metric-chart"
import { errorState } from "@maple/views/ui/error-state"
import { removableChip } from "@maple/views/ui/removable-chip"
import { skeleton } from "@maple/views/ui/skeleton"
import { hstack } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"
import { correlationStrips, type StripSeries } from "../../../infra/kit/correlation-strips"
import { seriesInput } from "../data"
import { fillBuckets } from "../list-model"
import { functionRows, projectDeployCommits, zeroFunctionBucket } from "../project-signals"
import { dataOf, failureOf } from "../view-parts"
import { MountLinkedCursor } from "./command"
import { Message, type Model } from "./model"

// The functions tab's charts: invocations, cold starts, duration and init time per bucket, for every
// route or the one picked in the table below (`search.route`).

type H = HtmlBuilder<Message>

const summary = (h: H, value: string, caption: string): ReadonlyArray<Html> => [
	typography(h, { size: "sm", tone: "foreground", weight: "semibold", mono: true, numeric: true }, [value]),
	typography(h, { size: "3xs", tone: "muted", mono: true }, [caption]),
]

const sum = (
	buckets: ReadonlyArray<VercelInfraFunctionBucket>,
	pick: (b: VercelInfraFunctionBucket) => number,
) => Arr.reduce(buckets, 0, (total, bucket) => total + pick(bucket))

/** The largest bucket value: a window-wide quantile would need the raw spans, the peak needs none. */
const peak = (
	buckets: ReadonlyArray<VercelInfraFunctionBucket>,
	pick: (b: VercelInfraFunctionBucket) => number,
) => Arr.reduce(buckets, 0, (max, bucket) => Math.max(max, pick(bucket)))

const strips = (h: H, buckets: ReadonlyArray<VercelInfraFunctionBucket>): ReadonlyArray<StripSeries> => {
	const rows = functionRows(buckets)
	const invocations = sum(buckets, (b) => b.invocations)
	const coldStarts = sum(buckets, (b) => b.coldStarts)
	return [
		{
			id: "vercel-fn-invocations",
			label: "Invocations",
			source: "Invoke Function",
			rows: rows.invocations,
			unit: "count",
			summary: summary(h, formatNumber(invocations), "in this window"),
		},
		{
			id: "vercel-fn-cold",
			label: "Cold starts",
			source: "share of invocations",
			rows: rows.coldStarts,
			unit: "percent",
			summary: summary(
				h,
				invocations === 0 ? EMPTY_VALUE : formatPercent(coldStarts / invocations),
				`${formatNumber(coldStarts)} cold starts`,
			),
		},
		{
			id: "vercel-fn-duration",
			label: "Duration",
			source: "Invoke Function · p50, p95",
			rows: rows.duration,
			unit: "milliseconds",
			summary: summary(
				h,
				invocations === 0 ? EMPTY_VALUE : formatLatency(peak(buckets, (b) => b.p95DurationMs)),
				"peak p95 bucket",
			),
		},
		{
			id: "vercel-fn-init",
			label: "Init time",
			source: "cold starts · p50, p95",
			rows: rows.init,
			unit: "milliseconds",
			summary: summary(
				h,
				coldStarts === 0 ? EMPTY_VALUE : formatLatency(peak(buckets, (b) => b.initP95Ms)),
				coldStarts === 0 ? "no cold starts" : "peak p95 bucket",
			),
		},
	]
}

/** Which invocations the charts show: every one, or those of the picked route and host, each removable. */
const scopeLine = (h: H, route: string | undefined, host: string | undefined): Html =>
	hstack(h, { gap: "2" }, [
		typography(h, { size: "xs", tone: "muted" }, ["Charts show"]),
		...(route === undefined && host === undefined
			? [typography(h, { size: "xs", tone: "foreground", weight: "medium" }, ["every invocation"])]
			: []),
		...(route === undefined
			? []
			: [
					removableChip(h, {
						label: `route = ${route === "" ? "(no route)" : route}`,
						onRemove: Message.ClickedFunctionRoute({ route: null }),
					}),
				]),
		...(host === undefined
			? []
			: [
					removableChip(h, {
						label: `calls ${host}`,
						onRemove: Message.ClickedDependencyHost({ host: null }),
					}),
				]),
	])

export const functionSignals = (h: H, model: Model, timeZone: string): ReadonlyArray<Html> => {
	const failure = failureOf(model.functionSeries.data)
	const scope = scopeLine(h, model.search.route, model.search.host)
	if (failure !== null)
		return [
			scope,
			errorState(h, {
				failure,
				title: "Couldn't load the functions over time",
				onRetry: Message.ClickedRetryFunctionSeries(),
			}),
		]
	const raw = dataOf(model.functionSeries.data)
	const theme = model.themeColors
	if (raw === null || model.window === null || theme === null || model.chartRuntime._tag === "Loading")
		return [scope, skeleton(h, "h-96 w-full")]
	const series = seriesInput(model.window)
	const buckets = fillBuckets(raw, series, zeroFunctionBucket)
	return [
		scope,
		correlationStrips(h, {
			strips: strips(h, buckets),
			xDomain: Arr.map(buckets, (bucket) => bucket.bucket),
			deploys: {
				markers: projectDeployCommits(dataOf(model.deployments.data) ?? [], model.window),
				plotOf: (chartId) => (model.charts[chartId] ?? Chart.init()).plot,
			},
			isWaiting: AsyncData.isRefreshing(model.functionSeries.data),
			theme,
			timeZone,
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
