import { cn } from "@maple/ui/lib/utils"
import { buttonVariants } from "@maple/ui/styles/ui/button"
import { toggleVariants } from "@maple/ui/styles/ui/toggle"
import { AsyncData } from "foldkit"
import type { ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import { badge } from "../../../ui/display"
import { filterSection } from "../../../ui/filters/filter-section"
import * as FilterSections from "../../../ui/filters/filter-sections"
import { icon } from "../../../ui/icon"
import { triggerId } from "../../../ui/overlay/popup-state"
import * as Popover from "../../../ui/popover"
import { togglePrimitive } from "../../../ui/toggle"
import * as Tooltip from "../../../ui/tooltip"
import { Message } from "./message"
import type { Model } from "./model"

// The logs table toolbar: the Columns picker,
// wrap and density, under one `TooltipProvider delay={250}`. Pinned columns live in `?columns`.

// The popover anchors to its trigger by id, so the tooltip shares the popover's trigger id.
export const COLUMNS_TRIGGER = triggerId("logs-columns-popover")
export const WRAP_TRIGGER = "logs-wrap-trigger"
export const DENSITY_TRIGGER = "logs-density-trigger"

/** The tooltip text for each trigger. */
const tipOf = (model: Model, triggerId: string): string =>
	triggerId === WRAP_TRIGGER
		? model.wrap
			? "Stop wrapping lines"
			: "Wrap long lines"
		: triggerId === DENSITY_TRIGGER
			? model.density === "comfortable"
				? "Comfortable rows"
				: "Compact rows"
			: "Pin attributes as columns"

/** Keys the time range reported, plus pinned keys outside it (so they can be unpinned here). */
const columnOptions = (model: Model) => {
	const keys = AsyncData.getData(model.attributeKeys.data)
	const options = keys._tag === "Some" ? [...keys.value] : []
	const pinned = model.search.columns ?? []
	return [
		...options,
		...pinned.filter((key) => !options.some((o) => o.name === key)).map((name) => ({ name, count: 0 })),
	]
}

const columnsContent = (h: HtmlBuilder<Message>, model: Model): ReadonlyArray<Html> => {
	const options = columnOptions(model)
	if (options.length === 0)
		return [
			h.p(
				[h.Class("py-2 text-xs text-muted-foreground")],
				["No attribute keys in the selected time range."],
			),
		]
	const section = filterSection(h, {
		title: "Columns",
		options,
		selected: model.search.columns ?? [],
		isSearchable: true,
		sections: model.filterSections,
		toSectionsMessage: (message: FilterSections.Message) => Message.GotFilterSectionsMessage({ message }),
		onToggle: (key) => Message.ToggledColumn({ key }),
	})
	return section === null ? [] : [section]
}

type Tip = (id: string) => ReadonlyArray<ChildAttribute>

/** The Columns `PopoverTrigger` rendered through a `TooltipTrigger` (the outer slot wins). */
const columnsPicker = (h: HtmlBuilder<Message>, model: Model, tip: Tip): Html =>
	h.submodel({
		slotId: "logs-columns-popover",
		model: model.columnsPopover,
		view: Popover.view,
		toParentMessage: (message) => Message.GotColumnsPopoverMessage({ message }),
		viewInputs: {
			className: "w-72",
			toView: ({ trigger, withTrigger }) =>
				h.div(
					[h.Class("contents")],
					withTrigger(
						h.button(
							[
								h.Type("button"),
								h.AriaLabel("Pin attributes as columns"),
								h.Class(cn(buttonVariants({ variant: "outline", size: "sm" }))),
								...trigger,
								...tip(COLUMNS_TRIGGER),
								h.DataAttribute("slot", "tooltip-trigger"),
							],
							[
								icon(h, "ThumbtackIcon", { size: 14, className: "text-muted-foreground" }),
								"Columns",
								...((model.search.columns?.length ?? 0) > 0
									? [
											badge(
												h,
												{
													variant: "secondary",
													size: "sm",
													className: "tabular-nums",
												},
												[String(model.search.columns?.length ?? 0)],
											),
										]
									: []),
							],
						),
					),
				),
			toContent: () => columnsContent(h, model),
		},
	})

const viewToggle = (
	h: HtmlBuilder<Message>,
	tip: Tip,
	options: Readonly<{
		id: string
		label: string
		isPressed: boolean
		onClick: Message
		iconName: "TextWrapIcon" | "LineHeightIcon"
	}>,
): Html =>
	togglePrimitive(
		h,
		{
			isPressed: options.isPressed,
			onClick: options.onClick,
			className: cn(toggleVariants({ variant: "outline", size: "sm" })),
			slot: "tooltip-trigger",
			attributes: [h.AriaLabel(options.label), ...tip(options.id)],
		},
		[icon(h, options.iconName, { size: 14 })],
	)

export const toolbar = (h: HtmlBuilder<Message>, model: Model): Html =>
	h.submodel({
		slotId: "logs-toolbar-tooltip",
		model: model.toolbarTooltip,
		view: Tooltip.view,
		toParentMessage: (message) => Message.GotToolbarTooltipMessage({ message }),
		viewInputs: {
			triggerIds: [COLUMNS_TRIGGER, WRAP_TRIGGER, DENSITY_TRIGGER],
			toContent: (triggerId) => [tipOf(model, triggerId)],
			toView: ({ trigger, portal }) =>
				h.div(
					[h.Class("flex shrink-0 items-center justify-end gap-1.5 pb-1.5")],
					[
						columnsPicker(h, model, trigger),
						viewToggle(h, trigger, {
							id: WRAP_TRIGGER,
							label: "Wrap long log lines",
							isPressed: model.wrap,
							onClick: Message.ClickedWrap(),
							iconName: "TextWrapIcon",
						}),
						viewToggle(h, trigger, {
							id: DENSITY_TRIGGER,
							label: "Toggle comfortable row density",
							isPressed: model.density === "comfortable",
							onClick: Message.ClickedDensity(),
							iconName: "LineHeightIcon",
						}),
						...(portal === null ? [] : [portal]),
					],
				),
		},
	})
