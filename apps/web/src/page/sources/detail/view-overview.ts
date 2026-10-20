import type { V2Source } from "@maple/domain/http/v2"
import { sourceStoresTelemetry } from "@maple/domain/primitives"
import { formatRelativeTime } from "@maple/ui/lib/time-format"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as BarChart from "../../../charts/bar-chart"
import type * as Chart from "../../../charts/chart"
import { alert, alertDescription, alertTitle } from "../../../ui/alert"
import { panel } from "../../../ui/panel"
import { skeleton } from "../../../ui/skeleton"
import {
	integrationPlatformOf,
	hasToken,
	MODE_LABELS,
	pausedLabel,
	rateLimitLabel,
	signalsSummary,
} from "../kit/shared"
import { platformMeta } from "../kit/platforms"
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
			isFailed
				? h.p(
						[h.Class("text-muted-foreground py-6 text-center text-xs")],
						["Volume is unavailable right now."],
					)
				: skeleton(h, "h-48 w-full"),
		onSome: (value) =>
			value.buckets.length === 0
				? h.p(
						[h.Class("text-muted-foreground py-8 text-center text-xs")],
						["Nothing stored from this source in the last 24 hours."],
					)
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

/** PlanetScale is read live: there is nothing stored to count. */
const liveReadNote = (h: H, source: V2Source): Html =>
	h.p(
		[h.Class("text-muted-foreground text-xs")],
		[
			`Maple reads ${platformMeta(source.platform).label} live from its API and stores no telemetry, so there is no volume to count or pause.`,
		],
	)

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

export const overviewTab = (h: H, model: Model, source: V2Source, timeZone: string, nowMs: number): Html => {
	const storesTelemetry = sourceStoresTelemetry(source.platform)
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
					...(storesTelemetry ? [last24h(h, model)] : []),
				],
			),
			storesTelemetry ? volumePanel(h, model, timeZone, nowMs) : liveReadNote(h, source),
			...(hasToken(source) ? [rulesSummary(h, source, nowMs)] : []),
		],
	)
}
