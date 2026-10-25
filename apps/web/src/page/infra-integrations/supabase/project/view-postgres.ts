import type { SupabaseProjectInsights } from "@maple/domain/http"
import { formatLatency, formatNumber, formatPercent } from "@maple/ui/lib/format"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Chart from "../../../../charts/chart"
import * as InfraMetricChart from "../../../../charts/infra-metric-chart"
import type { ThemeColors } from "../../../../charts/theme-colors"
import { chartLoading } from "../../../../ui/chart-state"
import { chartCard, chartCardMessage, CHART_HEIGHT } from "../../kit/chart-card"
import { type MetricChart, metricChartRows } from "../../kit/metric-charts"
import { relativeTime } from "../../../kit/relative-time"
import type { SupabaseProjectTimeseriesRow } from "../model"
import { CONNECTIONS_CHART, TRANSACTIONS_CHART } from "./charts"
import { queryShares, rollbackShare } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { keyedBody, panelEmpty, panelMeta, sectionPanel } from "../panel"

// The Postgres row: connections against the limit, transactions per second, slowest statements.

type H = HtmlBuilder<Message>
type Row = SupabaseProjectTimeseriesRow
type Clock = Readonly<{ nowMs: number; timeZone: string }>

const metricPlot = (
	h: H,
	model: Model,
	chart: MetricChart<Row>,
	rows: ReadonlyArray<Row>,
	theme: ThemeColors,
	timeZone: string,
): Html =>
	h.submodel({
		slotId: `supabase-${chart.id}`,
		model: model.charts[chart.id] ?? Chart.init(),
		view: InfraMetricChart.view,
		toParentMessage: (message: Chart.Message) => Message.GotChartMessage({ chartId: chart.id, message }),
		viewInputs: {
			chartId: `supabase-${chart.id}`,
			height: CHART_HEIGHT,
			spec: InfraMetricChart.infraMetricSpec({
				rows: metricChartRows(chart, rows),
				unit: chart.unit,
				xDomain: rows.map((row) => row.bucket),
				seriesColors: { Limit: "--severity-warn" },
				theme,
				timeZone,
				gradientPrefix: `supabase-${chart.id}`,
			}),
		},
	})

/** A chart card over the timeseries: loading until the runtime and theme are in, then the plot. */
const metricCard = (
	h: H,
	model: Model,
	options: Readonly<{ title: string; scope?: string; chart: MetricChart<Row>; theme: ThemeColors | null }>,
	timeZone: string,
): Html =>
	chartCard(
		h,
		{
			title: options.title,
			scope: options.scope === undefined ? undefined : panelMeta(h, options.scope),
		},
		[
			h.div(
				[h.Class("px-3 pb-3")],
				[
					keyedBody(h, model.timeseries, {
						rows: 4,
						failureTitle: "Couldn't load project metrics",
						onRetry: Message.ClickedRetry({ section: "timeseries" }),
						render: (rows) =>
							rows.length === 0
								? chartCardMessage(h, "No metrics in this time range.")
								: options.theme === null || model.chartRuntime._tag !== "Ready"
									? chartLoading(h, { variant: "line", height: CHART_HEIGHT })
									: metricPlot(h, model, options.chart, rows, options.theme, timeZone),
					}),
				],
			),
		],
	)

const queriesBody = (h: H, insights: SupabaseProjectInsights, clock: Clock): Html => {
	const checked =
		insights.queriesCheckedAt === null
			? []
			: [
					h.p(
						[h.Class("px-4 pt-2 text-2xs text-muted-foreground")],
						[
							relativeTime(h, {
								value: insights.queriesCheckedAt,
								...clock,
								prefix: "checked",
								tooltip: "title",
							}),
						],
					),
				]
	const failed =
		insights.queriesError === null
			? []
			: [
					h.p(
						[
							h.Class(
								"line-clamp-2 px-4 pt-2 text-2xs text-severity-error [overflow-wrap:anywhere]",
							),
							h.Title(insights.queriesError),
						],
						[`Last check failed: ${insights.queriesError}`],
					),
				]
	if (insights.topQueries.length === 0)
		return h.div(
			[],
			[
				...failed,
				panelEmpty(h, [
					insights.queriesCheckedAt === null
						? "Maple reads pg_stat_statements every 15 minutes; the first read has not run yet."
						: "No statements recorded yet.",
				]),
			],
		)
	const shares = queryShares(insights.topQueries)
	return h.div(
		[],
		[
			...failed,
			...checked,
			h.ul(
				[h.AriaLabel("Slowest queries")],
				insights.topQueries
					.slice(0, 5)
					.map((query, index) =>
						h.li(
							[
								h.Key(query.queryId),
								h.Class(
									"flex items-start gap-3 border-t border-border/40 px-4 py-2.5 first:border-t-0",
								),
							],
							[
								h.div(
									[h.Class("flex min-w-0 flex-1 flex-col gap-1")],
									[
										h.code(
											[
												h.Class("line-clamp-1 font-mono text-2xs text-foreground"),
												h.Title(query.query),
											],
											[query.query],
										),
										h.span(
											[h.Class("font-mono text-2xs text-muted-foreground")],
											[
												`${formatNumber(query.calls)} calls · ${formatLatency(query.meanExecMs)} mean`,
											],
										),
									],
								),
								h.span(
									[h.Class("shrink-0 font-mono text-2xs tabular-nums text-foreground")],
									[formatPercent(shares[index] ?? 0)],
								),
							],
						),
					),
			),
		],
	)
}

export const postgresRow = (
	h: H,
	model: Model,
	options: Readonly<{ theme: ThemeColors | null; limit: number | null; clock: Clock }>,
): Html => {
	const rows = Option.getOrElse(AsyncData.getData(model.timeseries.data), (): ReadonlyArray<Row> => [])
	const rollback = rollbackShare(rows)
	const { theme, clock } = options
	return h.div(
		[h.Class("grid grid-cols-1 gap-4 lg:grid-cols-3")],
		[
			metricCard(
				h,
				model,
				{
					title: "Connections",
					scope: options.limit === null ? undefined : `limit ${options.limit}`,
					chart: CONNECTIONS_CHART,
					theme,
				},
				clock.timeZone,
			),
			metricCard(
				h,
				model,
				{
					title: "Transactions / s",
					scope: rollback === null ? undefined : `rollback ${formatPercent(rollback)}`,
					chart: TRANSACTIONS_CHART,
					theme,
				},
				clock.timeZone,
			),
			sectionPanel(h, { title: "Slowest queries", description: "By total time · pg_stat_statements" }, [
				keyedBody(h, model.insights, {
					rows: 4,
					failureTitle: "Couldn't load the slowest queries",
					onRetry: Message.ClickedRetry({ section: "insights" }),
					render: (insights) => queriesBody(h, insights, clock),
				}),
			]),
		],
	)
}
