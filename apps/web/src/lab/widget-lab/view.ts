import type { Html, HtmlBuilder } from "foldkit/html"
import * as Chart from "../../charts/chart"
import * as Sparkline from "../../charts/sparkline"
import { resolveColor, ResolveThemeColors } from "../../charts/theme-colors"
import { isChartRuntimeReady } from "../../charts/chart-runtime"
import { validateCssColor } from "@maple/ui/lib/sanitizers"
import { dashboardPage } from "../../page/kit/dashboard-page"
import { errorDetailsPopover } from "../../page/dashboards/kit/error-details"
import { type TileContext, widgetTile } from "../../page/dashboards/kit/tiles"
import { sparklineValues } from "../../page/dashboards/kit/tiles-stat"
import { button } from "../../ui/button"
import * as CopyButton from "../../ui/copy-button"
import { eyebrow } from "../../ui/eyebrow"
import { icon } from "../../ui/icon"
import * as Menu from "../../ui/menu"
import * as MenuView from "../../ui/menu-view"
import * as Popover from "../../ui/popover"
import * as ToastView from "../../ui/toast-view"
import * as ToggleGroup from "../../ui/toggle-group"
import { labShellView } from "../app-shell"
import { type Cell, LATER_SECTIONS, type Section, SECTIONS, SPARKLINE_SAMPLES } from "./catalog"
import { Message, type Model } from "./model"
import { THEME_TOKENS } from "./tokens"
import { detailsIdOf, isEditMode, menuIdOf } from "./update"
import { copyScenarios } from "./view-copy"

type H = HtmlBuilder<Message>

const NAV_ITEMS: ReadonlyArray<readonly [string, string]> = [
	["copy", "Copy"],
	["stat", "Stat"],
	["gauge", "Gauge"],
	["sparkline", "Sparkline"],
	["chart", "Chart"],
	["stress", "Stress"],
	["table", "Table"],
	["list", "List"],
	["pie", "Pie"],
	["funnel", "Funnel"],
	["funnel-dropoff", "Drop-off"],
	["paths", "Paths"],
	["hbar", "Horizontal Bar"],
	["histogram", "Histogram"],
	["heatmap", "Heatmap"],
	["markdown", "Markdown"],
]

const section = (
	h: H,
	id: string,
	title: string,
	description: string,
	minColWidth: number,
	children: ReadonlyArray<Html>,
): Html =>
	h.section(
		[h.Id(id), h.Class("flex flex-col gap-3 scroll-mt-20")],
		[
			h.div(
				[h.Class("flex flex-col gap-0.5")],
				[
					h.h2([h.Class("text-lg font-semibold")], [title]),
					h.p([h.Class("text-xs text-muted-foreground")], [description]),
				],
			),
			h.div(
				[
					h.Class("grid gap-4"),
					h.Style({ "grid-template-columns": `repeat(auto-fill,minmax(${minColWidth}px,1fr))` }),
				],
				children,
			),
		],
	)

const scenarioCell = (h: H, label: string, height: number, child: Html): Html =>
	h.div(
		[h.Class("flex flex-col gap-1.5")],
		[
			eyebrow(h, { variant: "mono" }, [label]),
			h.div([h.Class("w-full"), h.Style({ height: `${height}px` })], [child]),
		],
	)

/** Edit mode: Edit, Clone and Delete (`labActions`), as the card menu resolves them. */
const tileMenu = (h: H, model: Model, slot: string): Html | null =>
	!isEditMode(model)
		? null
		: h.submodel({
				slotId: `lab-menu-${slot}`,
				model: model.menuId === slot ? model.menu : Menu.init(menuIdOf(slot)),
				view: MenuView.view,
				viewInputs: {
					entries: [
						{ _tag: "Item", value: "edit", label: "Edit", icon: "PencilIcon" },
						{ _tag: "Item", value: "clone", label: "Clone", icon: "CopyIcon" },
						{ _tag: "Separator" },
						{
							_tag: "Item",
							value: "delete",
							label: "Delete",
							icon: "TrashIcon",
							variant: "destructive",
						},
					],
					align: "end",
					className: "w-max",
					toView: ({ trigger, withTrigger }) =>
						h.div(
							[h.Class("contents")],
							withTrigger(
								button(
									h,
									{
										variant: "ghost",
										size: "icon-xs",
										attributes: [h.AriaLabel("Widget actions"), ...trigger],
									},
									[icon(h, "DotsVerticalIcon")],
								),
							),
						),
				},
				toParentMessage: (message) => Message.GotMenuMessage({ slot, message }),
			})

const tileContext = (h: H, model: Model, cell: Cell): TileContext<Message> => {
	const slot = cell.id
	const sparkSlot = `${slot}:spark`
	const isEdit = isEditMode(model)
	return {
		h,
		state: cell.state,
		isEdit,
		menu: tileMenu(h, model, slot),
		isMenuOpen: model.menuId === slot && model.menu.isOpen,
		hasGrip: true,
		configure: isEdit ? Message.ClickedWidgetAction({ action: "configure" }) : null,
		chart: model.charts[slot] ?? Chart.init(),
		themeColors: model.themeColors,
		chartRuntime: model.chartRuntime,
		nowMs: model.nowMs,
		timeZone: model.timeZone,
		tableSort: model.tableSorts[slot] ?? { key: null, dir: "desc" },
		onChart: (message) => Message.GotChartMessage({ slot, message }),
		onSort: (field, isText) => Message.ClickedSortColumn({ slot, field, isText }),
		sparkline: cell.sparkline,
		sparklineChart: model.charts[sparkSlot] ?? Chart.init(),
		onSparklineChart: (message) => Message.GotChartMessage({ slot: sparkSlot, message }),
		errorDetails: (message) =>
			errorDetailsPopover(h, {
				slotId: `details-${slot}`,
				popover: model.details[slot] ?? Popover.init(detailsIdOf(slot)),
				copy: model.copies[`${slot}:details`] ?? CopyButton.init(),
				message,
				onPopover: (inner) => Message.GotDetailsMessage({ slot, message: inner }),
				onCopy: (inner) => Message.GotCopyMessage({ slot: `${slot}:details`, message: inner }),
			}),
	}
}

const tileSection = (h: H, model: Model, entry: Section): Html =>
	section(
		h,
		entry.id,
		entry.title,
		entry.description,
		entry.minColWidth,
		entry.cells.map((cell) =>
			scenarioCell(h, cell.label, cell.height, widgetTile(h, tileContext(h, model, cell), cell.widget)),
		),
	)

/** `StatSparkline` alone in a card, per sample. */
const sparklineSection = (h: H, model: Model): Html =>
	section(
		h,
		"sparkline",
		"Sparkline",
		"The stat-widget trend line, rendered standalone across timeseries shapes. Polish: stroke, gradient, threshold color.",
		320,
		SPARKLINE_SAMPLES.map((sample) => {
			const values = sparklineValues(sample.state)
			const theme = model.themeColors
			const isReady = theme !== null && isChartRuntimeReady(model.chartRuntime)
			return scenarioCell(
				h,
				sample.label,
				320,
				h.div(
					[h.Class("flex h-full flex-col justify-end rounded-lg border bg-card p-3")],
					values.length < 2 || !isReady
						? []
						: [
								h.div(
									[h.Class("h-12 w-full")],
									[
										h.submodel({
											slotId: sample.id,
											model: model.charts[sample.id] ?? Chart.init(),
											view: Sparkline.view,
											toParentMessage: (message) =>
												Message.GotChartMessage({ slot: sample.id, message }),
											viewInputs: {
												chartId: sample.id,
												values,
												color: resolveColor(
													theme,
													validateCssColor(sample.color ?? "var(--chart-1)") ??
														"var(--chart-1)",
												),
												className: "h-full w-full",
												revision: values.length,
												curve: "monotone",
												fillOpacity: [0.35, 0],
											},
										}),
									],
								),
							],
				),
			)
		}),
	)

const modeToggle = (h: H, model: Model): Html =>
	ToggleGroup.view(h, {
		model: model.mode,
		toParentMessage: (message) => Message.GotModeMessage({ message }),
		items: [
			{ value: "view", label: "View" },
			{ value: "edit", label: "Edit" },
		],
		variant: "outline",
		size: "sm",
	})

const pageContent = (h: H, model: Model): Html =>
	dashboardPage(h, {}, [
		h.div(
			[h.Class("flex flex-col gap-8 pb-12"), h.OnMount(ResolveThemeColors({ tokens: THEME_TOKENS }))],
			// Painted in one go once the theme, the chart runtime and the clock are in (S3).
			model.themeColors === null || !isChartRuntimeReady(model.chartRuntime) || model.nowMs === null
				? []
				: [
						h.nav(
							[
								h.Class(
									"sticky top-0 z-10 -mx-4 flex items-center gap-3 border-b bg-background/80 px-4 py-2 backdrop-blur",
								),
							],
							// One row: the anchors scroll sideways when tight, so the View/Edit toggle never wraps below them.
							[
								h.div(
									[
										h.Class(
											"flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none]",
										),
									],
									NAV_ITEMS.map(([id, label]) =>
										h.a(
											[
												h.Href(`#${id}`),
												h.Class(
													"shrink-0 whitespace-nowrap rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted active:bg-muted hover:text-foreground active:text-foreground",
												),
											],
											[label],
										),
									),
								),
								h.div([h.Class("shrink-0")], [modeToggle(h, model)]),
							],
						),
						section(
							h,
							"copy",
							"Copy",
							"The shared CopyButton. Polish: the check draws rather than pops, the label crossfade never changes the button width, and the error branch reads as a failure.",
							240,
							copyScenarios(h, model),
						),
						...SECTIONS.map((entry) => tileSection(h, model, entry)),
						sparklineSection(h, model),
						...LATER_SECTIONS.map((entry) => tileSection(h, model, entry)),
					],
		),
	])

/** The real shell around the lab, then the toast regions. */
export const view = (model: Model, h: H): Html =>
	h.div(
		[h.Id("app")],
		[
			...labShellView(h, model.shell, (message) => Message.GotShellMessage({ message }), {
				currentPath: "/lab/widgets",
				breadcrumbs: [{ label: "Widget Lab" }],
				page: () => pageContent(h, model),
			}),
			...ToastView.regions(h, model.toasts, (message) => Message.GotToastMessage({ message })),
		],
	)
