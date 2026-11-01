import type { V2Source } from "@maple/domain/http/v2"
import { formatRelativeTime } from "@maple/ui/lib/time-format"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as BarChart from "../../../charts/bar-chart"
import type * as Chart from "../../../charts/chart"
import { alert, alertDescription, alertTitle } from "../../../ui/alert"
import { panel } from "../../../ui/panel"
import { emptyMessage } from "../../../ui/empty"
import { skeleton } from "../../../ui/skeleton"
import {
	integrationPlatformOf,
	hasToken,
	MODE_LABELS,
	pausedLabel,
	rateLimitLabel,
	signalsSummary,
	sourceHref,
	viaLabel,
} from "../kit/shared"
import { platformMeta } from "../kit/platforms"
import { icon } from "../../../ui/icon"
import { sourceStatusBadge, sourceStatusLabel } from "../kit/status"
import { signalCounts, volumeSize } from "../kit/volume"
import { usageRows, usageTotals } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"

// `SourceOverview`.

type H = HtmlBuilder<Message>
type Children = ReadonlyArray<Html | string>

const statCard = (h: H, label: string, value: Html | string, hint: string): Html =>
	panel(h, { padded: true, className: "gap-1.5" }, [
		h.span([h.Class("text-muted-foreground text-xs")], [label]),
		h.span([h.Class("truncate text-base font-medium")], [value]),
		h.span([h.Class("text-muted-foreground text-xs")], [hint]),
	])

const configRow = (h: H, label: string, children: Children): Html =>
	h.div(
		[h.Class("flex gap-4 border-t px-4 py-3 text-sm first:border-t-0")],
		[
			h.span([h.Class("text-muted-foreground w-44 shrink-0")], [label]),
			h.div([h.Class("min-w-0 flex-1")], children),
		],
	)

const notices = (h: H, source: V2Source, nowMs: number): ReadonlyArray<Html> => [
	...(source.status === "paused"
		? [
				alert(h, { variant: "warn" }, [
					alertTitle(h, [pausedLabel(source)]),
					alertDescription(
						h,
						[
							integrationPlatformOf(source) === null
								? "Senders still get 200 OK, so nothing retries. Data sent now is dropped and not billed."
								: "Maple keeps collecting so nothing backs up, but what it collects now is dropped and not billed.",
						],
						"text-xs",
					),
				]),
			]
		: []),
	...(source.status === "expired" && source.expires_at !== null
		? [
				alert(h, {}, [
					alertTitle(h, [`Expired ${formatRelativeTime(source.expires_at, nowMs)}`]),
					alertDescription(
						h,
						["Senders are rejected with 401. Set a new expiry in Settings to accept it again."],
						"text-xs",
					),
				]),
			]
		: []),
	...(source.health.problem !== null && source.status !== "paused" && source.status !== "expired"
		? [
				alert(h, { variant: source.health.status === "stale" ? "warn" : "crit" }, [
					alertTitle(h, [sourceStatusLabel(source.health.status)]),
					alertDescription(h, [source.health.problem], "text-xs"),
				]),
			]
		: []),
]

const USAGE_CHART_ID = "source-usage-chart"

const usageChart = (
	h: H,
	model: Model,
	rows: ReturnType<typeof usageRows>,
	timeZone: string,
	nowMs: number,
) => {
	const theme = model.chartRuntime._tag === "Ready" ? model.themeColors : null
	return h.div(
		[h.Class("h-48 w-full")],
		theme === null
			? []
			: [
					h.submodel({
						slotId: USAGE_CHART_ID,
						model: model.chart,
						view: BarChart.view,
						viewInputs: {
							chartId: USAGE_CHART_ID,
							data: rows,
							theme,
							timeZone,
							nowMs,
							stacked: true,
							legend: "visible",
							className: "h-full w-full",
						},
						toParentMessage: (message: Chart.Message) => Message.GotChartMessage({ message }),
					}),
				],
	)
}

const volumePanel = (h: H, model: Model, timeZone: string, nowMs: number): Html => {
	const usage = AsyncData.getData(model.usage.data)
	const isFailed = AsyncData.isFailure(model.usage.data)
	const body = Option.match(usage, {
		onNone: () =>
			isFailed ? emptyMessage(h, {}, ["Volume is unavailable right now."]) : skeleton(h, "h-48 w-full"),
		onSome: (value) =>
			value.buckets.length === 0
				? emptyMessage(h, {}, ["Nothing stored from this source in the last 24 hours."])
				: usageChart(h, model, usageRows(value), timeZone, nowMs),
	})
	return panel(h, { padded: true, className: "gap-3" }, [
		h.span([h.Class("text-sm font-medium")], ["Volume, last 24 hours"]),
		body,
	])
}

/** Stored size as the value, the per-signal counts as the hint. */
const last24h = (h: H, model: Model): Html => {
	const usage = AsyncData.getData(model.usage.data)
	const totals = Option.map(usage, usageTotals)
	return statCard(
		h,
		"Last 24h",
		AsyncData.isFailure(model.usage.data)
			? h.span([h.Class("text-muted-foreground")], ["Unavailable"])
			: Option.match(totals, { onNone: () => skeleton(h, "h-5 w-32"), onSome: volumeSize }),
		Option.match(totals, { onNone: () => "Stored from this source", onSome: signalCounts }),
	)
}

const rulesSummary = (h: H, source: V2Source, nowMs: number): Html =>
	panel(h, {}, [
		configRow(h, "Signals", [signalsSummary(source.allowed_signals)]),
		configRow(h, "Rate limit", [rateLimitLabel(source.rate_limit_rps)]),
		configRow(h, "Expires", [
			source.expires_at === null ? "Never" : formatRelativeTime(source.expires_at, nowMs),
		]),
		configRow(h, "Resource attributes", [
			source.resource_attributes.length === 0
				? h.span([h.Class("text-muted-foreground")], ["None"])
				: h.div(
						[h.Class("space-y-1 font-mono text-xs")],
						source.resource_attributes.map((attribute) =>
							h.keyed("div")(
								attribute.key,
								[h.Class("flex flex-wrap gap-x-3")],
								[
									h.span([h.Class("break-all")], [attribute.key, " = ", attribute.value]),
									h.span(
										[h.Class("text-muted-foreground")],
										[MODE_LABELS[attribute.mode].toLowerCase()],
									),
								],
							),
						),
					),
		]),
	])

const SIGNAL_NAMES = [
	["spans", "Traces"],
	["logs", "Logs"],
	["metrics", "Metrics"],
] as const

/** The signals stored in the last 24 hours, read from the usage; `null` while it loads. */
const storedSignals = (model: Model): string | null =>
	Option.match(AsyncData.getData(model.usage.data), {
		onNone: () => (AsyncData.isFailure(model.usage.data) ? "Unavailable right now" : null),
		onSome: (usage) => {
			const totals = usageTotals(usage)
			const names = SIGNAL_NAMES.filter(([key]) => totals[key] > 0).map(([, label]) => label)
			return names.length === 0 ? "None in the last 24 hours" : names.join(", ")
		},
	})

const resourcesLabel = (source: V2Source): string | null => {
	const resources = source.health.resources
	if (resources === null) return null
	return resources.unhealthy === 0
		? String(resources.total)
		: `${resources.total} · ${resources.unhealthy} unhealthy`
}

/** What an integration source collects, where its rules table would be: Maple holds the settings. */
const collectionSummary = (h: H, model: Model, source: V2Source, nowMs: number): Html => {
	const signals = storedSignals(model)
	const resources = resourcesLabel(source)
	return panel(h, {}, [
		h.div(
			[h.Class("flex items-center justify-between gap-4 border-b px-4 py-3")],
			[
				h.span([h.Class("text-sm font-medium")], ["What Maple collects"]),
				h.a(
					[
						h.Href(sourceHref(source, "connection")),
						h.Class(
							"text-muted-foreground hover:text-foreground active:text-foreground inline-flex items-center gap-1 text-xs",
						),
					],
					["Manage connection", icon(h, "ArrowRightIcon", { size: 12 })],
				),
			],
		),
		configRow(h, "Connected", [`${viaLabel(source)} · ${formatRelativeTime(source.created_at, nowMs)}`]),
		configRow(h, "Collects", [platformMeta(source.platform).description]),
		...(resources === null ? [] : [configRow(h, "Resources", [resources])]),
		configRow(h, "Signals", [signals ?? skeleton(h, "h-4 w-32")]),
	])
}

export const overviewTab = (h: H, model: Model, source: V2Source, timeZone: string, nowMs: number): Html => {
	return h.div(
		[h.Class("flex flex-col gap-4")],
		[
			...notices(h, source, nowMs),
			h.div(
				[h.Class("grid gap-3 sm:grid-cols-3")],
				[
					statCard(
						h,
						"Status",
						sourceStatusBadge(h, source, { nowMs, showTime: false }),
						source.health.last_data_at === null
							? "Updates once the first data lands"
							: "Updated at most once a minute",
					),
					statCard(
						h,
						integrationPlatformOf(source) === null ? "Last data" : "Last sync",
						source.health.last_data_at === null
							? "Never"
							: formatRelativeTime(source.health.last_data_at, nowMs),
						hasToken(source) || source.is_default
							? "Last request the gateway accepted"
							: "Last successful collection",
					),
					last24h(h, model),
				],
			),
			volumePanel(h, model, timeZone, nowMs),
			...(hasToken(source) ? [rulesSummary(h, source, nowMs)] : []),
			...(integrationPlatformOf(source) === null ? [] : [collectionSummary(h, model, source, nowMs)]),
		],
	)
}
