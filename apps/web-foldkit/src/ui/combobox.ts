import { cn } from "@maple/ui/lib/utils"
import {
	comboboxChipRemoveStyles,
	comboboxChipStyles,
	comboboxChipsInputDefaultStyles,
	comboboxChipsInputStyles,
	comboboxChipsStyles,
	comboboxChipTextStyles,
	comboboxEmptyStyles,
	comboboxInputControlStyles,
	comboboxInputDefaultStyles,
	comboboxInputGroupStyles,
	comboboxInputStartAddonStyles,
	comboboxItemIndicatorStyles,
	comboboxItemStyles,
	comboboxItemTextStyles,
	comboboxListStyles,
	comboboxPopupFrameStyles,
	comboboxPopupStyles,
	comboboxPositionerStyles,
	comboboxStartAddonStyles,
	comboboxTriggerDefaultStyles,
	comboboxTriggerStyles,
} from "@maple/ui/styles/ui/combobox"
import { inputControlChromeStyles, inputControlLayoutStyles } from "@maple/ui/styles/ui/input"
import { Option, Schema } from "effect"
import type { Update } from "foldkit"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { modifyFields } from "foldkit/struct"
import { hiddenInput } from "./choice"
import { icon } from "./icon"
import { inputControlClassName } from "./input"

/**
 * Base UI `Combobox` (single and `multiple`) and `Autocomplete`: the typed query, the selected
 * values, whether the list is open, and the highlighted item. Items are fixtures held in the Model
 * so `update` can filter and navigate them. `autocomplete.ts` renders the autocomplete mode.
 */

export const ComboboxMode = Schema.Literals(["single", "multiple", "autocomplete"])
export type ComboboxMode = typeof ComboboxMode.Type

// MODEL

export const Model = Schema.Struct({
	mode: ComboboxMode,
	items: Schema.Array(Schema.String),
	inputValue: Schema.String,
	selected: Schema.Array(Schema.String),
	isOpen: Schema.Boolean,
	maybeHighlighted: Schema.Option(Schema.String),
})
export type Model = typeof Model.Type

export const init = (config: {
	mode: ComboboxMode
	items: ReadonlyArray<string>
	selected?: ReadonlyArray<string>
	isOpen?: boolean
}): Model => {
	const selected = config.selected ?? []
	return {
		mode: config.mode,
		items: config.items,
		inputValue: config.mode === "single" ? (selected[0] ?? "") : "",
		selected,
		isOpen: config.isOpen ?? false,
		maybeHighlighted: Option.none(),
	}
}

/** The items the list shows: all of them while the input still reads the selected value. */
export const visibleItems = (model: Model): ReadonlyArray<string> => {
	const query = model.inputValue.trim().toLowerCase()
	if (query === "" || (model.mode === "single" && model.selected[0] === model.inputValue))
		return model.items
	return model.items.filter((item) => item.toLowerCase().includes(query))
}

// MESSAGE

export const Message = defineMessageUnion({
	ChangedInput: { value: Schema.String },
	ClickedTrigger: {},
	ClickedInput: {},
	PressedInputKey: { key: Schema.String },
	HoveredItem: { value: Schema.String },
	ClickedItem: { value: Schema.String },
	ClickedChipRemove: { value: Schema.String },
	ClickedOutside: {},
})
export type Message = typeof Message.Type

// UPDATE

const closed = (model: Model): Model =>
	modifyFields(model, {
		isOpen: () => false,
		maybeHighlighted: () => Option.none(),
		// Closing a single combobox puts the selected value back in the input.
		inputValue: (value) => (model.mode === "single" ? (model.selected[0] ?? "") : value),
	})

const opened = (model: Model): Model => modifyFields(model, { isOpen: () => true })

const moved = (model: Model, step: number): Model => {
	const items = visibleItems(model)
	if (items.length === 0) return model
	const current = Option.match(model.maybeHighlighted, {
		onNone: () => -1,
		onSome: (value) => items.indexOf(value),
	})
	const next =
		current === -1 ? (step > 0 ? 0 : items.length - 1) : (current + step + items.length) % items.length
	return modifyFields(opened(model), { maybeHighlighted: () => Option.fromNullishOr(items[next]) })
}

const chosen = (model: Model, value: string): Model => {
	if (model.mode === "multiple") {
		const selected = model.selected.includes(value)
			? model.selected.filter((item) => item !== value)
			: [...model.selected, value]
		return modifyFields(model, { selected: () => selected, inputValue: () => "" })
	}
	const selected = model.mode === "single" ? [value] : model.selected
	return closed(modifyFields(model, { selected: () => selected, inputValue: () => value }))
}

const pressedKey = (model: Model, key: string): Model => {
	if (key === "ArrowDown") return moved(model, 1)
	if (key === "ArrowUp") return moved(model, -1)
	if (key === "Escape") return closed(model)
	if (key === "Enter") {
		return Option.match(model.maybeHighlighted, {
			onNone: () => model,
			onSome: (value) => (model.isOpen ? chosen(model, value) : model),
		})
	}
	if (key === "Backspace" && model.mode === "multiple" && model.inputValue === "") {
		return modifyFields(model, { selected: (selected) => selected.slice(0, -1) })
	}
	return model
}

export const update = (model: Model, message: Message): Update.Return<Model, Message> =>
	Message.match<Update.Return<Model, Message>>(message, {
		ChangedInput: ({ value }) => ({
			model: modifyFields(opened(model), {
				inputValue: () => value,
				maybeHighlighted: () => Option.none(),
			}),
		}),
		ClickedTrigger: () => ({ model: model.isOpen ? closed(model) : opened(model) }),
		ClickedInput: () => ({ model: model.mode === "autocomplete" ? model : opened(model) }),
		PressedInputKey: ({ key }) => ({ model: pressedKey(model, key) }),
		HoveredItem: ({ value }) => ({
			model: modifyFields(model, { maybeHighlighted: () => Option.some(value) }),
		}),
		ClickedItem: ({ value }) => ({ model: chosen(model, value) }),
		ClickedChipRemove: ({ value }) => ({
			model: modifyFields(model, { selected: (selected) => selected.filter((item) => item !== value) }),
		}),
		ClickedOutside: () => ({ model: closed(model) }),
	})

/** Keys the input hands to the list; the rest type. */
export const INPUT_KEYS: ReadonlyArray<string> = ["ArrowDown", "ArrowUp", "Enter", "Escape"]

// VIEW

export type ComboboxViewConfig<ParentMessage> = Readonly<{
	model: Model
	toParentMessage: (message: Message) => ParentMessage
	/** Base UI's `useId` on the input; the hidden input is `<id>-hidden-input`. */
	id: string
	label: string
	placeholder: string
	startAddon?: Html
	emptyText: string
	/** The element the input group sits in (legacy wraps it in a sized div). */
	wrap?: (inputGroup: Html) => Html
}>

/** The `role="combobox"` attributes and handlers Base UI puts on every combobox-like input. */
export const comboboxInputAttributes = <P>(
	h: HtmlBuilder<P>,
	config: Pick<ComboboxViewConfig<P>, "model" | "toParentMessage" | "id" | "label" | "placeholder">,
	slot: string,
): ReadonlyArray<Attribute<P>> => {
	const { model, toParentMessage } = config
	const handlesKey = (key: string) =>
		INPUT_KEYS.includes(key) ||
		(key === "Backspace" && model.mode === "multiple" && model.inputValue === "")
	return [
		h.AriaAutocomplete("list"),
		h.AriaExpanded(model.isOpen),
		h.AriaHasPopup("listbox"),
		h.AriaLabel(config.label),
		h.Autocapitalize("none"),
		h.Autocomplete("off"),
		h.Autocorrect("off"),
		h.DataAttribute("slot", slot),
		h.Id(config.id),
		h.Placeholder(config.placeholder),
		h.Role("combobox"),
		h.Spellcheck(false),
		h.Value(model.inputValue),
		h.OnInput((value) => toParentMessage(Message.ChangedInput({ value }))),
		h.OnClick(toParentMessage(Message.ClickedInput())),
		h.OnKeyDownPreventDefault((key) =>
			handlesKey(key) ? Option.some(toParentMessage(Message.PressedInputKey({ key }))) : Option.none(),
		),
	]
}

const itemView = <P>(
	h: HtmlBuilder<P>,
	config: ComboboxViewConfig<P>,
	item: string,
	slots: PopupSlots,
): Html => {
	const isSelected = config.model.selected.includes(item)
	const isHighlighted = Option.contains(config.model.maybeHighlighted, item)
	return h.div(
		[
			h.AriaSelected(isSelected),
			h.Class(slots.itemClassName),
			...(isHighlighted ? [h.DataAttribute("highlighted", "")] : []),
			...(isSelected ? [h.DataAttribute("selected", "")] : []),
			h.DataAttribute("slot", `${slots.prefix}-item`),
			h.Role("option"),
			h.Tabindex(-1),
			h.OnMouseEnter(config.toParentMessage(Message.HoveredItem({ value: item }))),
			h.OnClick(config.toParentMessage(Message.ClickedItem({ value: item }))),
		],
		slots.prefix === "combobox"
			? [
					...(isSelected
						? [h.span([h.AriaHidden(true), h.Class(comboboxItemIndicatorStyles)], [checkPath(h)])]
						: []),
					h.div([h.Class(comboboxItemTextStyles)], [item]),
				]
			: [item],
	)
}

const checkPath = <P>(h: HtmlBuilder<P>): Html =>
	h.svg(
		[
			h.Attribute("aria-hidden", "true"),
			h.Attribute("fill", "none"),
			h.Attribute("height", "24"),
			h.Attribute("stroke", "currentColor"),
			h.Attribute("stroke-linecap", "round"),
			h.Attribute("stroke-linejoin", "round"),
			h.Attribute("stroke-width", "2"),
			h.Attribute("viewBox", "0 0 24 24"),
			h.Attribute("width", "24"),
			h.Attribute("xmlns", "http://www.w3.org/2000/svg"),
		],
		[h.path([h.Attribute("d", "M5.252 12.7 10.2 18.63 18.748 5.37")])],
	)

export type PopupSlots = Readonly<{
	prefix: "combobox" | "autocomplete"
	positionerClassName: string
	frameClassName: string
	popupClassName: string
	emptyClassName: string
	listClassName: string
	itemClassName: string
}>

const COMBOBOX_SLOTS: PopupSlots = {
	prefix: "combobox",
	positionerClassName: comboboxPositionerStyles,
	frameClassName: comboboxPopupFrameStyles,
	popupClassName: comboboxPopupStyles,
	emptyClassName: cn(comboboxEmptyStyles),
	listClassName: cn(comboboxListStyles),
	itemClassName: cn(comboboxItemStyles),
}

/**
 * The open list. TODO(overlay): Base UI portals it to `<body>`, anchors it under the input and
 * wraps the list in a ScrollArea; here it sits after the input group, absolutely placed.
 */
export const popup = <P>(h: HtmlBuilder<P>, config: ComboboxViewConfig<P>, slots: PopupSlots): Html => {
	const items = visibleItems(config.model)
	return h.div(
		[
			h.Class(slots.positionerClassName),
			h.DataAttribute("open", ""),
			h.DataAttribute("slot", `${slots.prefix}-positioner`),
			h.Role("presentation"),
			h.Style({ position: "absolute" }),
		],
		[
			h.span(
				[h.Class(slots.frameClassName)],
				[
					h.div(
						[
							h.Class(slots.popupClassName),
							h.DataAttribute("open", ""),
							h.DataAttribute("slot", `${slots.prefix}-popup`),
						],
						[
							h.div(
								[
									h.Class(slots.emptyClassName),
									h.DataAttribute("slot", `${slots.prefix}-empty`),
								],
								items.length === 0 ? [config.emptyText] : [],
							),
							h.div(
								[
									h.Class(slots.listClassName),
									h.DataAttribute("slot", `${slots.prefix}-list`),
									h.Id(`${config.id}-list`),
									h.Role("listbox"),
								],
								items.map((item) => itemView(h, config, item, slots)),
							),
						],
					),
				],
			),
		],
	)
}

/** `<Combobox>` with `<ComboboxInput startAddon>`: the input group, the open list, the hidden input. */
export const view = <P>(h: HtmlBuilder<P>, config: ComboboxViewConfig<P>): ReadonlyArray<Html> => {
	const { model, toParentMessage } = config
	const wrap = config.wrap ?? ((group: Html) => group)
	const hasAddon = config.startAddon !== undefined
	const controlClassName = `${comboboxInputControlStyles} ${cn(hasAddon && comboboxInputStartAddonStyles, comboboxInputDefaultStyles)}`
	const group = h.div(
		[h.Class(comboboxInputGroupStyles), h.DataAttribute("slot", "combobox-input-group"), h.Role("group")],
		[
			...(config.startAddon === undefined
				? []
				: [
						h.div(
							[
								h.AriaHidden(true),
								h.Class(comboboxStartAddonStyles),
								h.DataAttribute("slot", "combobox-start-addon"),
							],
							[config.startAddon],
						),
					]),
			h.span(
				[
					h.Class(cn(inputControlLayoutStyles, inputControlChromeStyles, controlClassName)),
					h.DataAttribute("size", "default"),
					h.DataAttribute("slot", "input-control"),
				],
				[
					h.input([
						...comboboxInputAttributes(h, config, "combobox-input"),
						h.Class(inputControlClassName("default")),
					]),
				],
			),
			h.button(
				[
					h.AriaExpanded(model.isOpen),
					h.AriaHasPopup("listbox"),
					h.Class(cn(comboboxTriggerStyles, comboboxTriggerDefaultStyles)),
					h.DataAttribute("slot", "combobox-trigger"),
					h.Tabindex(-1),
					h.Type("button"),
					h.OnClick(toParentMessage(Message.ClickedTrigger())),
				],
				[
					h.span(
						[h.AriaHidden(true), h.DataAttribute("slot", "combobox-icon")],
						[icon(h, "ChevronExpandYIcon")],
					),
				],
			),
		],
	)
	return [
		wrap(group),
		...(model.isOpen ? [popup(h, config, COMBOBOX_SLOTS)] : []),
		hiddenInput(h, { id: `${config.id}-hidden-input`, value: model.selected[0] ?? "" }),
	]
}

/** `<Combobox multiple>` with `<ComboboxChips>`: one chip per selected value, then the input. */
export const chipsView = <P>(
	h: HtmlBuilder<P>,
	config: ComboboxViewConfig<P> & Readonly<{ className?: string }>,
): ReadonlyArray<Html> => {
	const { model, toParentMessage } = config
	return [
		h.div(
			[
				h.Class(cn(comboboxChipsStyles, config.className)),
				h.DataAttribute("slot", "combobox-chips"),
				h.Role("toolbar"),
			],
			[
				...model.selected.map((item) =>
					h.div(
						[
							h.Class(cn(comboboxChipStyles)),
							h.DataAttribute("slot", "combobox-chip"),
							h.Tabindex(-1),
						],
						[
							h.span([h.Class(comboboxChipTextStyles), h.Title(item)], [item]),
							h.button(
								[
									h.AriaDisabled(false),
									h.AriaLabel("Remove"),
									h.Class(comboboxChipRemoveStyles),
									h.DataAttribute("slot", "combobox-chip-remove"),
									h.Tabindex(-1),
									h.Type("button"),
									h.OnClick(toParentMessage(Message.ClickedChipRemove({ value: item }))),
								],
								[icon(h, "XmarkIcon")],
							),
						],
					),
				),
				h.input([
					...comboboxInputAttributes(h, config, "combobox-chips-input"),
					h.Class(cn(comboboxChipsInputStyles, comboboxChipsInputDefaultStyles)),
					h.DataAttribute("size", "default"),
				]),
			],
		),
		...(model.isOpen ? [popup(h, config, COMBOBOX_SLOTS)] : []),
		hiddenInput(h, { id: `${config.id}-hidden-input`, value: "" }),
	]
}
