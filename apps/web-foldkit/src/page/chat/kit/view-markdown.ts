import * as Markdown from "@foldkit/markdown"
import { type ChartSpec, normalizeUnit, parseChartSpec } from "@maple/domain/chat-chart-spec"
import { classifyCell, columnRole, type CellValue } from "../../../components/ai-elements/table-cell-value"
import { httpStatusTone } from "@maple/ui/lib/http"
import { LATENCY_TEXT_TONE, latencyLevel } from "@maple/ui/lib/latency-tone"
import { SEVERITY_COLORS } from "@maple/ui/lib/severity"
import { TONE_TEXT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { panelPaddingStyles, panelStyles, panelToneStyles } from "@maple/ui/styles/ui/panel"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as AreaChart from "../../../charts/area-chart"
import * as BarChart from "../../../charts/bar-chart"
import * as ChartModel from "../../../charts/chart"
import type { ThemeColors } from "../../../charts/theme-colors"
import { chartSkeleton } from "../../../ui/chart-skeleton"
import { panel } from "../../../ui/panel"
import { table, tableBody, tableCell, tableHead, tableHeader, tableRow } from "../../../ui/table"
import type { ViewOverrides } from "../../kit/message-response"
import * as HbarChart from "../../../charts/hbar-chart"
import { MATH_MARK } from "./math"
import { type CodeHost, codeBlock, mermaidBlock } from "./view-code"

// The chat's own markdown elements over Streamdown's: tables on Maple's `Table` with recognised
// cells, and ```chart fences as the query builder's plots.
// Math (`$$…$$`, ```math) is drawn by KaTeX (`kit/math.ts`).

export type ChartHost<M> = Readonly<{
	charts: Readonly<Record<string, ChartModel.Model>>
	theme: ThemeColors | null
	isRuntimeReady: boolean
	nowMs: number
	timeZone: string
	onChart: (id: string, message: ChartModel.Message) => M
}>

// TABLES

/** A cell's text, or `None` when it holds something the model authored itself (a link, an image). */
const inlineText = (inlines: ReadonlyArray<Markdown.Inline>): Option.Option<string> =>
	inlines.reduce<Option.Option<string>>(
		(acc, inline) =>
			Option.flatMap(acc, (text) => {
				switch (inline._tag) {
					case "Text":
					case "InlineCode":
						return Option.some(text + inline.value)
					case "HardBreak":
						return Option.some(text)
					case "Emphasis":
					case "Strong":
					case "Strikethrough":
						return Option.map(inlineText(inline.content), (inner) => text + inner)
					case "Link":
					case "Image":
						return Option.none()
				}
			}),
		Option.some(""),
	)

const REF_CLASS =
	"underline decoration-muted-foreground/40 decoration-dotted underline-offset-2 hover:text-primary hover:decoration-primary/50"

const entityRef = <M>(h: HtmlBuilder<M>, href: string, text: string, className: string): Html =>
	h.a([h.Href(href), h.Target("_blank"), h.Rel("noreferrer"), h.Class(cn(className, REF_CLASS))], [text])

const cellValue = <M>(h: HtmlBuilder<M>, value: Exclude<CellValue, { kind: "plain" }>): Html => {
	switch (value.kind) {
		case "trace":
			return entityRef(h, `/traces/${encodeURIComponent(value.traceId)}`, value.traceId, "font-mono text-foreground")
		case "service":
			return entityRef(h, `/services/${encodeURIComponent(value.name)}`, value.name, "text-foreground")
		case "duration":
			return h.span(
				[h.Class(cn("font-mono", LATENCY_TEXT_TONE[latencyLevel(value.ms, value.scale)]))],
				[value.value, ...(value.note === null ? [] : [h.span([h.Class("ml-1 text-muted-foreground")], [value.note])])],
			)
		case "severity":
			return h.span([h.Style({ color: SEVERITY_COLORS[value.label] ?? "" })], [value.label])
		case "flag":
			return h.span([h.Class(value.severe ? "text-severity-error" : "text-muted-foreground")], [value.text])
		case "status":
			return h.span([h.Class(cn("font-mono", TONE_TEXT[httpStatusTone(value.code)]))], [value.text])
	}
}

/** `MarkdownTable`: Maple's `Table` in a panel; body cells under a known header are recognised. */
const tableView =
	<M>(h: HtmlBuilder<M>, knownServices: ReadonlySet<string>) =>
	(views: Markdown.Views) =>
	(node: Markdown.Table): Html => {
		const headers = node.headerRow.cells.map((cell) => Option.getOrElse(inlineText(cell.content), () => ""))
		const content = (cell: Markdown.TableCell): ReadonlyArray<Html | string> =>
			Markdown.viewBlocks(
				{ blocks: [{ _tag: "Paragraph", content: cell.content }] },
				{ views: { ...views, Paragraph: (_paragraph, inline) => h.span([h.Class("contents")], inline) } },
			)
		return panel(h, { className: "my-3" }, [
			table(h, { className: "text-xs" }, [
				tableHeader(
					h,
					[tableRow(h, node.headerRow.cells.map((cell) => tableHead(h, content(cell), "h-8 px-3 text-xs")))],
					{ className: "bg-muted/40" },
				),
				tableBody(
					h,
					node.bodyRows.map((row) =>
						tableRow(
							h,
							row.cells.map((cell, column) => {
								const header = headers[column] ?? ""
								const value = Option.match(inlineText(cell.content), {
									onNone: (): CellValue => ({ kind: "plain" }),
									onSome: (text) => classifyCell(text, { role: columnRole(header), header, knownServices }),
								})
								return tableCell(
									h,
									value.kind === "plain" ? content(cell) : [cellValue(h, value)],
									cn("px-3 py-2 text-xs text-foreground tabular-nums", "[&_code]:bg-transparent [&_code]:p-0 [&_code]:text-xs"),
								)
							}),
						),
					),
				),
			]),
		])
	}

// CHARTS

const PLOT_HEIGHT = "h-[160px] w-full"

/** `<Panel render={<figure />} padded="sm">` and `<Panel render={<pre />} tone="muted" padded="sm">`. */
const panelClass = (tone: "default" | "muted", className: string): string =>
	cn(panelStyles, panelToneStyles[tone], panelPaddingStyles.sm, className)

const chartFrame = <M>(h: HtmlBuilder<M>, title: string | null, children: ReadonlyArray<Html>): Html =>
	h.figure(
		[h.Class(panelClass("default", "my-3 block space-y-2 overflow-visible")), h.DataAttribute("slot", "panel")],
		[...(title === null ? [] : [h.figcaption([h.Class("text-2xs font-medium text-muted-foreground")], [title])]), ...children],
	)

const timeseriesRows = (spec: Extract<ChartSpec, { readonly data: ReadonlyArray<{ readonly bucket: string }> }>) =>
	spec.data.map((point): Readonly<Record<string, string | number>> => ({ bucket: point.bucket, ...point.series }))

const plot = <M>(h: HtmlBuilder<M>, host: ChartHost<M>, id: string, spec: ChartSpec): Html => {
	const unit = normalizeUnit(spec.unit)
	if (spec.type === "ranked")
		return h.submodel({
			slotId: `chat-chart:${id}`,
			model: host.charts[id] ?? ChartModel.init(),
			view: HbarChart.view,
			viewInputs: {
				data: spec.data.map((point) => ({ name: point.name, value: point.value })),
				unit,
				className: PLOT_HEIGHT,
			},
			toParentMessage: (message) => host.onChart(id, message),
		})
	if (!host.isRuntimeReady || host.theme === null)
		return chartSkeleton(h, spec.type === "bar" ? "bar" : spec.type, PLOT_HEIGHT)
	if (spec.type === "bar")
		return h.submodel({
			slotId: `chat-chart:${id}`,
			model: host.charts[id] ?? ChartModel.init(),
			view: BarChart.view,
			viewInputs: {
				chartId: id,
				data: timeseriesRows(spec),
				theme: host.theme,
				unit,
				timeZone: host.timeZone,
				nowMs: host.nowMs,
				className: PLOT_HEIGHT,
				legend: "hidden",
			},
			toParentMessage: (message) => host.onChart(id, message),
		})
	return h.submodel({
		slotId: `chat-chart:${id}`,
		model: host.charts[id] ?? ChartModel.init(),
		view: AreaChart.view,
		viewInputs: {
			chartId: id,
			data: timeseriesRows(spec),
			theme: host.theme,
			unit,
			timeZone: host.timeZone,
			nowMs: host.nowMs,
			className: PLOT_HEIGHT,
			legend: "hidden",
			curveType: "monotone",
			mark: spec.type === "line" ? "line" : "area",
		},
		toParentMessage: (message) => host.onChart(id, message),
	})
}

/** `MarkdownChart`: a ```chart fence as a plot; a payload that is not a chart stays visible as text. */
const chartView = <M>(h: HtmlBuilder<M>, host: ChartHost<M>, code: string): Html =>
	Option.match(Option.fromNullishOr(parseChartSpec(code)), {
		onNone: () =>
			h.pre(
				[h.Class(panelClass("muted", "my-3 block overflow-auto text-xs text-muted-foreground")), h.DataAttribute("slot", "panel")],
				[h.code([], [code])],
			),
		onSome: (spec) => chartFrame(h, spec.title ?? null, [plot(h, host, code, spec)]),
	})

export const chatMarkdownOverrides =
	<M>(h: HtmlBuilder<M>, knownServices: ReadonlySet<string>, charts: ChartHost<M>, code: CodeHost<M>): ViewOverrides =>
	(views) => ({
		Table: (node) => tableView(h, knownServices)(views)(node),
		// KaTeX draws into an unstyled span carrying the `.katex` / `.katex-display` classes.
		InlineCode: (node) =>
			node.value.startsWith(MATH_MARK)
				? h.keyed("span")(`math:${node.value}`, [h.OnMount(code.mathMount(node.value.slice(MATH_MARK.length), false))], [])
				: views.InlineCode(node),
		CodeBlock: (block) => {
			const language = Option.getOrElse(block.maybeLanguage, () => "")
			if (language === "math")
				return h.keyed("span")(`math-display:${block.value}`, [h.OnMount(code.mathMount(block.value, true))], [])
			if (language === "chart") return chartView(h, charts, block.value)
			if (language === "mermaid") return mermaidBlock(h, code, block.value.replace(/\n+$/, ""))
			return codeBlock(h, code, block.value, language)
		},
	})
