import { cn } from "@maple/ui/lib/utils"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { WIDGET_CHART_TOKENS } from "../kit/chart-tokens"
import { ResolveThemeColors } from "../../../charts/theme-colors"
import { button, linkButton } from "../../../ui/button"
import { chartSkeleton } from "../../../ui/chart-skeleton"
import { empty, emptyDescription, emptyHeader, emptyMedia, emptyTitle } from "../../../ui/empty"
import { icon } from "../../../ui/icon"
import { inlineCode } from "../../../ui/inline-code"
import { skeleton } from "../../../ui/skeleton"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import { presetLabel } from "../../kit/time-controls"
import * as TimeRangePicker from "../../kit/time-range-picker"
import { dataStateOf } from "../kit/data-state"
import { widgetTile } from "../kit/tiles"
import { MeasurePreview } from "./command"
import { Message } from "./message"
import type { Model } from "./model"
import { previewWidgetOf } from "./update"
import type { Widget } from "./lowering"
import { leaveDialog } from "./view-dialog"
import { queryEditor } from "./view-query"
import { settingsRail } from "./view-rail"

// `WidgetConfigurePage` and `WidgetQueryBuilderPage`: the preview over the query editor, the
// settings rail beside them.

type H = HtmlBuilder<Message>

/** `WidgetEditorSkeleton`. */
const editorSkeleton = (h: H): Html =>
	h.div(
		[h.Role("status"), h.AriaLabel("Loading widget")],
		[
			h.span([h.Class("sr-only")], ["Loading widget"]),
			h.div(
				[h.Class("flex flex-col gap-6"), h.AriaHidden(true)],
				[
					h.div(
						[
							h.Class(
								"h-64 w-full overflow-hidden rounded-md ring-1 ring-border bg-card p-2 animate-tile-in motion-reduce:animate-none",
							),
							h.Style({ "animation-delay": "0ms" }),
						],
						[chartSkeleton(h, "line")],
					),
					h.div(
						[h.Class("flex max-w-md flex-col gap-4")],
						[1, 2, 3, 4].map((index) =>
							h.div(
								[
									h.Class(
										"flex flex-col gap-1.5 animate-tile-in motion-reduce:animate-none",
									),
									h.Style({ "animation-delay": `${index * 40}ms` }),
								],
								[skeleton(h, "h-3 w-20"), skeleton(h, "h-9 w-full")],
							),
						),
					),
				],
			),
		],
	)

/** `ResourceNotFound`: no such widget on this board. */
const notFound = (h: H, widgetId: string, dashboardHref: string): Html =>
	empty(
		h,
		[
			emptyHeader(h, [
				emptyMedia(h, { variant: "icon" }, [icon(h, "CircleWarningIcon", { size: 18 })]),
				emptyTitle(h, ["Widget not found"]),
				emptyDescription(h, [
					"No widget with id ",
					inlineCode(h, { className: "break-all px-1.5 py-0.5" }, [widgetId]),
				]),
			]),
			linkButton(h, { variant: "outline", size: "sm", href: dashboardHref }, ["Back to dashboard"]),
		],
		cn("md:py-12", "py-24"),
	)

const timeLabel = (model: Model): string =>
	model.timeRange === null
		? ""
		: model.timeRange.type === "relative"
			? presetLabel(model.timeRange.value)
			: `${model.timeRange.startTime} - ${model.timeRange.endTime}`

/** The preview hero: the board's range picker over the widget as it would render. */
/** The previewed stat's sparkline series, read like any tile's data (its own data source). */
const sparklineState = (model: Model, widget: Widget) => {
	const source = widget.display.sparkline?.dataSource
	return model.sparkGate === null || source === undefined
		? null
		: dataStateOf(model.requests, { ...widget, dataSource: source }, model.sparkGate)
}

const preview = (h: H, model: Model, timeZone: string): Html => {
	const widget = previewWidgetOf(model)
	return h.div(
		[h.Class("border-b bg-muted/30 p-6")],
		[
			h.div(
				[h.Class("flex justify-end mb-3")],
				[
					h.submodel({
						slotId: "widget-editor-time-picker",
						model: model.timePicker,
						view: TimeRangePicker.view,
						viewInputs: {
							label: timeLabel(model),
							selectedPreset:
								model.timeRange?.type === "relative" ? model.timeRange.value : undefined,
							presets: TimeRangePicker.PRESET_VALUES,
							timeZone,
							hasHotkey: false,
						},
						toParentMessage: (message) => Message.GotTimePickerMessage({ message }),
					}),
				],
			),
			h.div(
				[h.Class("h-[420px]"), h.OnMount(MeasurePreview())],
				widget === null
					? []
					: [
							widgetTile(
								h,
								{
									h,
									state: dataStateOf(model.requests, widget, model.gate),
									isEdit: false,
									menu: null,
									isMenuOpen: false,
									hasGrip: false,
									configure: null,
									chart: model.chart,
									themeColors: model.themeColors,
									chartRuntime: model.chartRuntime,
									nowMs: model.nowMs,
									timeZone,
									tableSort: model.tableSort,
									onChart: (message) => Message.GotChartMessage({ message }),
									onSort: (field, isText) => Message.ClickedSortColumn({ field, isText }),
									sparkline: sparklineState(model, widget),
									sparklineChart: model.sparklineChart,
									onSparklineChart: (message) =>
										Message.GotSparklineChartMessage({ message }),
								},
								widget,
							),
						],
			),
		],
	)
}

const editor = (h: H, model: Model, timeZone: string): Html =>
	h.div(
		[h.Class("animate-in fade-in slide-in-from-bottom-2 duration-200 flex flex-1 min-h-0 -m-4")],
		[
			h.div(
				[h.Class("flex-1 min-w-0 overflow-y-auto")],
				[preview(h, model, timeZone), queryEditor(h, model, timeZone)],
			),
			h.aside(
				[h.Class("w-[272px] shrink-0 border-l overflow-y-auto p-5 bg-muted/20")],
				[settingsRail(h, model, timeZone)],
			),
		],
	)

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) =>
	h.div(
		[h.Class("contents"), h.OnMount(ResolveThemeColors({ tokens: WIDGET_CHART_TOKENS }))],
		[
			dashboardPage(h, {}, [
				model.status === "Ready" && model.state !== null
					? editor(h, model, inputs.context.timeZone)
					: model.status === "Missing"
						? notFound(h, model.widgetId, `/dashboards/${model.dashboardId}`)
						: editorSkeleton(h),
			]),
			leaveDialog(h, model),
		],
	),
)

/** `topbarActions`: Cancel and Apply, once the widget is open. */
export const topbarActions = Submodel.defineView<Model, Message, PageViewInputs>((model, _inputs, h) =>
	model.status !== "Ready" || model.state === null
		? null
		: h.div(
				[h.Class("flex items-center gap-2")],
				[
					button(
						h,
						{
							variant: "outline",
							size: "sm",
							isDisabled: model.isSaving,
							attributes: [h.OnClick(Message.ClickedCancel())],
						},
						["Cancel"],
					),
					button(
						h,
						{
							size: "sm",
							isLoading: model.isSaving,
							attributes: [h.OnClick(Message.ClickedApply())],
						},
						["Apply"],
					),
				],
			),
)
