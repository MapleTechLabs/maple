import type {
	VercelAiGatewayResponse,
	VercelSpeedInsightsResponse,
	VercelWebAnalyticsResponse,
	VercelWebVital,
} from "@maple/domain/http"
import { formatCost } from "@maple/agent-sessions"
import {
	EMPTY_VALUE,
	formatErrorRate,
	formatLatency,
	formatNumber,
	formatPercent,
} from "@maple/ui/lib/format"
import { Array as Arr, Order } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { VITAL_THRESHOLDS, type VitalRating, vitalRating, vitalsByKey, WEB_VITALS } from "../list-model"
import type { LoadFailure } from "@maple/views/data/load-failure"
import { columnClass } from "@maple/views/ui/column"
import { emptyMessage } from "@maple/views/ui/empty"
import { errorState } from "@maple/views/ui/error-state"
import { meter } from "@maple/views/ui/meter"
import { panel, panelBody, panelHeader } from "@maple/views/ui/panel"
import { skeleton } from "@maple/views/ui/skeleton"
import { hstack, vstack } from "@maple/views/ui/stack"
import { type TypographyTone, typography } from "@maple/views/ui/typography"
import { statRail, statRailItem } from "../../../kit/stat-rail"
import { thresholdScale } from "../../../kit/threshold-scale"
import { drainNotice } from "../sections"
import { dataOf, failureOf } from "../view-parts"
import { Message, type Model } from "./model"
import type { Overview } from "./derive"

// `VercelAiGatewayPanel` and `VercelRealUsersPanel`: the overview's two side-by-side panels.

type H = HtmlBuilder<Message>

const MODEL_ROWS = 5

const title = (h: H, text: string, source: string): Html =>
	hstack(h, { gap: "2", align: "baseline" }, [
		typography(h, { size: "xs", tone: "foreground", weight: "medium" }, [text]),
		typography(h, { size: "3xs", tone: "muted", mono: true }, [source]),
	])

const drainOff = (h: H, lead: string, text: string): Html =>
	drainNotice(h, { lead, text, actionLabel: "Turn on in settings" })

/** One read's slot in a panel: its failure, a skeleton, or the body over its data. */
const readBody = <A>(
	h: H,
	data: AsyncData.AsyncData<A, LoadFailure>,
	options: Readonly<{ failure: string; onRetry: Message; body: (value: A) => ReadonlyArray<Html> }>,
): ReadonlyArray<Html> => {
	const failure = failureOf(data)
	if (failure !== null)
		return [errorState(h, { failure, title: options.failure, onRetry: options.onRetry, variant: "row" })]
	const value = dataOf(data)
	return value === null ? [skeleton(h, "h-20 w-full")] : options.body(value)
}

// AI Gateway

const aiGatewayBody = (h: H, data: VercelAiGatewayResponse): ReadonlyArray<Html> => {
	const { summary } = data
	if (summary.requests === 0)
		return [emptyMessage(h, { className: "py-8" }, ["No AI Gateway requests in this window"])]
	const models = Arr.take(
		Arr.sort(
			data.models,
			Order.mapInput(
				Order.flip(Order.Number),
				(m: VercelAiGatewayResponse["models"][number]) => m.costUsd,
			),
		),
		MODEL_ROWS,
	)
	const maxCost = models[0]?.costUsd ?? 0
	return [
		statRail(h, { columns: 4, isFlush: true }, [
			statRailItem(h, { size: "sm", eyebrow: "Spend", value: formatCost(summary.costUsd) }),
			statRailItem(h, {
				size: "sm",
				eyebrow: "Requests",
				value: formatNumber(summary.requests),
				subline: `${formatErrorRate(summary.errors / summary.requests)} errors`,
				tone: summary.errors > 0 ? "warn" : undefined,
			}),
			statRailItem(h, {
				size: "sm",
				eyebrow: "Tokens",
				value: formatNumber(summary.inputTokens + summary.outputTokens),
				subline: `${formatNumber(summary.inputTokens)} in · ${formatNumber(summary.outputTokens)} out`,
			}),
			statRailItem(h, {
				size: "sm",
				eyebrow: "p95",
				value: summary.p95DurationMs === null ? EMPTY_VALUE : formatLatency(summary.p95DurationMs),
				subline:
					summary.p50DurationMs === null
						? undefined
						: `p50 ${formatLatency(summary.p50DurationMs)}`,
			}),
		]),
		panelBody(h, [
			vstack(
				h,
				{ gap: "3", className: "px-4 py-3" },
				Arr.map(models, (model) =>
					hstack(h, { gap: "3" }, [
						vstack(h, { gap: "0.5", className: columnClass({ min: "0" }) }, [
							typography(h, { size: "xs", tone: "foreground", mono: true, truncate: true }, [
								model.model,
							]),
							typography(h, { size: "3xs", tone: "muted", mono: true, truncate: true }, [
								`${model.provider} · ${formatNumber(model.requests)} requests`,
							]),
						]),
						meter(h, { value: model.costUsd, max: maxCost, className: "w-24 shrink-0" }),
						typography(
							h,
							{
								size: "xs",
								tone: "soft",
								mono: true,
								numeric: true,
								className: "w-16 shrink-0 text-right",
							},
							[formatCost(model.costUsd)],
						),
					]),
				),
			),
		]),
	]
}

export const aiGatewayPanel = (h: H, model: Model, o: Overview): Html =>
	panel(h, {}, [
		panelHeader(h, { title: title(h, "AI Gateway", "ai-gateway drain") }),
		...(o.status.aiGatewayEnabled
			? readBody(h, model.aiGateway.data, {
					failure: "Couldn't load AI Gateway usage",
					onRetry: Message.ClickedRetryAiGateway(),
					body: (data) => aiGatewayBody(h, data),
				})
			: [
					panelBody(h, [
						drainOff(
							h,
							"AI Gateway is off.",
							"Turn on its drain to see model spend, tokens and errors.",
						),
					]),
				]),
	])

// Real users

const RATING_TONE = { good: "success", needsImprovement: "warning", poor: "error" } as const satisfies Record<
	VitalRating,
	TypographyTone
>
const RATING_LABEL = {
	good: "good",
	needsImprovement: "needs work",
	poor: "poor",
} as const satisfies Record<VitalRating, string>

const vitalText = (metric: VercelWebVital, p75: number) =>
	metric === "CLS" ? p75.toFixed(2) : formatLatency(p75)

const analyticsStats = (h: H, data: VercelWebAnalyticsResponse): Html => {
	const top = data.pages[0]
	return statRail(h, { columns: 3, isFlush: true }, [
		statRailItem(h, { size: "sm", eyebrow: "Page views", value: formatNumber(data.summary.pageViews) }),
		statRailItem(h, {
			size: "sm",
			eyebrow: "Visitors",
			value: formatNumber(data.summary.uniqueDevices),
			subline: "device ids rotate daily",
		}),
		statRailItem(h, {
			size: "sm",
			eyebrow: "Top page",
			value: top === undefined ? EMPTY_VALUE : top.value === "" ? "(none)" : top.value,
			subline:
				top === undefined || data.summary.pageViews === 0
					? undefined
					: `${formatPercent(top.count / data.summary.pageViews)} of views`,
		}),
	])
}

const vitalRows = (h: H, data: VercelSpeedInsightsResponse): ReadonlyArray<Html> => {
	const overall = vitalsByKey(data.metrics)[0]
	if (overall === undefined)
		return [emptyMessage(h, { className: "py-6" }, ["No Speed Insights readings in this window"])]
	return [
		panelBody(h, [
			vstack(
				h,
				{ gap: "2.5", className: "px-4 py-3" },
				Arr.flatMap(WEB_VITALS, (metric) => {
					const p75 = overall.p75[metric]
					if (p75 === undefined) return []
					const rating = vitalRating(metric, p75)
					const [good, poor] = VITAL_THRESHOLDS[metric]
					return [
						hstack(h, { gap: "3" }, [
							typography(
								h,
								{ size: "xs", tone: "soft", mono: true, className: "w-10 shrink-0" },
								[metric],
							),
							typography(
								h,
								{
									size: "xs",
									tone: "foreground",
									mono: true,
									numeric: true,
									className: "w-16 shrink-0",
								},
								[vitalText(metric, p75)],
							),
							thresholdScale(h, {
								value: p75,
								good,
								poor,
								label: `${metric} p75 ${vitalText(metric, p75)}, ${RATING_LABEL[rating]}`,
								className: "min-w-0 flex-1",
							}),
							typography(
								h,
								{
									size: "3xs",
									tone: RATING_TONE[rating],
									mono: true,
									className: "w-16 shrink-0 text-right",
								},
								[RATING_LABEL[rating]],
							),
						]),
					]
				}),
			),
		]),
	]
}

export const realUsersPanel = (h: H, model: Model, o: Overview): Html =>
	panel(h, {}, [
		panelHeader(h, { title: title(h, "Real users", "web analytics + speed insights") }),
		...(o.status.webAnalyticsEnabled
			? readBody(h, model.webAnalytics.data, {
					failure: "Couldn't load Web Analytics",
					onRetry: Message.ClickedRetryWebAnalytics(),
					body: (data) => [analyticsStats(h, data)],
				})
			: [
					panelBody(h, [
						drainOff(
							h,
							"Web Analytics is off.",
							"Turn on its drain to see page views, visitors and top pages.",
						),
					]),
				]),
		...(o.status.speedInsightsEnabled
			? readBody(h, model.speedInsights.data, {
					failure: "Couldn't load Speed Insights",
					onRetry: Message.ClickedRetrySpeedInsights(),
					body: (data) => vitalRows(h, data),
				})
			: [
					panelBody(h, [
						drainOff(
							h,
							"Speed Insights is off.",
							"Turn on its drain to see Core Web Vitals from real visits.",
						),
					]),
				]),
	])
