import { formatWarehouseDateTime } from "@maple/query-engine"
import { EMPTY_VALUE } from "@maple/ui/lib/empty-value"
import { cn } from "@maple/ui/lib/utils"
import { badgeVariants } from "@maple/ui/styles/ui/badge"
import { eyebrowVariants } from "@maple/ui/styles/ui/eyebrow"
import { errorRate } from "@maple/web-data/lib/tool-analytics"
import { Option, Record } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Chart from "../../charts/chart"
import type { ThemeColors } from "../../charts/theme-colors"
import { chartEmpty } from "../../ui/chart-state"
import { icon, type IconName } from "../../ui/icon"
import { panelHeader } from "../../ui/panel"
import { relativeTime } from "../kit/relative-time"
import { seriesLegend } from "../kit/series-legend"
import { TOOL_CHIP } from "../agent-sessions/kit/error-chip"
import type { ToolPercentile, ToolSeriesPoint } from "../agent-sessions/tools-kit/model"
import { type ToolPlotInputs, toolPlotView } from "../agent-sessions/tools-kit/series-chart"
import { volumeSparkCell } from "../agent-sessions/tools-kit/spark"
import type { McpClientKind } from "./data"

// Pieces every MCP view shares: the chart cell over `toolPlotView`, section headings, client glyphs.

/** The tokens the MCP charts read off the theme. */
export const MCP_CHART_TOKENS = [
	"--primary",
	"--color-severity-error",
	"--muted-foreground",
	"--chart-1",
	"--chart-2",
	"--chart-3",
	"--chart-4",
	"--chart-5",
	"--chart-throughput",
	"--border",
	"--background",
]

export type McpChartEnv<M> = Readonly<{
	charts: Readonly<Record<string, Chart.Model>>
	theme: ThemeColors
	timeZone: string
	toChart: (chartId: string, message: Chart.Message) => M
	spark: McpSparkEnv<M>
}>

/** A Volume spark's colour, resolved for the canvas, and where its (ignored) messages go. */
export type McpSparkEnv<M> = Readonly<{ color: string; toMessage: (message: Chart.Message) => M }>

/** The Volume cell: the Agent Tools table's line spark, framed even when the row is all zeros. */
export const volumeSpark = <M>(
	h: HtmlBuilder<M>,
	spark: McpSparkEnv<M>,
	chartId: string,
	values: ReadonlyArray<number>,
): Html => volumeSparkCell(h, { chartId, values, color: spark.color, toMessage: spark.toMessage })

type PlotSeries = ToolPlotInputs["series"]
type PlotRows = ToolPlotInputs["rows"]

/** The window the page reads: where it starts, its name and its bucket width. */
export type McpWindow = Readonly<{ startMs: number; label: string; bucketLabel: string }>

/** What the toolbar narrows the page to; the scope row names it. */
export type McpFilters = Readonly<{
	search: string
	client: string | undefined
	kind: string | undefined
	isFailingOnly: boolean
}>

/** The scope row's text: the subject (tools or one tool), then the clients, then the failing filter. */
export const scopeText = (subject: string, filters: McpFilters): string => {
	const needle = filters.search.trim()
	const clients = filters.client ?? (filters.kind === undefined ? "all clients" : `${filters.kind} clients`)
	return [
		needle === "" ? subject : `${subject} matching "${needle}"`,
		clients,
		...(filters.isFailingOnly ? ["failing only"] : []),
	].join(" · ")
}

/** One row per bucket: the calls, failures, failure rate and percentiles of a merged series. */
export const seriesRows = (points: ReadonlyArray<ToolSeriesPoint>): PlotRows =>
	points
		.toSorted((a, b) => a.bucket - b.bucket)
		.map((point) => ({
			bucket: formatWarehouseDateTime(point.bucket),
			calls: point.calls,
			failed: point.errors,
			errorRate: errorRate(point),
			p50: point.p50,
			p90: point.p90,
			p95: point.p95,
		}))

const CLIENT_TOKENS = ["--chart-2", "--chart-3", "--chart-4", "--chart-1", "--chart-5"]
const OTHER_KEY = "__other__"

/** A stable slot per name, so one client keeps its colour on every page; a taken slot probes on. */
const clientTokens = (names: ReadonlyArray<string>): ReadonlyMap<string, string> => {
	const taken = new Set<number>()
	return new Map(
		names.map((name) => {
			const hash = Array.from({ length: name.length }, (_, index) => name.charCodeAt(index)).reduce(
				(sum, code) => (sum * 31 + code) % 9973,
				7,
			)
			const slot =
				Array.from(
					{ length: CLIENT_TOKENS.length },
					(_, step) => (hash + step) % CLIENT_TOKENS.length,
				).find((index) => !taken.has(index)) ?? 0
			taken.add(slot)
			return [name, CLIENT_TOKENS[slot] ?? "--chart-5"]
		}),
	)
}

/** Calls by client: the top clients by summed calls, the rest folded into "Other". */
export const clientPlot = (
	points: ReadonlyArray<ToolSeriesPoint>,
): Readonly<{ rows: PlotRows; series: PlotSeries }> => {
	const totals = points.reduce(
		(sum, point) => sum.set(point.seriesKey, (sum.get(point.seriesKey) ?? 0) + point.calls),
		new Map<string, number>(),
	)
	const ranked = [...totals]
		.filter(([, calls]) => calls > 0)
		.toSorted((a, b) => b[1] - a[1])
		.map(([name]) => name)
	const named = ranked.slice(0, CLIENT_TOKENS.length)
	const rest = new Set(ranked.slice(CLIENT_TOKENS.length))
	const tokens = clientTokens(named)
	const buckets = [...new Set(points.map((point) => point.bucket))].toSorted((a, b) => a - b)
	const callsAt = (bucket: number, keep: (key: string) => boolean) =>
		points
			.filter((point) => point.bucket === bucket && keep(point.seriesKey))
			.reduce((sum, point) => sum + point.calls, 0)
	const column = (key: string, keep: (seriesKey: string) => boolean) => ({ key, keep })
	const columns = [
		...named.map((name) => column(name, (key) => key === name)),
		...(rest.size === 0 ? [] : [column(OTHER_KEY, (key) => rest.has(key))]),
	]
	return {
		rows: buckets.map((bucket) => ({
			bucket: formatWarehouseDateTime(bucket),
			...Object.fromEntries(columns.map((entry) => [entry.key, callsAt(bucket, entry.keep)])),
		})),
		series: [
			...named.map((name) => ({ key: name, label: name, token: tokens.get(name) ?? "--chart-5" })),
			...(rest.size === 0 ? [] : [{ key: OTHER_KEY, label: "Other", token: "--muted-foreground" }]),
		],
	}
}

/** The three percentiles, the picked one in the primary (as Agent Tools' `seriesFor`). */
export const durationSeries = (percentile: ToolPercentile): PlotSeries =>
	(["p50", "p90", "p95"] as const).map((key) => ({
		key,
		label: key.toUpperCase(),
		token:
			key === percentile
				? "--primary"
				: key === "p95"
					? "--color-severity-error"
					: "--muted-foreground",
	}))

/** A chart cell: the title and legend, then the plot (or the empty note). */
export const mcpPlot = <M>(
	h: HtmlBuilder<M>,
	env: McpChartEnv<M>,
	options: Readonly<{
		chartId: string
		title: string
		action?: Html
		rows: PlotRows
		series: PlotSeries
		format: ToolPlotInputs["format"]
		height: number
		className?: string
	}>,
): Html =>
	h.section(
		[h.Class(cn("flex min-w-0 flex-col gap-3.5 border-b border-border px-6 py-5", options.className))],
		[
			panelHeader(h, {
				title: options.title,
				action:
					options.action ??
					(options.series.length > 1
						? seriesLegend(h, {
								items: options.series.map((entry) => ({
									key: entry.key,
									label: entry.label,
									color: `var(${entry.token})`,
								})),
							})
						: undefined),
				divided: false,
				className: "px-0 pt-0",
			}),
			options.rows.length === 0
				? chartEmpty(h, { height: options.height }, ["No calls in the selected window."])
				: h.submodel({
						slotId: options.chartId,
						model: Option.getOrElse(Record.get(env.charts, options.chartId), () => Chart.init()),
						view: toolPlotView,
						toParentMessage: (message) => env.toChart(options.chartId, message),
						viewInputs: {
							chartId: options.chartId,
							ariaLabel: options.title,
							height: options.height,
							rows: options.rows,
							series: options.series,
							format: options.format,
							tickCount: 3,
							marginTop: 6,
							theme: env.theme,
							timeZone: env.timeZone,
						},
					}),
		],
	)

/** A table section's heading row: the title, its count, and an optional right side. */
export const sectionTitle = <M>(
	h: HtmlBuilder<M>,
	title: string,
	count: string | undefined,
	right?: Html,
): Html =>
	h.div(
		[h.Class("flex items-center justify-between gap-3 pb-3")],
		[
			h.div(
				[h.Class("flex items-baseline gap-2.5 font-mono")],
				[
					h.span([h.Class("text-xs font-medium text-foreground")], [title]),
					...(count === undefined
						? []
						: [
								h.span(
									[h.Class("text-2xs leading-3.5 tabular-nums text-foreground-subtle")],
									[count],
								),
							]),
				],
			),
			...(right === undefined ? [] : [right]),
		],
	)

/** A right-aligned mono number cell; the width and tone come from the caller. */
export const numberCell = <M>(h: HtmlBuilder<M>, value: string, className: string): Html =>
	h.span([h.Class(cn("shrink-0 text-right font-mono text-xs tabular-nums", className))], [value])

/** The Agent Tools table's "Last call" cell: relative, a date once it is old, absolute on hover. */
export const lastSeenCell = <M>(h: HtmlBuilder<M>, value: number, nowMs: number, timeZone: string): Html =>
	relativeTime(h, {
		value,
		variant: "orDate",
		tooltip: "title",
		nowMs,
		timeZone,
		className:
			"hidden w-24 shrink-0 text-right font-mono text-2xs tabular-nums text-foreground-subtle @min-[800px]/panel:block",
	})

/** A tool's swatch colour, by its rank, so the same tool reads the same on every MCP view. */
const TOOL_COLORS = ["var(--chart-2)", "var(--chart-1)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"]
export const toolColor = (index: number): string =>
	TOOL_COLORS[index % TOOL_COLORS.length] ?? "var(--chart-2)"

/** An attribute name, in the inline code style. */
export const attr = <M>(h: HtmlBuilder<M>, name: string): Html =>
	h.code([h.Class("rounded bg-muted px-1 py-px font-mono text-2xs text-foreground")], [name])

/** The muted mono note on the right of a heading. */
export const headingNote = <M>(h: HtmlBuilder<M>, text: string): Html =>
	h.span([h.Class("font-mono text-2xs text-foreground-subtle")], [text])

const CLIENT_ICONS = new Map<string, IconName>([
	["Claude Code", "ClaudeIcon"],
	["Claude", "ClaudeIcon"],
	["curl", "SquareTerminalIcon"],
	["Bun", "BunIcon"],
	["Node (undici)", "NodejsIcon"],
	["Codex", "OpenAiIcon"],
	["VS Code", "VsCodeIcon"],
])

/** A client's glyph: its brand mark when known, a globe otherwise. */
export const clientIcon = <M>(h: HtmlBuilder<M>, name: string, size = 14): Html =>
	icon(h, CLIENT_ICONS.get(name) ?? "GlobeIcon", {
		size,
		className: cn("shrink-0", CLIENT_ICONS.has(name) ? "" : "text-muted-foreground"),
	})

/** The client's kind as a quiet uppercase tag; unknown clients carry none. */
export const kindTag = <M>(h: HtmlBuilder<M>, kind: McpClientKind): ReadonlyArray<Html> =>
	kind === "unknown"
		? []
		: [h.span([h.Class("font-mono text-3xs uppercase tracking-wide text-foreground-subtle")], [kind])]

/** `error.type` as a pill, in the tone Agent Sessions gives tool failures. */
export const errorTypeChip = <M>(h: HtmlBuilder<M>, errorType: string): Html =>
	h.span([h.Class(cn(badgeVariants({ pill: true, size: "xs", mono: true }), TOOL_CHIP))], [errorType])

/** An unknown zone throws in the constructor; the clock then reads as the empty value. */
const clockFormatter = Option.liftThrowable(
	(timeZone: string) => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone }),
)
const clockFormatters = new Map<string, Option.Option<Intl.DateTimeFormat>>()

/** "13:26" in the page's zone; one formatter per zone. */
export const formatClock = (epochMs: number, timeZone: string): string => {
	const formatter = clockFormatters.get(timeZone) ?? clockFormatter(timeZone)
	clockFormatters.set(timeZone, formatter)
	return Option.match(formatter, { onNone: () => EMPTY_VALUE, onSome: (f) => f.format(epochMs) })
}

/** The scope row: what the page is narrowed to, and the window's totals. */
export const mcpScopeRow = <M>(h: HtmlBuilder<M>, scope: string, count: string, rest: string): Html =>
	h.div(
		[
			h.Class(
				"flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border bg-card px-6 py-2.5 font-mono",
			),
		],
		[
			h.div(
				[h.Class("flex flex-wrap items-center gap-2")],
				[
					h.span([h.Class(eyebrowVariants({ variant: "mono" }))], ["Scope"]),
					h.span([h.Class("text-2xs text-foreground-subtle")], [scope]),
				],
			),
			h.span(
				[h.Class("flex items-center gap-1.5 text-2xs tabular-nums")],
				[
					h.span([h.Class("text-foreground")], [count]),
					h.span([h.Class("text-muted-foreground")], [rest]),
				],
			),
		],
	)

export const SEMCONV_MCP_URL = "https://semconv.com/domains/mcp"
