import { errorRateLevel } from "@maple/ui/lib/error-rate"
import { formatErrorRate } from "@maple/ui/lib/format"
import { errorRate, formatDurationNs, formatToolCount } from "@maple/web-data/lib/tool-analytics"
import type { Html, HtmlBuilder } from "foldkit/html"
import { icon } from "../../ui/icon"
import { backdropBar } from "../../ui/meter"
import { panel, panelBody, panelHeader } from "../../ui/panel"
import { textLink } from "../../ui/text-link"
import { truncatedText } from "../../ui/truncated-text"
import { errorRateValue, latencyValue } from "../../ui/values"
import { statRail, statRailItem } from "../kit/stat-rail"
import { toolSpark } from "../agent-sessions/tools-kit/spark"
import type { McpServerOverview } from "./data"
import { clientIcon, kindTag, type McpSparkEnv, toolColor } from "./view-kit"

// The service page's MCP tab: a summary of the server that links into `/mcp/:service`. Its panels
// are the Overview tab's (`topOperationsPanel`): backdrop bars, toned values, a spark per row.

export type ServiceTabOptions<M> = Readonly<{
	onOpenServer: M
	onOpenTool: (tool: string) => M
	/** The services tabs' spark colour (`--chart-throughput`), resolved for the canvas. */
	spark: McpSparkEnv<M>
}>

const PANEL_LIMIT = 5

const viewAll = <M>(h: HtmlBuilder<M>, label: string, onClick: M): Html =>
	textLink(h, { className: "text-xs", onClick }, [`${label} →`])

const rowClass =
	"relative flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-surface-sunken active:bg-surface-sunken focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"

const topTools = <M>(h: HtmlBuilder<M>, data: McpServerOverview, options: ServiceTabOptions<M>): Html => {
	const tools = data.tools.slice(0, PANEL_LIMIT)
	const maxCalls = Math.max(...tools.map((row) => row.calls), 1)
	return panel(h, { className: "min-w-0" }, [
		panelHeader(h, {
			title: "Top tools",
			action: viewAll(h, `All ${data.tools.length} tools`, options.onOpenServer),
		}),
		panelBody(h, [
			h.ul(
				[h.Class("divide-y")],
				tools.map((row, index) =>
					h.li(
						[h.Key(row.tool)],
						[
							h.button(
								[
									h.Type("button"),
									h.OnClick(options.onOpenTool(row.tool)),
									h.Class(rowClass),
								],
								[
									backdropBar(h, {
										value: row.calls,
										max: maxCalls,
										className: "bg-muted",
									}),
									h.span(
										[
											h.AriaHidden(true),
											h.Class("relative size-2 shrink-0 rounded-xs"),
											h.Style({ "background-color": toolColor(index) }),
										],
										[],
									),
									truncatedText(h, {
										text: row.tool,
										mono: true,
										className: "relative flex-1 text-xs text-foreground",
									}),
									h.span(
										[
											h.Class(
												"relative flex shrink-0 items-center gap-3 font-mono text-2xs tabular-nums",
											),
										],
										[
											h.span(
												[h.Class("text-foreground")],
												[formatToolCount(row.calls)],
											),
											errorRateValue(h, { rate: errorRate(row) }),
											latencyValue(h, { ms: row.p95 / 1_000_000, scale: "p95" }),
										],
									),
									h.div(
										[h.Class("relative hidden shrink-0 sm:block")],
										[
											toolSpark(h, {
												chartId: `mcp-tab-spark-${row.tool}`,
												values: row.spark,
												color: options.spark.color,
												toMessage: options.spark.toMessage,
												className: "h-5 w-24",
												fillOpacity: [0.5, 0.1],
											}),
										],
									),
								],
							),
						],
					),
				),
			),
		]),
	])
}

const topClients = <M>(h: HtmlBuilder<M>, data: McpServerOverview, options: ServiceTabOptions<M>): Html => {
	const clients = data.clients.slice(0, PANEL_LIMIT)
	const maxCalls = Math.max(...clients.map((client) => client.calls), 1)
	return panel(h, { className: "min-w-0" }, [
		panelHeader(h, { title: "Clients", action: viewAll(h, "View all", options.onOpenServer) }),
		panelBody(h, [
			h.ul(
				[h.Class("divide-y")],
				clients.map((client) =>
					h.li(
						[h.Key(client.name), h.Class("relative flex items-center gap-3 px-4 py-2")],
						[
							backdropBar(h, { value: client.calls, max: maxCalls, className: "bg-muted" }),
							h.span([h.Class("relative flex")], [clientIcon(h, client.name)]),
							h.span(
								[h.Class("relative flex min-w-0 flex-1 items-center gap-2")],
								[
									truncatedText(h, {
										text: client.name,
										mono: true,
										className: "text-xs text-foreground",
									}),
									...kindTag(h, client.kind),
								],
							),
							h.span(
								[
									h.Class(
										"relative flex shrink-0 items-center gap-3 font-mono text-2xs tabular-nums",
									),
								],
								[
									h.span([h.Class("text-foreground")], [formatToolCount(client.calls)]),
									errorRateValue(h, { rate: errorRate(client) }),
								],
							),
						],
					),
				),
			),
		]),
	])
}

export const serviceMcpTab = <M>(
	h: HtmlBuilder<M>,
	data: McpServerOverview,
	options: ServiceTabOptions<M>,
): Html => {
	const { totals } = data
	const top = data.clients[0]
	return h.div(
		[h.Class("flex flex-col gap-4 p-4")],
		[
			h.div(
				[
					h.Class(
						"flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-card px-4 py-2.5",
					),
				],
				[
					h.span(
						[h.Class("flex items-center gap-2.5 text-xs")],
						[
							icon(h, "PlugIcon", { size: 16, className: "text-primary" }),
							"This service is an MCP server",
							h.span(
								[h.Class("text-foreground-subtle")],
								[
									`· MCP ${data.protocolVersion} over ${data.transport} · ${data.tools.length} tools called`,
								],
							),
						],
					),
					viewAll(h, "Open in MCP Servers", options.onOpenServer),
				],
			),
			statRail(h, { columns: 4 }, [
				statRailItem(h, {
					eyebrow: "Tool calls",
					value: formatToolCount(totals.calls),
					spark: data.series.map((point) => point.calls),
					sparkColor: "var(--primary)",
					subline: `${data.tools.length} tools`,
				}),
				statRailItem(h, {
					eyebrow: "Failed calls",
					value: formatErrorRate(errorRate(totals)),
					tone: errorRateLevel(errorRate(totals)),
					spark: data.series.map((point) => point.errors),
					sparkColor: "var(--color-severity-error)",
					subline: `${totals.errors} tool errors`,
				}),
				statRailItem(h, {
					eyebrow: "P95 duration",
					value: formatDurationNs(totals.p95),
					spark: data.series.map((point) => point.p95),
					sparkColor: "var(--primary)",
					subline: `p50 ${formatDurationNs(totals.p50)}`,
				}),
				statRailItem(h, {
					eyebrow: "Clients",
					value: String(data.clients.length),
					subline:
						top === undefined
							? ""
							: `${top.name} ${Math.round((top.calls / Math.max(totals.calls, 1)) * 100)}% of calls`,
				}),
			]),
			h.div(
				[h.Class("grid gap-4 @min-[900px]/page:grid-cols-[3fr_2fr]")],
				[topTools(h, data, options), topClients(h, data, options)],
			),
		],
	)
}
