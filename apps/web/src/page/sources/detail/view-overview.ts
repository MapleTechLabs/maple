import type { V2Source } from "@maple/domain/http/v2"
import { Option, Array as Arr, String as Str } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as BarChart from "@maple/views/charts/bar-chart"
import type * as Chart from "@maple/views/charts/chart"
import { alert, alertDescription, alertTitle } from "@maple/views/ui/alert"
import { panel } from "@maple/views/ui/panel"
import { emptyMessage } from "@maple/views/ui/empty"
import { skeleton } from "@maple/views/ui/skeleton"
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
import { icon } from "@maple/views/ui/icon"
import { sourceStatusBadge, sourceStatusLabel } from "../kit/status"
import { signalCounts, volumeSize } from "../kit/volume"
import { usageRows, usageTotals } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { hstack, hstackClass, vstack } from "@maple/views/ui/stack"
import { relativeTime } from "../../kit/relative-time"

// `SourceOverview`.

type H = HtmlBuilder<Message>
type Children = ReadonlyArray<Html | string>

const statCard = (h: H, label: string, value: Html | string, hint: string): Html =>
	panel(h, { padded: true, className: "gap-1.5" }, [
		typography(h, { size: "xs", tone: "muted" }, [label]),
		typography(h, { size: "base", weight: "medium", truncate: true }, [value]),
		typography(h, { size: "xs", tone: "muted" }, [hint]),
	])

const configRow = (h: H, label: string, children: Children): Html =>
	hstack(h, { gap: "4", align: "stretch", className: "border-t px-4 py-3 text-sm first:border-t-0" }, [
		h.span([h.Class("text-muted-foreground w-44 shrink-0")], [label]),
		h.div([h.Class("min-w-0 flex-1")], children),
	])

const notices = (h: H, source: V2Source, timeZone: string, nowMs: number): ReadonlyArray<Html> => [
	...(source.status === "paused"
		? [
				alert(h, { variant: "warn" }, [
					alertTitle(h, pausedLabel(h, source, timeZone)),
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
					alertTitle(h, [
						"Expired ",
						relativeTime(h, { value: source.expires_at, nowMs, timeZone }),
					]),
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
				// A healthy source with a problem still receives data; its integration reports the rest.
				alert(
					h,
					{
						variant:
							source.health.status === "stale" || source.health.status === "healthy"
								? "warn"
								: "crit",
					},
					[
						alertTitle(h, [
							source.health.status === "healthy"
								? "Receiving, with an integration problem"
								: sourceStatusLabel(source.health.status),
						]),
						alertDescription(h, [source.health.problem], "text-xs"),
					],
				),
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
			isFailed ? emptyMessage(h, {}, ["Volume is unavailable right now"]) : skeleton(h, "h-48 w-full"),
		onSome: (value) =>
			value.buckets.length === 0
				? emptyMessage(h, {}, ["Nothing stored from this source in the last 24 hours"])
				: usageChart(h, model, usageRows(value), timeZone, nowMs),
	})
	return panel(h, { padded: true, className: "gap-3" }, [
		typography(h, { size: "sm", weight: "medium" }, ["Volume, last 24 hours"]),
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
			? typography(h, { tone: "muted" }, ["Unavailable"])
			: Option.match(totals, { onNone: () => skeleton(h, "h-5 w-32"), onSome: volumeSize }),
		Option.match(totals, { onNone: () => "Stored from this source", onSome: signalCounts }),
	)
}

const rulesSummary = (h: H, source: V2Source, timeZone: string, nowMs: number): Html =>
	panel(h, {}, [
		configRow(h, "Signals", [signalsSummary(source.allowed_signals)]),
		configRow(h, "Rate limit", [rateLimitLabel(source.rate_limit_rps)]),
		configRow(h, "Expires", [
			source.expires_at === null
				? "Never"
				: relativeTime(h, { value: source.expires_at, nowMs, timeZone }),
		]),
		configRow(h, "Resource attributes", [
			source.resource_attributes.length === 0
				? typography(h, { tone: "muted" }, ["None"])
				: h.div(
						[h.Class("space-y-1 font-mono text-xs")],
						Arr.map(source.resource_attributes, (attribute) =>
							h.keyed("div")(
								attribute.key,
								[h.Class("flex flex-wrap gap-x-3")],
								[
									h.span([h.Class("break-all")], [attribute.key, " = ", attribute.value]),
									typography(h, { tone: "muted" }, [
										Str.toLowerCase(MODE_LABELS[attribute.mode]),
									]),
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
			const names = Arr.map(
				Arr.filter(SIGNAL_NAMES, ([key]) => totals[key] > 0),
				([, label]) => label,
			)
			return names.length === 0 ? "None in the last 24 hours" : Arr.join(names, ", ")
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
const collectionSummary = (h: H, model: Model, source: V2Source, timeZone: string, nowMs: number): Html => {
	const signals = storedSignals(model)
	const resources = resourcesLabel(source)
	return panel(h, {}, [
		hstack(h, { gap: "4", align: "center", justify: "between", className: "border-b px-4 py-3" }, [
			typography(h, { size: "sm", weight: "medium" }, ["What Maple collects"]),
			h.a(
				[
					h.Href(sourceHref(source, "connection")),
					h.Class(
						hstackClass({
							gap: "1",
							inline: true,
							className: typographyClass({
								size: "xs",
								tone: "muted",
								hoverTone: "foreground",
							}),
						}),
					),
				],
				["Manage connection", icon(h, "ArrowRightIcon", { size: 12 })],
			),
		]),
		configRow(h, "Connected", [
			`${viaLabel(source)} · `,
			relativeTime(h, { value: source.created_at, nowMs, timeZone }),
		]),
		configRow(h, "Collects", [platformMeta(source.platform).description]),
		...(resources === null ? [] : [configRow(h, "Resources", [resources])]),
		configRow(h, "Signals", [signals ?? skeleton(h, "h-4 w-32")]),
	])
}

export const overviewTab = (h: H, model: Model, source: V2Source, timeZone: string, nowMs: number): Html => {
	return vstack(h, { gap: "4" }, [
		...notices(h, source, timeZone, nowMs),
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
						: relativeTime(h, { value: source.health.last_data_at, nowMs, timeZone }),
					hasToken(source) || source.is_default
						? "Last request the gateway accepted"
						: "Last successful collection",
				),
				last24h(h, model),
			],
		),
		volumePanel(h, model, timeZone, nowMs),
		...(hasToken(source) ? [rulesSummary(h, source, timeZone, nowMs)] : []),
		...(integrationPlatformOf(source) === null
			? []
			: [collectionSummary(h, model, source, timeZone, nowMs)]),
	])
}
