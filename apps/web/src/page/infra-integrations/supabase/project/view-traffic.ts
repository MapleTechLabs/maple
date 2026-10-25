import type { SupabaseApiTopPathsResponse, SupabaseApiTrafficResponse } from "@maple/domain/http"
import { formatErrorRate, formatLatency, formatNumber, formatPercent } from "@maple/ui/lib/format"
import { resolveSeriesColors } from "@maple/ui/lib/semantic-series-colors"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as BarChart from "../../../../charts/bar-chart"
import * as Chart from "../../../../charts/chart"
import type { ThemeColors } from "../../../../charts/theme-colors"
import { chartLoading, chartPlotArea } from "../../../../ui/chart-state"
import { ERROR_RATE_LIMIT } from "../health"
import { STATUS_CLASSES, trafficRows, trafficShares } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { keyedBody, MANAGE_HREF, panelEmpty, panelLink, sectionPanel } from "../panel"

// "API requests": the gateway's requests by status class, its totals, and the busiest paths.

type H = HtmlBuilder<Message>

const PLOT_HEIGHT = 220
const STATUS_COLORS = resolveSeriesColors([...STATUS_CLASSES])

const total = (h: H, value: string, label: string, className?: string): Html =>
	h.div(
		[h.Class("flex flex-col items-end gap-0.5")],
		[
			h.span([h.Class(cn("font-mono text-lg tabular-nums text-foreground", className))], [value]),
			h.span([h.Class("text-2xs text-muted-foreground")], [label]),
		],
	)

const totals = (h: H, traffic: SupabaseApiTrafficResponse): Html =>
	h.div(
		[h.Class("flex items-start gap-6")],
		[
			total(h, formatNumber(traffic.requests), "requests"),
			total(
				h,
				formatErrorRate(traffic.errorRate5xx),
				"5xx",
				traffic.errorRate5xx >= ERROR_RATE_LIMIT ? "text-severity-error" : undefined,
			),
			total(h, formatLatency(traffic.p95OriginMs), "p95 origin time"),
		],
	)

const legend = (h: H, traffic: SupabaseApiTrafficResponse, isOpen: boolean): Html =>
	h.div(
		[h.Class("flex flex-wrap items-center justify-between gap-3 px-4 pb-3")],
		[
			h.div(
				[h.Class("flex flex-wrap items-center gap-4")],
				trafficShares(traffic.buckets).map(({ status, share }) =>
					h.span(
						[
							h.Key(status),
							h.Class(
								"inline-flex items-center gap-1.5 font-mono text-2xs text-muted-foreground",
							),
						],
						[
							h.span([
								h.Class("size-2 rounded-xs"),
								h.Style({
									"background-color":
										STATUS_COLORS.get(status) ?? "var(--muted-foreground)",
								}),
							]),
							`${status} ${formatPercent(share)}`,
						],
					),
				),
			),
			h.button(
				[
					h.Type("button"),
					h.AriaExpanded(isOpen),
					h.OnClick(Message.ClickedToggleTopPaths()),
					h.Class("text-2xs text-muted-foreground transition-colors hover:text-foreground"),
				],
				[isOpen ? "Hide top paths" : "Top paths →"],
			),
		],
	)

const bars = (
	h: H,
	model: Model,
	traffic: SupabaseApiTrafficResponse,
	theme: ThemeColors | null,
	timeZone: string,
) =>
	chartPlotArea(h, PLOT_HEIGHT, [
		theme === null || model.chartRuntime._tag !== "Ready"
			? chartLoading(h, { variant: "bar" })
			: h.submodel({
					slotId: "supabase-traffic",
					model: model.charts.traffic ?? Chart.init(),
					view: BarChart.view,
					toParentMessage: (message: Chart.Message) =>
						Message.GotChartMessage({ chartId: "traffic", message }),
					viewInputs: {
						chartId: "supabase-traffic",
						data: trafficRows(traffic.buckets),
						theme,
						timeZone,
						nowMs: model.nowMs,
						stacked: true,
						className: "h-full w-full",
					},
				}),
	])

const PATH_ROW = "flex items-center gap-4 border-t border-border/40 px-4 py-2 text-xs"

const topPathsList = (h: H, paths: SupabaseApiTopPathsResponse): Html =>
	paths.paths.length === 0
		? panelEmpty(h, ["No paths in this time range."])
		: h.div(
				[h.AriaLabel("Top paths")],
				paths.paths.map((path) =>
					h.div(
						[h.Key(`${path.method} ${path.path}`), h.Class(PATH_ROW)],
						[
							h.span(
								[h.Class("w-14 shrink-0 font-mono text-2xs text-muted-foreground")],
								[path.method],
							),
							h.span(
								[h.Class("min-w-0 flex-1 truncate font-mono"), h.Title(path.path)],
								[path.path],
							),
							h.span(
								[h.Class("w-20 text-right font-mono tabular-nums")],
								[formatNumber(path.requests)],
							),
							h.span(
								[
									h.Class(
										cn(
											"w-16 text-right font-mono tabular-nums",
											path.errors5xx > 0
												? "text-severity-error"
												: "text-muted-foreground",
										),
									),
								],
								[`${formatNumber(path.errors5xx)} 5xx`],
							),
							h.span(
								[h.Class("w-20 text-right font-mono tabular-nums text-muted-foreground")],
								[formatLatency(path.p95OriginMs)],
							),
						],
					),
				),
			)

const trafficBody = (
	h: H,
	model: Model,
	traffic: SupabaseApiTrafficResponse,
	theme: ThemeColors | null,
	timeZone: string,
	isLogsEnabled: boolean,
): Html => {
	if (traffic.requests === 0)
		return isLogsEnabled
			? panelEmpty(h, ["No API requests in this time range."])
			: panelEmpty(h, [
					"API traffic comes from this project's logs. Turn on Logs for it to see requests here. ",
					panelLink(h, MANAGE_HREF, "Manage projects"),
				])
	return h.div(
		[],
		[
			h.div([h.Class("flex justify-end px-4 pt-3")], [totals(h, traffic)]),
			h.div([h.Class("px-4 py-3")], [bars(h, model, traffic, theme, timeZone)]),
			legend(h, traffic, model.isTopPathsOpen),
			...(model.isTopPathsOpen
				? [
						keyedBody(h, model.topPaths, {
							rows: 4,
							failureTitle: "Couldn't load the top paths",
							onRetry: Message.ClickedRetry({ section: "topPaths" }),
							render: (paths) => topPathsList(h, paths),
						}),
					]
				: []),
		],
	)
}

export const trafficPanel = (
	h: H,
	model: Model,
	theme: ThemeColors | null,
	timeZone: string,
	isLogsEnabled: boolean,
): Html =>
	sectionPanel(
		h,
		{
			title: "API requests",
			description: "REST, Auth, Storage and Realtime through the Supabase gateway",
			className: "lg:col-span-2",
		},
		[
			keyedBody(h, model.traffic, {
				rows: 6,
				failureTitle: "Couldn't load API requests",
				onRetry: Message.ClickedRetry({ section: "traffic" }),
				render: (traffic) => trafficBody(h, model, traffic, theme, timeZone, isLogsEnabled),
			}),
		],
	)
