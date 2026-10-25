import { cn } from "@maple/ui/lib/utils"
import * as DialogStyles from "@maple/ui/styles/ui/dialog"
import {
	LIST_PRESET_SAMPLE_ROWS,
	STAT_PRESET_SAMPLE_VALUES,
	TABLE_PRESET_SAMPLE_ROWS,
} from "@maple/web-data/dashboards/widget-preset-samples"
import type { WidgetPresetDefinition } from "@maple/web-data/dashboards/widget-presets"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Chart from "../../../charts/chart"
import { isChartRuntimeReady } from "../../../charts/chart-runtime"
import { chartSkeleton } from "../../../ui/chart-skeleton"
import { descriptionId, titleId } from "../../../ui/dialog"
import * as DialogView from "../../../ui/dialog-view"
import { dialogHeader } from "../../../ui/dialog-view"
import { eyebrow } from "../../../ui/eyebrow"
import { table, tableBody, tableCell, tableHead, tableHeader, tableRow } from "../../../ui/table"
import * as TabsView from "../../../ui/tabs-view"
import { formatCell, formatStatValue } from "../kit/tiles"
import { registryChartView } from "../kit/tiles-chart"
import { sampleDataOf } from "../kit/chart-registry"
import { Message } from "./message"
import type { Model } from "./model"
import { CHART_STYLES, PICKER_SECTIONS, PICKER_TABS, type PickerSection } from "./picker-catalog"

// The widget picker and the presets' thumbnails.

type H = HtmlBuilder<Message>

/** `PickerCard`: the thumbnail over its title and description. */
const pickerCard = (h: H, title: string, description: string, onClick: Message, preview: Html): Html =>
	h.button(
		[
			h.Type("button"),
			h.OnClick(onClick),
			h.Class(
				"group ring-1 ring-border hover:ring-border-active bg-background p-4 text-left transition-all flex flex-col gap-3 rounded-md",
			),
		],
		[
			preview,
			h.div(
				[h.Class("flex flex-col gap-0.5")],
				[
					h.div([h.Class("text-xs font-medium")], [title]),
					...(description === "" ? [] : [h.div([h.Class("text-2xs text-dim")], [description])]),
				],
			),
		],
	)

/** `PickerSection`: a heading on the All tab, then a three-column grid of cards. */
const pickerSection = (h: H, title: string, showHeading: boolean, cards: ReadonlyArray<Html>): Html =>
	h.div(
		[h.Class("flex flex-col gap-3")],
		[
			...(showHeading ? [eyebrow(h, { as: "h3", className: "text-dim" }, [title])] : []),
			h.div([h.Class("grid grid-cols-3 gap-3")], cards),
		],
	)

/** `PreviewFrame`: the preset's title over its thumbnail, in a 4:3 box. */
const previewFrame = (
	h: H,
	title: string | undefined,
	className: string,
	children: ReadonlyArray<Html>,
): Html =>
	h.div(
		[h.Class(`aspect-[4/3] ${className}`)],
		[h.div([h.Class("text-3xs text-muted-foreground")], title === undefined ? [] : [title]), ...children],
	)

/** `ChartPreview`: the chart over its registry sample rows. */
const chartPreview = (h: H, model: Model, chartId: string, key: string): Html => {
	const slot = `picker:${key}`
	const content =
		model.themeColors === null || !isChartRuntimeReady(model.chartRuntime) || model.nowMs === null
			? chartSkeleton(h, "area")
			: registryChartView(h, {
					slot: `picker-${key}`,
					chart: model.charts[slot] ?? Chart.init(),
					onChart: (message) => Message.GotChartMessage({ widgetId: slot, message }),
					theme: model.themeColors,
					chartRuntime: model.chartRuntime,
					nowMs: model.nowMs,
					timeZone: "UTC",
					chartId,
					data: sampleDataOf(chartId),
					className: "h-full w-full aspect-auto",
				})
	return h.div([h.Class("aspect-[4/3] w-full overflow-hidden")], [content])
}

/** `rowsPresetPreview`: a miniature table of the preset's columns over sample rows. */
const rowsPreview = (
	h: H,
	preset: WidgetPresetDefinition,
	rows: ReadonlyArray<Readonly<Record<string, unknown>>>,
) => {
	const columns = preset.display.columns ?? []
	const align = (value: string | undefined) => ({ "text-align": value ?? "left" })
	return previewFrame(h, preset.display.title, "flex flex-col overflow-hidden", [
		table(h, { size: "xs", variant: "bare", scroll: false }, [
			tableHeader(h, [
				tableRow(
					h,
					columns.map((column) =>
						tableHead(h, [column.header], "px-1 py-0.5 text-4xs", [h.Style(align(column.align))]),
					),
					"border-b border-border",
				),
			]),
			tableBody(
				h,
				rows.map((row) =>
					tableRow(
						h,
						columns.map((column) =>
							tableCell(
								h,
								[formatCell(row[column.field], column.unit)],
								"max-w-[80px] truncate px-1 py-0.5 text-4xs",
								[h.Style(align(column.align))],
							),
						),
					),
				),
			),
		]),
	])
}

/** `MarkdownPresetPreview`: the note's first lines, markdown syntax stripped. */
const markdownPreview = (h: H, preset: WidgetPresetDefinition): Html => {
	const lines = (preset.display.markdown?.content ?? "")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.slice(0, 4)
	return previewFrame(
		h,
		preset.display.title,
		"flex flex-col gap-1 overflow-hidden p-1",
		lines.map((line) =>
			h.div(
				[
					h.Class(
						`truncate text-4xs ${line.startsWith("#") ? "font-semibold" : "text-muted-foreground"}`,
					),
				],
				[line.replace(/^#+\s*/, "").replace(/[*`]/g, "")],
			),
		),
	)
}

const presetPreview = (h: H, model: Model, entry: PickerSection, preset: WidgetPresetDefinition): Html => {
	switch (entry.preview) {
		case "stat":
			return previewFrame(
				h,
				preset.display.title,
				"flex flex-col items-center justify-center gap-1.5",
				[
					h.div(
						[h.Class("text-lg font-semibold tabular-nums")],
						[
							formatStatValue(
								STAT_PRESET_SAMPLE_VALUES[preset.id] ?? 0,
								preset.display.unit,
								preset.display.prefix,
								preset.display.suffix,
							),
						],
					),
				],
			)
		case "rows":
			return rowsPreview(
				h,
				preset,
				(entry.id === "table" ? TABLE_PRESET_SAMPLE_ROWS : LIST_PRESET_SAMPLE_ROWS)[preset.id] ?? [],
			)
		case "markdown":
			return markdownPreview(h, preset)
		case "chart":
			return previewFrame(h, preset.display.title, "flex flex-col gap-1.5", [
				chartPreview(h, model, preset.display.chartId ?? entry.defaultChartId, preset.id),
			])
	}
}

const sections = (h: H, model: Model): ReadonlyArray<Html> => {
	const active = model.pickerTabs.selected
	const isVisible = (id: string) => active === "all" || active === id
	const showHeading = active === "all"
	return [
		...(isVisible("charts")
			? [
					pickerSection(
						h,
						"Charts",
						showHeading,
						CHART_STYLES.map((style) =>
							pickerCard(
								h,
								style.label,
								style.description,
								Message.ClickedChartStyle({ chartId: style.chartId }),
								chartPreview(h, model, style.chartId, style.chartId),
							),
						),
					),
				]
			: []),
		...PICKER_SECTIONS.filter((entry) => isVisible(entry.id)).map((entry) =>
			pickerSection(
				h,
				entry.label,
				showHeading,
				entry.presets.map((preset) =>
					pickerCard(
						h,
						preset.name,
						preset.description,
						Message.ClickedWidgetPreset({ presetId: preset.id }),
						presetPreview(h, model, entry, preset),
					),
				),
			),
		),
	]
}

/** `WidgetPicker`: "Add widget", its section tabs, and the cards. */
export const widgetPicker = (h: H, model: Model): Html => {
	const id = model.pickerDialog.id
	return h.submodel({
		slotId: id,
		model: model.pickerDialog,
		view: DialogView.view,
		viewInputs: {
			hasTrigger: false,
			className: "sm:max-w-3xl",
			toView: ({ portal }) => portal ?? h.empty,
			toContent: () => [
				dialogHeader(h, "dialog", [
					h.h2(
						[
							h.Class(cn(DialogStyles.dialogTitleStyles)),
							h.DataAttribute("slot", "dialog-title"),
							h.Id(titleId(id)),
						],
						["Add widget"],
					),
					h.p(
						[
							h.Class(cn(DialogStyles.dialogDescriptionStyles)),
							h.DataAttribute("slot", "dialog-description"),
							h.Id(descriptionId(id)),
						],
						["Choose a visualization type to add to your dashboard."],
					),
				]),
				h.submodel({
					slotId: "widget-picker-tabs",
					model: model.pickerTabs,
					view: TabsView.view,
					viewInputs: {
						variant: "underline",
						labels: PICKER_TABS.map((tab) => tab.label),
						className: "gap-0 border-b border-border",
						listClassName: "gap-x-0 py-0",
						tabClassName: "h-auto grow-0 px-4 py-2.5 text-xs sm:h-auto sm:text-xs",
						panel: () => undefined,
					},
					toParentMessage: (message) => Message.GotPickerTabsMessage({ message }),
				}),
				h.div(
					[h.Class("flex flex-col gap-5 max-h-[60vh] overflow-y-auto py-5 px-4")],
					sections(h, model),
				),
			],
		},
		toParentMessage: (message) => Message.GotPickerDialogMessage({ message }),
	})
}
