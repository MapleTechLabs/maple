import { refreshingClass } from "@maple/ui/lib/refreshing"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Select from "../../../ui/select"
import * as SelectView from "../../../ui/select-view"
import { searchInput } from "../../../ui/search-input"
import { switchControl } from "../../../ui/switch"
import { listToolbar } from "../../kit/list-toolbar"

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
				"gap-2 font-mono text-xs",
				isSet
					? "border-primary-a4 bg-primary-a2 text-primary [&_svg]:text-primary"
					: "bg-card text-foreground",
			),
			renderValue: () => [
				h.span(
					[h.Class(cn("text-2xs", isSet ? "text-primary" : "text-muted-foreground"))],
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
}>

const nameSearchInput = <M>(h: HtmlBuilder<M>, search: NonNullable<ToolbarConfig<M>["nameSearch"]>): Html =>
	searchInput(h, {
		id: search.inputId,
		size: "sm",
		className: "w-full max-w-sm font-mono",
		placeholder: "Tool name…",
		value: search.value,
		onInput: search.onInput,
		onClear: search.onClear,
	})

/**
 * `ToolFilterToolbar` on the kit's `listToolbar`, edge to edge above the page's flush body:
 * the search pinned left and the filters right, or the filters alone on the left.
 */
export const toolFilterToolbar = <M>(h: HtmlBuilder<M>, config: ToolbarConfig<M>): Html => {
	const filters = h.div(
		[
			...(config.isWaiting ? [h.AriaBusy(true)] : []),
			h.Class(cn("flex flex-wrap items-center gap-2", refreshingClass(config.isWaiting))),
		],
		[
			...config.selects,
			// The same switch as "With errors" on the sessions list, so it reads as a filter.
			h.label(
				[h.Class("inline-flex cursor-pointer items-center gap-2 text-xs font-medium")],
				[
					...switchControl(h, {
						id: "agent-tools-failing-switch",
						inputId: "agent-tools-failing-input",
						isChecked: config.isFailingOnly,
						ariaLabel: "Failing only",
						className:
							"[--thumb-size:--spacing(3.5)] data-checked:bg-severity-error sm:[--thumb-size:--spacing(3.5)]",
						onToggle: config.onToggleFailingOnly,
					}),
					"Failing only",
				],
			),
		],
	)
	return listToolbar(h, {
		className: "border-b border-border px-6 py-3",
		leading: config.nameSearch === undefined ? filters : nameSearchInput(h, config.nameSearch),
		trailing: config.nameSearch === undefined ? [] : [filters],
	})
}
