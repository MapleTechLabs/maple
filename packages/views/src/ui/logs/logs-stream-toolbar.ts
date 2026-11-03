import type { ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import { cn } from "@maple/ui/lib/utils"
import { button } from "../button"
import { badge } from "../display"
import { filterSection } from "../filters/filter-section"
import type * as FilterSections from "../filters/filter-sections"
import { icon } from "../icon"
import { triggerId } from "../overlay/popup-state"
import * as Popover from "../popover"
import { toggle } from "../toggle"
import * as Tooltip from "../tooltip"
import { typography } from "../typography"
import type { Density } from "./viewer"
import { Array as Arr } from "effect"

// The logs stream's toolbar: the Columns picker,
// wrap and density, under one `TooltipProvider delay={250}`.

const POPOVER_SLOT = "logs-columns-popover"
// The popover anchors to its trigger by id, so the tooltip shares the popover's trigger id.
const COLUMNS_TRIGGER = triggerId(POPOVER_SLOT)
const WRAP_TRIGGER = "logs-wrap-trigger"
const DENSITY_TRIGGER = "logs-density-trigger"

/** A key the Columns picker offers, with how often it occurs. */
export type ColumnOption = Readonly<{ name: string; count: number }>

export type LogsStreamToolbarOptions<M> = Readonly<{
	tooltip: Tooltip.Model
	toTooltipMessage: (message: Tooltip.Message) => M
	columnsPopover: Popover.Model
	toColumnsPopoverMessage: (message: Popover.Message) => M
	/** The keys on offer; pinned keys missing from it are added so they can be unpinned. */
	columnOptions: ReadonlyArray<ColumnOption>
	pinnedColumns: ReadonlyArray<string>
	onToggleColumn: (key: string) => M
	sections: FilterSections.Model
	toSectionsMessage: (message: FilterSections.Message) => M
	wrap: boolean
	onToggleWrap: M
	density: Density
	onToggleDensity: M
	className?: string
}>

/** The tooltip text for each trigger. */
const tipOf = <M>(options: LogsStreamToolbarOptions<M>, id: string): string =>
	id === WRAP_TRIGGER
		? options.wrap
			? "Stop wrapping lines"
			: "Wrap long lines"
		: id === DENSITY_TRIGGER
			? options.density === "comfortable"
				? "Comfortable rows"
				: "Compact rows"
			: "Pin attributes as columns"

const columnsContent = <M>(h: HtmlBuilder<M>, options: LogsStreamToolbarOptions<M>): ReadonlyArray<Html> => {
	const offered = options.columnOptions
	const all = [
		...offered,
		...Arr.map(
			Arr.filter(options.pinnedColumns, (key) => !Arr.some(offered, (option) => option.name === key)),
			(name) => ({ name, count: 0 }),
		),
	]
	if (all.length === 0)
		return [
			typography(h, { size: "xs", tone: "muted", as: "p", className: "py-2" }, [
				"No attribute keys in this window",
			]),
		]
	const section = filterSection(h, {
		title: "Columns",
		options: all,
		selected: options.pinnedColumns,
		isSearchable: true,
		sections: options.sections,
		toSectionsMessage: options.toSectionsMessage,
		onToggle: options.onToggleColumn,
	})
	return section === null ? [] : [section]
}

type Tip = (id: string) => ReadonlyArray<ChildAttribute>

/** The Columns `PopoverTrigger` rendered through a `TooltipTrigger` (the outer slot wins). */
const columnsPicker = <M>(h: HtmlBuilder<M>, options: LogsStreamToolbarOptions<M>, tip: Tip): Html =>
	h.submodel({
		slotId: POPOVER_SLOT,
		model: options.columnsPopover,
		view: Popover.view,
		toParentMessage: options.toColumnsPopoverMessage,
		viewInputs: {
			className: "w-72",
			toView: ({ trigger, withTrigger }) =>
				h.div(
					[h.Class("contents")],
					withTrigger(
						button(
							h,
							{
								variant: "outline",
								size: "sm",
								attributes: [
									h.AriaLabel("Pin attributes as columns"),
									...trigger,
									...tip(COLUMNS_TRIGGER),
									h.DataAttribute("slot", "tooltip-trigger"),
								],
							},
							[
								icon(h, "ThumbtackIcon", { size: 14, className: "text-muted-foreground" }),
								"Columns",
								...(options.pinnedColumns.length > 0
									? [
											badge(
												h,
												{
													variant: "secondary",
													size: "sm",
													className: "tabular-nums",
												},
												[String(options.pinnedColumns.length)],
											),
										]
									: []),
							],
						),
					),
				),
			toContent: () => columnsContent(h, options),
		},
	})

const viewToggle = <M>(
	h: HtmlBuilder<M>,
	tip: Tip,
	options: Readonly<{
		id: string
		label: string
		isPressed: boolean
		onClick: M
		iconName: "TextWrapIcon" | "LineHeightIcon"
	}>,
): Html =>
	toggle(
		h,
		{
			variant: "outline",
			size: "sm",
			isPressed: options.isPressed,
			onClick: options.onClick,
			attributes: [
				h.AriaLabel(options.label),
				...tip(options.id),
				h.DataAttribute("slot", "tooltip-trigger"),
			],
		},
		[icon(h, options.iconName, { size: 14 })],
	)

/** The logs stream's Columns picker and its wrap and density toggles, sharing one tooltip. */
export const logsStreamToolbar = <M>(h: HtmlBuilder<M>, options: LogsStreamToolbarOptions<M>): Html =>
	h.submodel({
		slotId: "logs-toolbar-tooltip",
		model: options.tooltip,
		view: Tooltip.view,
		toParentMessage: options.toTooltipMessage,
		viewInputs: {
			triggerIds: [COLUMNS_TRIGGER, WRAP_TRIGGER, DENSITY_TRIGGER],
			toContent: (id) => [tipOf(options, id)],
			toView: ({ trigger, portal }) =>
				h.div(
					[h.Class(cn("flex shrink-0 items-center justify-end gap-1.5", options.className))],
					[
						columnsPicker(h, options, trigger),
						viewToggle(h, trigger, {
							id: WRAP_TRIGGER,
							label: "Wrap long log lines",
							isPressed: options.wrap,
							onClick: options.onToggleWrap,
							iconName: "TextWrapIcon",
						}),
						viewToggle(h, trigger, {
							id: DENSITY_TRIGGER,
							label: "Toggle comfortable row density",
							isPressed: options.density === "comfortable",
							onClick: options.onToggleDensity,
							iconName: "LineHeightIcon",
						}),
						...(portal === null ? [] : [portal]),
					],
				),
		},
	})
