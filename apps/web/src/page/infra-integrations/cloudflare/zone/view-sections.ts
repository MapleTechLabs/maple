import type { CloudflareFilters } from "../../../../components/infra/cloudflare/filters"
import { EMPTY_VALUE, formatNumber, formatPercent } from "@maple/ui/lib/format"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Chart from "../../../../charts/chart"
import { CHART_EMPTY_MESSAGE } from "../../../../charts/infra-metric-chart"
import * as PlotBoxChart from "../../../../charts/plot-box-chart"
import { stackedBreakdown } from "../../../../charts/stacked-breakdown-chart"
import type { ThemeColors } from "../../../../charts/theme-colors"
import { CHART_HEIGHT, chartCard, chartCardMessage } from "../../kit/chart-card"
import { columnHead, dataTable, dataTableEmpty } from "../../../infra/kit/data-table"
import { seriesLegend } from "../../../kit/series-legend"
import type { LongRow } from "../../../../charts/infra-metric-series"
import type { ZoneDns, ZoneSecurity } from "../data"
import { Message, type Model } from "./model"
import { panelScope, type Trigger } from "./view-scope"

// `CloudflareZoneDnsSection`, `CloudflareZoneSecuritySection` and their `StackedBreakdownChart`.

type H = HtmlBuilder<Message>

export type SectionContext = Readonly<{
	filters: CloudflareFilters
	theme: ThemeColors
	timeZone: string
	trigger: Trigger
}>

/** Legend chips beyond this collapse into a `+N`, so the legend can never reflow the card header. */
const MAX_LEGEND_CHIPS = 8

const ROW_CLASS =
	"flex items-center gap-4 border-b border-border-subtle px-4 py-3 last:border-0 hover:bg-surface-sunken active:bg-surface-sunken"

export const SCOPE_IDS = {
	dns: "cf-scope-dns",
	security: "cf-scope-security",
	breakdown: "cf-scope-breakdown",
}

const stackedChart = (
	h: H,
	model: Model,
	options: Readonly<{
		title: string
		rows: ReadonlyArray<LongRow>
		colors: Readonly<Record<string, string>>
		order: ReadonlyArray<string>
		scope: Html | undefined
		chartId: string
	}>,
	ctx: SectionContext,
): Html => {
	const built = stackedBreakdown({
		rows: options.rows,
		colors: options.colors,
		order: options.order,
		theme: ctx.theme,
		timeZone: ctx.timeZone,
		gradientPrefix: options.chartId,
	})
	return chartCard(
		h,
		{
			title: options.title,
			scope: options.scope,
			legend: seriesLegend(h, {
				maxItems: MAX_LEGEND_CHIPS,
				items: built.legend.map(({ name, label, color }) => ({
					key: name,
					label,
					title: label,
					color,
				})),
			}),
		},
		[
			built.isEmpty
				? chartCardMessage(h, CHART_EMPTY_MESSAGE)
				: h.submodel({
						slotId: options.chartId,
						model: model.charts[options.chartId] ?? Chart.init(),
						view: PlotBoxChart.view,
						toParentMessage: (message: Chart.Message) =>
							Message.GotChartMessage({ chartId: options.chartId, message }),
						viewInputs: {
							chartId: options.chartId,
							spec: built.spec,
							ariaLabel: options.title,
							height: CHART_HEIGHT,
						},
					}),
		],
	)
}

const busy = (h: H, isWaiting: boolean) => [
	h.Class(cn("space-y-4", refreshingClass(isWaiting))),
	...(isWaiting ? [h.AriaBusy(true)] : []),
]

// NOERROR is healthy; NXDOMAIN is the interesting signal; server-side failures render hot.
const RESPONSE_CODE_COLORS = {
	NOERROR: "var(--severity-info)",
	NXDOMAIN: "var(--severity-warn)",
	SERVFAIL: "var(--severity-error)",
	REFUSED: "color-mix(in oklab, var(--severity-error) 60%, transparent)",
	unknown: "color-mix(in oklab, var(--muted-foreground) 35%, transparent)",
} as const satisfies Record<string, string>

const RESPONSE_CODE_ORDER = ["NOERROR", "NXDOMAIN", "SERVFAIL", "REFUSED", "unknown"]

/** `CloudflareZoneDnsSection`: nothing when the zone has no DNS analytics. */
export const dnsSection = (
	h: H,
	model: Model,
	data: ZoneDns,
	isWaiting: boolean,
	ctx: SectionContext,
): Html | null => {
	if (data.buckets.length === 0 && data.names.length === 0) return null
	const rows = [...data.names].sort((a, b) => b.queries - a.queries)
	return h.div(busy(h, isWaiting), [
		stackedChart(
			h,
			model,
			{
				title: "DNS queries by response code",
				rows: data.buckets.map((bucket) => ({
					bucket: bucket.bucket,
					attributeValue: bucket.responseCode,
					value: bucket.queries,
				})),
				colors: RESPONSE_CODE_COLORS,
				order: RESPONSE_CODE_ORDER,
				chartId: "cf-dns-chart",
				scope: panelScope(h, {
					filters: ctx.filters,
					ignoredFilters: data.ignoredFilters,
					reason: DNS_REASON,
					id: SCOPE_IDS.dns,
					trigger: ctx.trigger,
				}),
			},
			ctx,
		),
		dataTable(
			h,
			{ ariaLabel: "Top DNS query names", isWaiting },
			[
				columnHead(h, { label: "Query name", width: "w-0 flex-1 min-w-56" }),
				columnHead(h, { label: "Queries", align: "right", width: "w-24" }),
				columnHead(h, { label: "NXDOMAIN", align: "right", width: "w-28" }),
			],
			rows.length === 0
				? [dataTableEmpty(h, ["No DNS queries in this window"])]
				: rows.map((row) =>
						h.div(
							[h.Key(row.queryName), h.Class(ROW_CLASS)],
							[
								h.div(
									[
										h.Class(
											"w-0 min-w-56 flex-1 truncate font-mono text-xs text-foreground",
										),
									],
									[row.queryName],
								),
								h.div(
									[
										h.Class(
											"w-24 text-right font-mono text-xs tabular-nums text-foreground-soft",
										),
									],
									[formatNumber(row.queries)],
								),
								h.div(
									[
										h.Class(
											"w-28 text-right font-mono text-xs tabular-nums text-foreground-soft",
										),
									],
									[
										row.queries > 0
											? formatPercent(row.nxdomain / row.queries)
											: EMPTY_VALUE,
									],
								),
							],
						),
					),
		),
	])
}

export const DNS_REASON = "DNS analytics is a separate dataset with its own dimensions"
export const SECURITY_REASON = "Firewall events carry their own dimensions"

// Blocks render hot, challenges in the warn ramp, pass-through actions stay muted.
const ACTION_COLORS = {
	block: "var(--severity-error)",
	drop: "var(--severity-error)",
	challenge: "var(--severity-warn)",
	jschallenge: "color-mix(in oklab, var(--severity-warn) 75%, transparent)",
	managed_challenge: "color-mix(in oklab, var(--severity-warn) 55%, transparent)",
	skip: "color-mix(in oklab, var(--muted-foreground) 55%, transparent)",
	log: "color-mix(in oklab, var(--muted-foreground) 40%, transparent)",
	allow: "var(--severity-info)",
	unknown: "color-mix(in oklab, var(--muted-foreground) 25%, transparent)",
} as const satisfies Record<string, string>

const ACTION_ORDER = [
	"block",
	"drop",
	"challenge",
	"jschallenge",
	"managed_challenge",
	"skip",
	"log",
	"allow",
	"unknown",
]

/** `CloudflareZoneSecuritySection`: nothing when the window has no security events. */
export const securitySection = (
	h: H,
	model: Model,
	data: ZoneSecurity,
	isWaiting: boolean,
	ctx: SectionContext,
): Html | null => {
	if (data.buckets.length === 0 && data.top.length === 0) return null
	const rows = [...data.top].sort((a, b) => b.events - a.events)
	const cell = (className: string, text: string) => h.div([h.Class(className)], [text])
	return h.div(busy(h, isWaiting), [
		stackedChart(
			h,
			model,
			{
				title: "Security events by action",
				rows: data.buckets.map((bucket) => ({
					bucket: bucket.bucket,
					attributeValue: bucket.action,
					value: bucket.events,
				})),
				colors: ACTION_COLORS,
				order: ACTION_ORDER,
				chartId: "cf-security-chart",
				scope: panelScope(h, {
					filters: ctx.filters,
					ignoredFilters: data.ignoredFilters,
					reason: SECURITY_REASON,
					id: SCOPE_IDS.security,
					trigger: ctx.trigger,
				}),
			},
			ctx,
		),
		dataTable(
			h,
			{ ariaLabel: "Top security rules", isWaiting },
			[
				columnHead(h, { label: "Rule", width: "w-0 flex-1 min-w-52" }),
				columnHead(h, { label: "Source", width: "w-32", hidden: "hidden md:flex" }),
				columnHead(h, { label: "Action", width: "w-32" }),
				columnHead(h, { label: "Host", width: "w-44", hidden: "hidden lg:flex" }),
				columnHead(h, { label: "Events", align: "right", width: "w-24" }),
			],
			rows.length === 0
				? [dataTableEmpty(h, ["No security events in this window"])]
				: rows.map((row) =>
						h.div(
							[
								h.Key(`${row.source}:${row.action}:${row.ruleId}:${row.host}`),
								h.Class(ROW_CLASS),
							],
							[
								cell(
									"w-0 min-w-52 flex-1 truncate font-mono text-xs text-foreground",
									row.ruleId,
								),
								cell(
									"hidden w-32 truncate font-mono text-xs text-foreground-soft md:block",
									row.source,
								),
								cell("w-32 truncate font-mono text-xs text-foreground-soft", row.action),
								cell(
									"hidden w-44 truncate font-mono text-xs text-foreground-soft lg:block",
									row.host,
								),
								cell(
									"w-24 text-right font-mono text-xs tabular-nums text-foreground-soft",
									formatNumber(row.events),
								),
							],
						),
					),
		),
	])
}
