import { cn } from "@maple/ui/lib/utils"
import {
	selectGroupLabelStyles,
	selectItemIndicatorIconStyles,
	selectItemIndicatorStyles,
	selectItemStyles,
	selectItemTextStyles,
	selectListStyles,
	selectPopupStyles,
	selectPopupSurfaceStyles,
	selectPositionerStyles,
	selectSeparatorStyles,
	selectTriggerIconClassName,
	selectTriggerVariants,
	selectValueStyles,
} from "@maple/ui/styles/ui/select"
import { Option, Schema } from "effect"
import type { Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { modifyFields } from "foldkit/struct"
import { hiddenInput } from "./choice"
import { checkIcon, chevronExpandYIcon } from "./icon"

/**
 * Base UI `Select`: the selected value, whether the popup is open, and the highlighted option.
 * Opening highlights the selected option; arrows move the highlight, Enter or a click selects
 * and closes, Escape closes and keeps the value.
 */

// MODEL

export const Model = Schema.Struct({
	/** Option values in list order, for keyboard navigation. */
	values: Schema.Array(Schema.String),
	value: Schema.String,
	isOpen: Schema.Boolean,
	maybeHighlighted: Schema.Option(Schema.String),
})
export type Model = typeof Model.Type

export const init = (config: { values: ReadonlyArray<string>; value: string; isOpen?: boolean }): Model => ({
	values: config.values,
	value: config.value,
	isOpen: config.isOpen ?? false,
	maybeHighlighted: config.isOpen === true ? Option.some(config.value) : Option.none(),
})

// MESSAGE

export const Message = defineMessageUnion({
	ClickedTrigger: {},
	PressedTriggerKey: { key: Schema.String },
	PressedListKey: { key: Schema.String },
	HoveredOption: { value: Schema.String },
	ClickedOption: { value: Schema.String },
	ClickedOutside: {},
})
export type Message = typeof Message.Type

// UPDATE

const opened = (model: Model): Model =>
	modifyFields(model, { isOpen: () => true, maybeHighlighted: () => Option.some(model.value) })

const closed = (model: Model): Model =>
	modifyFields(model, { isOpen: () => false, maybeHighlighted: () => Option.none() })

const moved = (model: Model, step: number): Model => {
	const current = Option.match(model.maybeHighlighted, {
		onNone: () => -1,
		onSome: (value) => model.values.indexOf(value),
	})
	const next = Math.max(0, Math.min(model.values.length - 1, current + step))
	return modifyFields(model, { maybeHighlighted: () => Option.fromNullishOr(model.values[next]) })
}

const selected = (model: Model, value: string): Model => closed(modifyFields(model, { value: () => value }))

export const OPEN_KEYS: ReadonlyArray<string> = ["ArrowDown", "ArrowUp", "Enter", " "]
export const LIST_KEYS: ReadonlyArray<string> = [
	"ArrowDown",
	"ArrowUp",
	"Home",
	"End",
	"Enter",
	" ",
	"Escape",
]

export const update = (model: Model, message: Message): Update.Return<Model, Message> =>
	Message.match<Update.Return<Model, Message>>(message, {
		ClickedTrigger: () => ({ model: model.isOpen ? closed(model) : opened(model) }),
		PressedTriggerKey: ({ key }) => ({
			model: OPEN_KEYS.includes(key) && !model.isOpen ? opened(model) : model,
		}),
		PressedListKey: ({ key }) => {
			if (!model.isOpen) return { model }
			if (key === "ArrowDown") return { model: moved(model, 1) }
			if (key === "ArrowUp") return { model: moved(model, -1) }
			if (key === "Home") return { model: moved(model, -model.values.length) }
			if (key === "End") return { model: moved(model, model.values.length) }
			if (key === "Enter" || key === " ") {
				return {
					model: Option.match(model.maybeHighlighted, {
						onNone: () => closed(model),
						onSome: (value) => selected(model, value),
					}),
				}
			}
			return { model: key === "Escape" ? closed(model) : model }
		},
		HoveredOption: ({ value }) => ({
			model: modifyFields(model, { maybeHighlighted: () => Option.some(value) }),
		}),
		ClickedOption: ({ value }) => ({ model: selected(model, value) }),
		ClickedOutside: () => ({ model: closed(model) }),
	})

// VIEW

export type SelectOption = Readonly<{ value: string; label: string }>
export type SelectEntry =
	| Readonly<{ _tag: "Option"; option: SelectOption }>
	| Readonly<{ _tag: "Group"; label: string; labelId: string; options: ReadonlyArray<SelectOption> }>
	| Readonly<{ _tag: "Separator" }>

export type SelectViewConfig<ParentMessage> = Readonly<{
	model: Model
	toParentMessage: (message: Message) => ParentMessage
	/** Base UI's `useId` on the trigger; the list and hidden input derive from it. */
	id: string
	label: string
	entries: ReadonlyArray<SelectEntry>
	size?: "sm" | "default" | "lg"
	className?: string
}>

const optionsOf = (entries: ReadonlyArray<SelectEntry>): ReadonlyArray<SelectOption> =>
	entries.flatMap((entry) =>
		entry._tag === "Option" ? [entry.option] : entry._tag === "Group" ? entry.options : [],
	)

const optionView = <P>(h: HtmlBuilder<P>, config: SelectViewConfig<P>, option: SelectOption): Html => {
	const isSelected = option.value === config.model.value
	const isHighlighted = Option.contains(config.model.maybeHighlighted, option.value)
	return h.div(
		[
			h.AriaSelected(isSelected),
			h.Class(cn(selectItemStyles)),
			...(isHighlighted ? [h.DataAttribute("highlighted", "")] : []),
			...(isSelected ? [h.DataAttribute("selected", "")] : []),
			h.DataAttribute("slot", "select-item"),
			h.Role("option"),
			h.Tabindex(isHighlighted ? 0 : -1),
			h.OnMouseEnter(config.toParentMessage(Message.HoveredOption({ value: option.value }))),
			h.OnClick(config.toParentMessage(Message.ClickedOption({ value: option.value }))),
		],
		[
			...(isSelected
				? [
						h.span(
							[
								h.AriaHidden(true),
								h.Class(selectItemIndicatorStyles),
								h.DataAttribute("selected", ""),
							],
							[checkIcon(h, { className: selectItemIndicatorIconStyles })],
						),
					]
				: []),
			h.div([h.Class(selectItemTextStyles)], [option.label]),
		],
	)
}

const entryView = <P>(h: HtmlBuilder<P>, config: SelectViewConfig<P>, entry: SelectEntry): Html => {
	if (entry._tag === "Option") return optionView(h, config, entry.option)
	if (entry._tag === "Separator") {
		return h.div([
			h.Class(cn(selectSeparatorStyles)),
			h.DataAttribute("orientation", "horizontal"),
			h.DataAttribute("slot", "select-separator"),
			h.Role("presentation"),
		])
	}
	return h.div(
		[h.AriaLabelledBy(entry.labelId), h.DataAttribute("slot", "select-group"), h.Role("group")],
		[
			h.div(
				[
					h.AriaHidden(true),
					h.Class(selectGroupLabelStyles),
					h.DataAttribute("slot", "select-group-label"),
					h.Id(entry.labelId),
				],
				[entry.label],
			),
			...entry.options.map((option) => optionView(h, config, option)),
		],
	)
}

/**
 * The open popup. TODO(overlay): Base UI portals it to `<body>` and aligns the selected option
 * with the trigger (`alignItemWithTrigger`); here it sits after the trigger, absolutely placed.
 */
const popup = <P>(h: HtmlBuilder<P>, config: SelectViewConfig<P>): Html =>
	h.div(
		[
			h.Class(selectPositionerStyles),
			h.DataAttribute("open", ""),
			h.DataAttribute("slot", "select-positioner"),
			h.Role("presentation"),
			h.Style({ position: "absolute" }),
		],
		[
			h.div(
				[
					h.Class(selectPopupStyles),
					h.DataAttribute("open", ""),
					h.DataAttribute("slot", "select-popup"),
				],
				[
					h.div(
						[h.Class(selectPopupSurfaceStyles)],
						[
							h.div(
								[
									h.Class(cn(selectListStyles)),
									h.DataAttribute("slot", "select-list"),
									h.Id(`${config.id}-list`),
									h.Role("listbox"),
								],
								config.entries.map((entry) => entryView(h, config, entry)),
							),
						],
					),
				],
			),
		],
	)

/** `<Select>` with `<SelectTrigger><SelectValue /></SelectTrigger>`, then the hidden input. */
export const view = <P>(h: HtmlBuilder<P>, config: SelectViewConfig<P>): ReadonlyArray<Html> => {
	const { model, toParentMessage } = config
	const label =
		optionsOf(config.entries).find((option) => option.value === model.value)?.label ?? model.value
	const openAttributes = model.isOpen ? [h.DataAttribute("popup-open", "")] : []
	// Open, the trigger keeps focus and drives the list; other keys (Tab) keep their default.
	const keyMessage = (key: string) =>
		model.isOpen
			? LIST_KEYS.includes(key)
				? Option.some(toParentMessage(Message.PressedListKey({ key })))
				: Option.none()
			: OPEN_KEYS.includes(key)
				? Option.some(toParentMessage(Message.PressedTriggerKey({ key })))
				: Option.none()
	return [
		h.button(
			[
				...(model.isOpen ? [h.AriaControls(`${config.id}-list`)] : []),
				h.AriaExpanded(model.isOpen),
				h.AriaHasPopup("listbox"),
				h.AriaLabel(config.label),
				h.Class(cn(selectTriggerVariants({ size: config.size }), config.className)),
				...openAttributes,
				h.DataAttribute("slot", "select-trigger"),
				h.Id(config.id),
				h.Role("combobox"),
				h.Tabindex(0),
				h.Type("button"),
				h.OnClick(toParentMessage(Message.ClickedTrigger())),
				h.OnKeyDownPreventDefault(keyMessage),
			],
			[
				h.span([h.Class(cn(selectValueStyles)), h.DataAttribute("slot", "select-value")], [label]),
				h.span(
					[h.AriaHidden(true), ...openAttributes, h.DataAttribute("slot", "select-icon")],
					[chevronExpandYIcon(h, { className: selectTriggerIconClassName })],
				),
			],
		),
		...(model.isOpen ? [popup(h, config)] : []),
		hiddenInput(h, { id: `${config.id}-hidden-input`, value: model.value }),
	]
}
