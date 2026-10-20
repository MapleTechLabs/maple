import { refreshingClass } from "@maple/ui/lib/refreshing"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { filterChip } from "../../../ui/filter-chip"
import * as Select from "../../../ui/select"
import * as SelectView from "../../../ui/select-view"
import { searchInput } from "../../../ui/search-input"

// The tool filter toolbar and its facet selects.

/** Base UI selects need a real value for "no filter"; it never reaches the URL. */
export const ALL = "__all__"

export type FacetOption = Readonly<{ name: string; count: number }>

/** A facet select's Model for the URL's value. */
export const initFacetSelect = (id: string, value: string | undefined): Select.Model =>
	Select.init(id, { value: value ?? ALL, selectedIndex: null })

/** The URL value a facet select's change writes. */
export const facetValue = (value: string): string | undefined => (value === ALL ? undefined : value)

export type FacetSelectConfig<M> = Readonly<{
	label: string
	value: string | undefined
	options: ReadonlyArray<FacetOption>
	model: Select.Model
	toMessage: (message: Select.Message) => M
}>

/** `FacetSelect`: the label small beside the value; a set value is drawn in the primary tint. */
export const facetSelect = <M>(h: HtmlBuilder<M>, config: FacetSelectConfig<M>): Html => {
	const isSet = config.value !== undefined
	return h.submodel({
		slotId: config.model.id,
		model: config.model,
		view: SelectView.view,
		toParentMessage: config.toMessage,
		viewInputs: {
			entries: [
				{ _tag: "Item", item: { value: ALL, label: "All" } },
				...config.options.map((option): SelectView.SelectEntry => ({
					_tag: "Item",
					item: { value: option.name, label: option.name },
				})),
			],
			ariaLabel: config.label,
			size: "sm",
			isDisabled: config.options.length === 0,
			className: cn(
				"h-[30px] gap-2 rounded-md px-2.5 font-mono text-xs",
				isSet
					? "border-primary/40 bg-primary/10 text-primary [&_svg]:text-primary"
					: "bg-card text-foreground",
			),
			renderValue: () => [
				h.span(
					[h.Class(cn("text-2xs", isSet ? "text-primary/70" : "text-muted-foreground"))],
					[config.label],
				),
				" ",
				config.value ?? "All",
			],
			toView: (parts) => h.div([h.Class("contents")], parts),
		},
	})
}

export type ToolbarConfig<M> = Readonly<{
	/** The tool-name search (overview only): what is typed, and its Messages. */
	nameSearch?: Readonly<{ value: string; inputId: string; onInput: (value: string) => M; onClear: M }>
	selects: ReadonlyArray<Html>
	isFailingOnly: boolean
	onToggleFailingOnly: M
	isWaiting: boolean
	actions?: Html
}>

const nameSearchInput = <M>(h: HtmlBuilder<M>, search: NonNullable<ToolbarConfig<M>["nameSearch"]>): Html =>
	searchInput(h, {
		id: search.inputId,
		size: "default",
		className: cn("max-w-sm", "w-full font-mono sm:w-[260px]"),
		placeholder: "Tool name…",
		value: search.value,
		onInput: search.onInput,
		onClear: search.onClear,
	})

/** `ToolFilterToolbar` inside the shared `Toolbar` shell. */
export const toolFilterToolbar = <M>(h: HtmlBuilder<M>, config: ToolbarConfig<M>): Html =>
	h.div(
		[
			h.Class(
				cn(
					"flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3",
					"justify-start gap-2 border-border px-6",
				),
			),
		],
		[
			...(config.nameSearch === undefined ? [] : [nameSearchInput(h, config.nameSearch)]),
			h.div(
				[
					...(config.isWaiting ? [h.AriaBusy(true)] : []),
					h.Class(cn("flex flex-wrap items-center gap-2", refreshingClass(config.isWaiting))),
				],
				[
					...config.selects,
					filterChip(
						h,
						{
							isPressed: config.isFailingOnly,
							onClick: config.onToggleFailingOnly,
							tone: "crit",
							hasDot: true,
							className: "font-mono",
						},
						["Failing only"],
					),
				],
			),
			...(config.actions === undefined ? [] : [h.div([h.Class("ml-auto")], [config.actions])]),
		],
	)
