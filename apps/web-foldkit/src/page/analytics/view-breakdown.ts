import { formatNumber, formatPercent } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { rowSelectedClass } from "@maple/ui/styles/ui/list-row"
import { toggleVariants } from "@maple/ui/styles/ui/toggle"
import {
	toggleGroupConnectedStyles,
	toggleGroupHorizontalStyles,
	toggleGroupStyles,
} from "@maple/ui/styles/ui/toggle-group"
import type { Html, HtmlBuilder } from "foldkit/html"
import { emptyMessage } from "../../ui/empty"
import { icon } from "../../ui/icon"
import { panel } from "../../ui/panel"
import { searchInput } from "../../ui/search-input"
import { togglePrimitive } from "../../ui/toggle"
import { columnHead, dataTable, dataTableEmpty } from "../infra/kit/data-table"
import { sortRowsByField } from "../kit/table-sort"
import { type FilterKey, Message } from "./message"
import type { Model, PanelState } from "./model"
import { panelOf } from "./update"
import { analyticsRowIcon, dimensionHasIcons } from "./view-icons"

// `AnalyticsBreakdownPanel`: one breakdown card.

type H = HtmlBuilder<Message>
type SortKey = "name" | "count" | "views"

export type BreakdownRow = Readonly<{ name: string; count: number; views?: number; secondary?: string }>

export type BreakdownDimension = Readonly<{
	tab: string
	rows: ReadonlyArray<BreakdownRow>
	filterKey: FilterKey
	noun: string
	nounPlural: string
	emptyMessage?: (h: H) => ReadonlyArray<Html | string>
	formatValue?: (name: string) => string
	renderIcon?: (h: H, row: BreakdownRow) => Html
	viewsLabel?: string
	countLabel?: string
}>

export type BreakdownCard = Readonly<{ id: string; dimensions: ReadonlyArray<BreakdownDimension> }>

type ShareRow = BreakdownRow & Readonly<{ share: number }>

/** `shareBar` (infra/primitives/share-bar.ts): the row's background filled to its share. */
const shareBarStyle = (share: number): Readonly<Record<string, string>> => {
	const pct = Math.min(100, share * 100)
	if (!Number.isFinite(pct) || pct < 0.5) return {}
	const fill = "color-mix(in oklab, var(--primary) 14%, transparent)"
	return { "background-image": `linear-gradient(to right, ${fill} 0%, ${fill} ${pct}%, transparent ${pct}%)` }
}

const columnLabel = (noun: string): string => noun.charAt(0).toUpperCase() + noun.slice(1)

/** The panel's resolved view: tab, rows filtered and shared, the sort in effect. */
export const panelView = (state: PanelState, dimensions: ReadonlyArray<BreakdownDimension>) => {
	const firstPopulated = Math.max(
		dimensions.findIndex((dimension) => dimension.rows.length > 0),
		0,
	)
	const activeTab = state.pickedTab ?? firstPopulated
	const dimension = dimensions[activeTab] ?? dimensions[0]
	if (dimension === undefined) return null
	const label = dimension.formatValue ?? ((name: string) => name)
	const hasViews = dimension.rows.some((row) => row.views !== undefined)
	const total = dimension.rows.reduce((sum, row) => sum + (hasViews ? (row.views ?? 0) : row.count), 0)
	const needle = state.query.trim().toLowerCase()
	const rows: ReadonlyArray<ShareRow> = dimension.rows
		.filter((row) =>
			needle
				? label(row.name).toLowerCase().includes(needle) || (row.secondary?.toLowerCase().includes(needle) ?? false)
				: true,
		)
		.map((row) => ({ ...row, share: total > 0 ? (hasViews ? (row.views ?? 0) : row.count) / total : 0 }))
	const sort = { key: state.sortKey ?? (hasViews ? "views" : "count"), dir: state.sortDir } as const
	return { activeTab, dimension, label, hasViews, sort, rows: sortRowsByField(rows, sort) }
}

type PanelView = NonNullable<ReturnType<typeof panelView>>

/** `DimensionTabs`. */
export const dimensionTabs = (h: H, cardId: string, dimensions: ReadonlyArray<BreakdownDimension>, activeTab: number): Html =>
	h.div(
		[
			h.Role("group"),
			h.AriaLabel("Breakdown dimension"),
			h.Class(cn(toggleGroupStyles, toggleGroupHorizontalStyles, toggleGroupConnectedStyles, "flex-wrap gap-1")),
			h.DataAttribute("orientation", "horizontal"),
			h.DataAttribute("size", "sm"),
			h.DataAttribute("slot", "toggle-group"),
			h.DataAttribute("variant", "default"),
		],
		dimensions.map((dimension, index) =>
			togglePrimitive(
				h,
				{
					isPressed: index === activeTab,
					onClick: Message.PickedPanelTab({ panel: cardId, index }),
					className: cn(
						toggleVariants({ size: "sm", variant: "default" }),
						"h-auto min-w-0 rounded-sm px-2 py-0.5 text-2xs font-normal text-muted-foreground hover:bg-transparent hover:text-foreground data-pressed:bg-muted data-pressed:font-medium data-pressed:text-foreground sm:h-auto sm:min-w-0 sm:text-2xs",
					),
					slot: "toggle",
					tabIndex: index === activeTab ? 0 : -1,
					attributes: [h.AriaDisabled(false), h.DataAttribute("size", "sm"), h.DataAttribute("variant", "default")],
				},
				[dimension.tab],
			),
		),
	)

/** `FilterInput`. */
export const panelFilterInput = (
	h: H,
	cardId: string,
	value: string,
	nounPlural: string,
	className: string,
	idSuffix = "",
	isAutoFocus = false,
): Html =>
	searchInput(h, {
		id: `analytics-${cardId}-filter${idSuffix}`,
		size: "sm",
		value,
		placeholder: `Filter ${nounPlural}`,
		onInput: (next) => Message.ChangedPanelQuery({ panel: cardId, value: next }),
		onClear: Message.ChangedPanelQuery({ panel: cardId, value: "" }),
		className,
		attributes: [h.AriaLabel(`Filter ${nounPlural}`), ...(isAutoFocus ? [h.Autofocus(true)] : [])],
	})

const sortHead = (cardId: string, view: PanelView, key: SortKey) => ({
	isActive: view.sort.key === key,
	dir: view.sort.dir,
	onSort: Message.ClickedPanelSort({ panel: cardId, key, current: view.sort }),
})

/** `BreakdownTable`: the card's capped table, or the dialog's ranked one. */
export const breakdownTable = (
	h: H,
	model: Model,
	cardId: string,
	view: PanelView,
	options: Readonly<{ maxHeight: string; surfaceClass: string; isRanked: boolean; selected: string | undefined; isWaiting: boolean }>,
): Html => {
	const { dimension, hasViews, label } = view
	const isRanked = options.isRanked
	const showShare = isRanked || !hasViews
	const hasIcons = dimension.renderIcon !== undefined || dimensionHasIcons(dimension.filterKey)
	const onSelect = (name: string) =>
		isRanked
			? Message.ClickedExpandedRow({ key: dimension.filterKey, value: name })
			: Message.ToggledFilter({ key: dimension.filterKey, value: name })
	const head = [
		...(isRanked ? [columnHead(h, { label: "#", width: "w-6", align: "right", hidden: "max-sm:hidden" })] : []),
		columnHead(h, { label: columnLabel(dimension.noun), width: "w-0 flex-1 min-w-0", sort: sortHead(cardId, view, "name") }),
		...(hasViews
			? [
					columnHead(h, {
						label: dimension.viewsLabel ?? "Views",
						width: isRanked ? "w-16 sm:w-24" : "w-16",
						align: "right",
						sort: sortHead(cardId, view, "views"),
					}),
				]
			: []),
		columnHead(h, {
			label: dimension.countLabel ?? "Sessions",
			width: isRanked ? "w-16 sm:w-24" : hasViews ? "w-20" : "w-24",
			align: "right",
			sort: sortHead(cardId, view, "count"),
			hidden: !isRanked && hasViews ? "hidden @min-[380px]/panel:flex" : undefined,
		}),
		...(showShare
			? [
					columnHead(h, {
						label: "Share",
						width: "w-16",
						align: "right",
						hidden: isRanked ? "max-sm:hidden" : "hidden @min-[380px]/panel:flex",
					}),
				]
			: []),
	]
	const rows =
		view.rows.length === 0
			? [dataTableEmpty(h, [`No ${dimension.noun} matches that filter.`])]
			: view.rows.map((row, index) => {
					const isSelected = options.selected === row.name
					const rowIcon =
						dimension.renderIcon !== undefined
							? dimension.renderIcon(h, row)
							: hasIcons
								? analyticsRowIcon(h, model, dimension.filterKey, row.name)
								: undefined
					return h.button(
						[
							h.Key(row.secondary ? `${row.secondary}${row.name}` : row.name),
							h.Type("button"),
							h.OnClick(onSelect(row.name)),
							h.AriaPressed(String(isSelected)),
							h.Style(shareBarStyle(row.share)),
							h.Class(
								cn(
									"group flex w-full items-center gap-3 border-b border-border/40 px-3 py-2 text-left transition-colors last:border-0 @min-[420px]/panel:gap-4 @min-[420px]/panel:px-4",
									"hover:bg-foreground/[0.06] focus-visible:bg-foreground/[0.06] focus-visible:outline-none",
									rowSelectedClass(isSelected),
								),
							),
						],
						[
							...(isRanked
								? [
										h.span(
											[h.Class("w-6 text-right font-mono text-2xs tabular-nums text-muted-foreground/60 max-sm:hidden")],
											[String(index + 1)],
										),
									]
								: []),
							h.span([h.Class("flex w-0 min-w-0 flex-1 items-center gap-2")], [
								...(rowIcon !== undefined
									? [rowIcon]
									: hasIcons
										? [h.span([h.Class("size-4 shrink-0"), h.AriaHidden(true)], [])]
										: []),
								h.span(
									[
										h.Class(
											cn(
												"min-w-0 truncate text-xs transition-colors",
												isSelected ? "font-medium text-foreground" : "text-foreground/90 group-hover:text-foreground",
											),
										),
										h.Title(row.secondary ? `${row.secondary}${row.name}` : label(row.name)),
									],
									[label(row.name)],
								),
							]),
							...(hasViews
								? [
										h.span(
											[h.Class(cn("text-right font-mono text-2xs tabular-nums", isRanked ? "w-16 sm:w-24" : "w-16"))],
											[formatNumber(row.views ?? 0)],
										),
									]
								: []),
							h.span(
								[
									h.Class(
										cn(
											"text-right font-mono text-2xs tabular-nums",
											isRanked ? "w-16 sm:w-24" : hasViews ? "w-20" : "w-24",
											hasViews && !isRanked && "text-muted-foreground",
											!isRanked && hasViews && "hidden @min-[380px]/panel:inline-block",
										),
									),
								],
								[formatNumber(row.count)],
							),
							...(showShare
								? [
										h.span(
											[
												h.Class(
													cn(
														"w-16 text-right font-mono text-2xs tabular-nums text-muted-foreground",
														isRanked ? "max-sm:hidden" : "hidden @min-[380px]/panel:inline-block",
													),
												),
											],
											[formatPercent(row.share)],
										),
									]
								: []),
						],
					)
				})
	return dataTable(
		h,
		{
			ariaLabel: `${dimension.tab} breakdown`,
			isWaiting: options.isWaiting,
			maxHeight: options.maxHeight,
			stickySurfaceClass: options.surfaceClass,
		},
		head,
		rows,
	)
}

/** The card: tabs and filter, the table and its Expand button, or the empty line. */
export const breakdownPanel = (
	h: H,
	model: Model,
	card: BreakdownCard,
	options: Readonly<{ selectedOf: (key: FilterKey) => string | undefined; isWaiting: boolean }>,
): Html | null => {
	const state = panelOf(model, card.id)
	const view = panelView(state, card.dimensions)
	if (view === null) return null
	const { dimension } = view
	return panel(h, { className: "@container/panel" }, [
		h.div([h.Class("flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-3 pt-2.5 pb-2")], [
			dimensionTabs(h, card.id, card.dimensions, view.activeTab),
			panelFilterInput(h, card.id, state.query, dimension.nounPlural, "min-w-24 max-w-40 flex-1"),
		]),
		...(dimension.rows.length === 0
			? [
					emptyMessage(
						h,
						{ className: "py-10" },
						dimension.emptyMessage?.(h) ?? [`No ${dimension.noun} data in the selected window.`],
					),
				]
			: [
					breakdownTable(h, model, card.id, view, {
						maxHeight: "360px",
						surfaceClass: "bg-card",
						isRanked: false,
						selected: options.selectedOf(dimension.filterKey),
						isWaiting: options.isWaiting,
					}),
					h.button(
						[
							h.Type("button"),
							h.OnClick(Message.ClickedExpandPanel({ panel: card.id })),
							h.Class(
								"flex w-full items-center justify-between gap-2 rounded-b-md px-4 py-2 text-2xs text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground focus-visible:bg-muted/40 focus-visible:outline-none",
							),
						],
						[
							h.span([h.Class("flex items-center gap-1.5")], [icon(h, "MaximizeIcon", { size: 12 }), "Expand table"]),
							h.span([h.Class("font-mono tabular-nums")], [
								formatNumber(dimension.rows.length),
								" ",
								dimension.nounPlural,
							]),
						],
					),
				]),
	])
}
