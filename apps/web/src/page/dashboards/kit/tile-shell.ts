import { TONE_TEXT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { cardActionStyles } from "@maple/ui/styles/ui/card"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../ui/button"
import { card, cardHeader, cardPanel } from "../../../ui/card"
import { emptyMessage } from "../../../ui/empty"
import { eyebrow } from "../../../ui/eyebrow"
import { icon } from "../../../ui/icon"
import { isEmptyError, type WidgetDataState } from "./data-state"
import { NARROW_RANGE_LABEL } from "./widget-data"

/** `useId` of the grid's hidden rearranging instructions, which every grip describes itself by. */
export const GRID_INSTRUCTIONS_ID = "dashboard-grid-instructions"

// `WidgetShell`, `WidgetFrame` and `WidgetEmptyState`: a tile's card, header and empty state.

export type ShellOptions = Readonly<{
	widgetId: string
	/** The drag grip (edit mode); the grid watches presses on it (`DashboardGrid`'s pointerdown). */
	hasGrip: boolean
	title: string
	isEdit: boolean
	/** The actions menu (trigger and portal), or `null` when the tile offers none. */
	menu: Html | null
	/** The menu is open: the action stays visible though the pointer left the card. */
	isMenuOpen: boolean
	contentClassName: string | undefined
	footer?: string | undefined
	/** The series a chart with a hidden legend hoists into the header (`usePlotLegendSlot`). */
	legendItems?: ReadonlyArray<LegendItem> | undefined
	/** `widgetTimeRangeLabel`: the tile follows its own window, not the board's. */
	timeRangeLabel?: string | undefined
}>

export type LegendItem = Readonly<{ key: string; label: string; color: string; dashed?: boolean }>

const MAX_HEADER_ITEMS = 5

/** The header legend: a few chips, then "+N" with the full list on hover. */
const headerLegend = <M>(h: HtmlBuilder<M>, items: ReadonlyArray<LegendItem>): Html => {
	const visible = items.slice(0, MAX_HEADER_ITEMS)
	const overflow = items.length - visible.length
	return h.div(
		[
			h.Class(
				"ml-auto hidden min-w-0 flex-1 items-center justify-end gap-x-3 overflow-hidden @min-[380px]/widget:flex",
			),
		],
		[
			...visible.map((item) =>
				h.span(
					[h.Class("flex min-w-0 shrink items-center gap-1.5 text-3xs text-muted-foreground")],
					[
						h.span([
							h.Class(
								cn(
									"size-2 shrink-0 rounded-xs",
									item.dashed === true && "border border-dashed",
								),
							),
							h.Style(
								item.dashed === true
									? { "border-color": item.color }
									: { "background-color": item.color },
							),
						]),
						h.span([h.Class("truncate")], [item.label]),
					],
				),
			),
			...(overflow > 0
				? [
						h.span(
							[
								h.Class("shrink-0 text-3xs text-muted-foreground"),
								h.Title(items.map((i) => i.label).join(", ")),
							],
							[`+${overflow}`],
						),
					]
				: []),
		],
	)
}

const timeRangeChip = <M>(h: HtmlBuilder<M>, label: string): Html =>
	h.span(
		[
			h.Class(
				"flex shrink-0 items-center gap-1 rounded-sm bg-muted px-1.5 py-0.5 text-3xs font-medium text-muted-foreground",
			),
			h.Title(`This widget uses its own time range (${label}) instead of the dashboard's`),
		],
		[icon(h, "ClockIcon", { size: 10 }), label],
	)

/** The grip a tile is dragged by (edit mode); the press starts the grid gesture. */
const grip = <M>(h: HtmlBuilder<M>, title: string): Html =>
	h.button(
		[
			h.Type("button"),
			h.AriaLabel(`Move ${title}`),
			h.DataAttribute("grid-label", title),
			h.Class(
				"widget-drag-handle cursor-grab touch-none rounded-sm text-muted-foreground outline-none group-[.is-layout-locked]/canvas:hidden hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing",
			),
			h.AriaDescribedBy(GRID_INSTRUCTIONS_ID),
		],
		[icon(h, "GripDotsIcon", { size: 14 })],
	)

export const widgetShell = <M>(
	h: HtmlBuilder<M>,
	options: ShellOptions,
	children: ReadonlyArray<Html>,
): Html =>
	card(
		h,
		[
			cardHeader(
				h,
				[
					h.div(
						[h.Class("flex min-w-0 items-center gap-2")],
						[
							...(options.isEdit && options.hasGrip ? [grip(h, options.title)] : []),
							eyebrow(
								h,
								{
									variant: "label",
									as: "div",
									className: "min-w-0 truncate",
									attributes: [h.Title(options.title)],
								},
								[options.title],
							),
							...(options.timeRangeLabel === undefined
								? []
								: [timeRangeChip(h, options.timeRangeLabel)]),
							...(options.legendItems !== undefined && options.legendItems.length >= 2
								? [headerLegend(h, options.legendItems)]
								: []),
						],
					),
					...(options.menu === null
						? []
						: [
								h.div(
									[
										h.Class(
											cn(
												cardActionStyles,
												!options.isEdit &&
													"opacity-0 transition-opacity focus-within:opacity-100 group-hover/card:opacity-100 pointer-coarse:opacity-100",
												!options.isEdit && options.isMenuOpen && "opacity-100",
											),
										),
										h.DataAttribute("slot", "card-action"),
									],
									[options.menu],
								),
							]),
				],
				"py-2.5",
			),
			cardPanel(h, children, cn("overflow-hidden", options.contentClassName ?? "flex-1 min-h-0 p-2")),
			...(options.footer === undefined
				? []
				: [
						h.div(
							[h.Class("shrink-0 px-3 pb-2.5 text-2xs text-muted-foreground")],
							[options.footer],
						),
					]),
		],
		"group/card @container/widget h-full flex flex-col",
	)

/** `WidgetEmptyState`: the query ran and returned nothing. */
export const widgetEmptyState = <M>(h: HtmlBuilder<M>): Html =>
	emptyMessage(h, { className: "flex h-full flex-col items-center justify-center gap-1.5 px-3 py-0" }, [
		h.span([h.Class("font-medium")], ["No data in the selected time range"]),
		h.span(
			[h.Class("text-3xs text-muted-foreground/70 max-w-full line-clamp-3")],
			["Widen the time range or check the query's filters."],
		),
	])

const mutedError = <M>(
	h: HtmlBuilder<M>,
	state: Extract<WidgetDataState, { _tag: "Error" }>,
	configure: M | null,
	narrowRange: M | null,
): Html =>
	h.div(
		[h.Class("flex items-center justify-center h-full flex-col gap-1.5 px-3")],
		[
			h.span(
				[h.Class("text-xs font-medium text-muted-foreground")],
				[state.title ?? (state.kind === "range" ? "Range too wide" : "Not configured")],
			),
			...(state.message === null
				? []
				: [
						h.span(
							[
								h.Class(
									"text-3xs text-muted-foreground/70 max-w-full text-center line-clamp-3",
								),
							],
							[state.message],
						),
					]),
			...(state.kind === "range" && narrowRange !== null
				? [
						button(
							h,
							{
								variant: "outline",
								size: "xs",
								className: "mt-1 h-6 gap-1 text-3xs",
								attributes: [h.OnClick(narrowRange)],
							},
							[icon(h, "ClockIcon"), NARROW_RANGE_LABEL],
						),
					]
				: []),
			...(state.kind === "config" && configure !== null
				? [
						button(
							h,
							{
								variant: "outline",
								size: "xs",
								className: "mt-1 h-6 gap-1 text-3xs",
								attributes: [h.OnClick(configure)],
							},
							[icon(h, "PencilIcon"), "Edit"],
						),
					]
				: []),
		],
	)

/** The red block and its "Details" popover. */
const failedState = <M>(
	h: HtmlBuilder<M>,
	state: Extract<WidgetDataState, { _tag: "Error" }>,
	options: Pick<FrameOptions<M>, "errorDetails">,
): Html =>
	h.div(
		[h.Class("flex items-center justify-center h-full flex-col gap-1.5 px-3")],
		[
			h.span([h.Class(cn("text-xs font-medium", TONE_TEXT.crit))], [state.title ?? "Unable to load"]),
			...(state.message === null
				? []
				: [
						h.span(
							[
								h.Class(
									cn(
										"text-3xs opacity-70 max-w-full text-center line-clamp-2 break-words",
										TONE_TEXT.crit,
									),
								),
								h.Title(state.message),
							],
							[state.message],
						),
					]),
			...(state.message === null ||
			state.message === "" ||
			options.errorDetails === undefined ||
			options.errorDetails === null
				? []
				: [options.errorDetails(state.message)]),
		],
	)

export type FrameOptions<M> = ShellOptions &
	Readonly<{
		state: WidgetDataState
		loadingSkeleton: Html
		configure: M | null
		narrowRange?: M | null | undefined
		errorDetails?: ((message: string) => Html) | null | undefined
	}>

/** `WidgetFrame`: loading, the three error shapes, or the tile's own content. */
export const widgetFrame = <M>(
	h: HtmlBuilder<M>,
	options: FrameOptions<M>,
	content: () => ReadonlyArray<Html>,
): Html => {
	const state = options.state
	const body: ReadonlyArray<Html> =
		state._tag === "Loading"
			? [options.loadingSkeleton]
			: state._tag === "Error"
				? isEmptyError(state)
					? [widgetEmptyState(h)]
					: state.kind === "range" || state.kind === "config"
						? [mutedError(h, state, options.configure, options.narrowRange ?? null)]
						: [failedState(h, state, options)]
				: content()
	return widgetShell(h, { ...options, footer: state._tag === "Ready" ? options.footer : undefined }, body)
}
