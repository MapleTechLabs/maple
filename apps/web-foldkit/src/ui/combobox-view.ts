import { cn } from "@maple/ui/lib/utils"
import * as A from "@maple/ui/styles/ui/autocomplete"
import * as C from "@maple/ui/styles/ui/combobox"
import { inputControlChromeStyles, inputControlLayoutStyles } from "@maple/ui/styles/ui/input"
import { Option } from "effect"
import { Submodel } from "foldkit"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"
import { inputId, itemId, listId, Message, type Model, MountCombobox, visibleItems } from "./combobox"
import { icon } from "./icon"
import { portalId } from "./overlay/popup-state"
import { isMounted, SR_ONLY_STYLE, stateAttributes } from "./overlay/transition"
import { inputControlClassName } from "./input"
import { scrollArea } from "./scroll-area"

type H = HtmlBuilder<Message>
type Slot = "combobox" | "autocomplete"

/** Base UI's visually hidden "Dismiss" button for screen readers, beside the input and the list. */
export const dismissButton = <M>(h: HtmlBuilder<M>): Html =>
	h.span([
		h.AriaLabel("Dismiss"),
		h.Role("button"),
		h.Style({
			clipPath: "inset(50%)",
			overflow: "hidden",
			whiteSpace: "nowrap",
			border: "0px",
			padding: "0px",
			width: "1px",
			height: "1px",
			margin: "-1px",
			position: "absolute",
		}),
	])

const INPUT_KEYS = new Set(["ArrowDown", "ArrowUp", "Home", "End", "Enter", "Escape"])

/** The input's combobox attributes, state and keys: arrows move the highlight, Enter picks it.
 *  Generic over the Message so the command palette renders its inline list from its parent. */
export const inputAttributes = <M>(
	h: HtmlBuilder<M>,
	model: Model,
	options: Readonly<{
		slot: string
		ariaLabel?: string
		placeholder?: string
		items: ReadonlyArray<string>
		/** An inline list (the command palette) has no popup side. */
		isInline?: boolean
	}>,
	toMessage: (message: Message) => M,
): ReadonlyArray<Attribute<M>> => {
	const isVisible = isMounted(model.isOpen, model.animation)
	return [
		...(model.highlighted === null ? [] : [h.AriaActiveDescendant(itemId(model.id, model.highlighted))]),
		h.AriaAutocomplete("list"),
		...(isVisible ? [h.AriaControls(listId(model.id))] : []),
		h.AriaExpanded(model.isOpen),
		h.AriaHasPopup("listbox"),
		...(options.ariaLabel === undefined ? [] : [h.AriaLabel(options.ariaLabel)]),
		h.Autocapitalize("none"),
		h.Autocomplete("off"),
		h.Autocorrect("off"),
		...(model.isOpen
			? [
					h.DataAttribute("popup-open", ""),
					...(options.isInline === true ? [] : [h.DataAttribute("popup-side", model.side)]),
					h.DataAttribute("pressed", ""),
				]
			: []),
		h.DataAttribute("slot", options.slot),
		h.Id(inputId(model.id)),
		...(options.placeholder === undefined ? [] : [h.Placeholder(options.placeholder)]),
		h.Role("combobox"),
		h.Spellcheck(false),
		h.Value(model.inputValue),
		h.OnInput((value) => toMessage(Message.ChangedInput({ value }))),
		h.OnClick(toMessage(Message.ClickedInput())),
		h.OnKeyDownPreventDefault((key) =>
			INPUT_KEYS.has(key) && !(options.isInline === true && key === "Escape")
				? Option.some(
						toMessage(
							Message.PressedInputKey({
								key,
								items: options.items,
							}),
						),
					)
				: Option.none(),
		),
	]
}

/** `<input aria-hidden>` Base UI keeps for form submission, after the field. */
export const hiddenInput = <M>(h: HtmlBuilder<M>, model: Model): Html =>
	h.input([
		h.Key("hidden-input"),
		h.AriaHidden(true),
		h.Id(`${inputId(model.id)}-hidden-input`),
		h.Style(SR_ONLY_STYLE),
		h.Tabindex(-1),
		h.Value(model.mode === "multiple" ? "" : model.inputValue),
	])

/** combobox.tsx's item indicator: an inline round-capped check, not a pixel glyph. */
export const comboboxCheckIcon = <Message>(h: HtmlBuilder<Message>): Html =>
	h.svg(
		[
			h.Attribute("xmlns", "http://www.w3.org/2000/svg"),
			h.Attribute("width", "24"),
			h.Attribute("height", "24"),
			h.Attribute("viewBox", "0 0 24 24"),
			h.Attribute("fill", "none"),
			h.Attribute("stroke", "currentColor"),
			h.Attribute("stroke-width", "2"),
			h.Attribute("stroke-linecap", "round"),
			h.Attribute("stroke-linejoin", "round"),
			h.Attribute("aria-hidden", "true"),
		],
		[h.path([h.Attribute("d", "M5.252 12.7 10.2 18.63 18.748 5.37")])],
	)

const comboboxItem = (
	h: H,
	model: Model,
	value: string,
	index: number,
	renderItem?: (value: string) => ReadonlyArray<Html | string>,
): Html => {
	const isSelected = model.selected.includes(value)
	return h.div(
		[
			h.AriaSelected(isSelected),
			h.Class(cn(C.comboboxItemStyles)),
			...(model.highlighted === index ? [h.DataAttribute("highlighted", "")] : []),
			...(isSelected ? [h.DataAttribute("selected", "")] : []),
			h.DataAttribute("slot", "combobox-item"),
			h.Id(itemId(model.id, index)),
			h.Role("option"),
			h.OnMouseMove(Message.HighlightedItem({ index })),
			h.OnClick(Message.ClickedItem({ value })),
		],
		[
			...(isSelected
				? [
						h.span(
							[
								h.AriaHidden(true),
								h.Class(C.comboboxItemIndicatorStyles),
								h.DataAttribute("selected", ""),
							],
							[comboboxCheckIcon(h)],
						),
					]
				: []),
			h.div([h.Class(C.comboboxItemTextStyles)], renderItem?.(value) ?? [value]),
		],
	)
}

const autocompleteItem = (h: H, model: Model, value: string, index: number): Html =>
	h.div(
		[
			h.Class(cn(A.autocompleteItemStyles)),
			...(model.highlighted === index ? [h.DataAttribute("highlighted", "")] : []),
			h.DataAttribute("slot", "autocomplete-item"),
			h.Id(itemId(model.id, index)),
			h.Role("option"),
			h.OnMouseMove(Message.HighlightedItem({ index })),
			h.OnClick(Message.ClickedItem({ value })),
		],
		[value],
	)

const SLOT_STYLES = {
	combobox: {
		positioner: C.comboboxPositionerStyles,
		frame: C.comboboxPopupFrameStyles,
		popup: C.comboboxPopupStyles,
		empty: C.comboboxEmptyStyles,
		list: C.comboboxListStyles,
	},
	autocomplete: {
		positioner: A.autocompletePositionerStyles,
		frame: A.autocompletePopupSurfaceStyles,
		popup: A.autocompletePopupStyles,
		empty: A.autocompleteEmptyStyles,
		list: A.autocompleteListStyles,
	},
} as const

export type PopupOptions = Readonly<{
	slot: Slot
	items: ReadonlyArray<string>
	emptyText: string
	anchorSelector: string
	className?: string
	/** A `<ComboboxItem>`'s children when they are more than its value. */
	renderItem?: (value: string) => ReadonlyArray<Html | string>
}>

/** `ComboboxPopup` / `AutocompletePopup` with `Empty` and `List` (in a ScrollArea) inside. */
export const listPopup = (h: H, model: Model, options: PopupOptions): Html => {
	const styles = SLOT_STYLES[options.slot]
	const state = stateAttributes(h, model.isOpen, model.animation)
	const placement = [h.DataAttribute("align", model.align), ...state, h.DataAttribute("side", model.side)]
	const filtered = visibleItems(model, options.items)
	return h.div(
		[
			h.Key(portalId(model.id)),
			h.DataAttribute("base-ui-portal", ""),
			h.Id(portalId(model.id)),
			h.OnMount(MountCombobox({ slot: options.slot, anchorSelector: options.anchorSelector })),
		],
		[
			h.div(
				[
					h.Class(styles.positioner),
					...placement,
					h.DataAttribute("slot", `${options.slot}-positioner`),
					h.Role("presentation"),
				],
				[
					h.span(
						[h.Class(cn(styles.frame, options.className))],
						[
							h.div(
								[
									h.Class(styles.popup),
									h.DataAttribute("align", model.align),
									h.DataAttribute("base-ui-focusable", ""),
									...state,
									h.DataAttribute("side", model.side),
									h.DataAttribute("slot", `${options.slot}-popup`),
									h.Id(`${model.id}-popup`),
									h.Role("presentation"),
									h.Tabindex(-1),
								],
								[
									h.div(
										[
											h.AriaAtomic(true),
											h.AriaLive("polite"),
											h.Class(styles.empty),
											h.DataAttribute("slot", `${options.slot}-empty`),
											h.Role("status"),
										],
										filtered.length === 0 ? [options.emptyText] : [],
									),
									scrollArea(
										h,
										{
											idPrefix: `${model.id}-scroll`,
											scrollFade: true,
											scrollbarGutter: true,
										},
										[
											h.div(
												[
													...(model.mode === "multiple"
														? [h.AriaMultiSelectable(true)]
														: []),
													h.Class(styles.list),
													h.DataAttribute("slot", `${options.slot}-list`),
													h.Id(listId(model.id)),
													h.Role("listbox"),
													h.Tabindex(-1),
												],
												filtered.map((value, index) =>
													options.slot === "combobox"
														? comboboxItem(
																h,
																model,
																value,
																index,
																options.renderItem,
															)
														: autocompleteItem(h, model, value, index),
												),
											),
										],
									),
								],
							),
						],
					),
					dismissButton(h),
				],
			),
		],
	)
}

export type ChipsViewInputs = Readonly<{
	items: ReadonlyArray<string>
	ariaLabel: string
	placeholder: string
	emptyText: string
	className?: string
	/** Places the chips field and, while open, the hidden input and the portal. */
	toView: (parts: ReadonlyArray<Html>) => Html
}>

/** Base UI hides the chips from assistive tech while the list is open. */
const chip = (h: H, value: string, isOpen: boolean): Html =>
	h.div(
		[
			h.Key(`chip-${value}`),
			...(isOpen ? [h.AriaHidden(true)] : []),
			h.Class(cn(C.comboboxChipStyles)),
			h.DataAttribute("slot", "combobox-chip"),
			h.Tabindex(-1),
		],
		[
			h.span([h.Class(C.comboboxChipTextStyles), h.Title(value)], [value]),
			h.button(
				[
					h.AriaDisabled(false),
					h.AriaLabel("Remove"),
					h.Class(C.comboboxChipRemoveStyles),
					h.DataAttribute("slot", "combobox-chip-remove"),
					h.Tabindex(-1),
					h.Type("button"),
					h.OnClick(Message.RemovedChip({ value })),
				],
				[icon(h, "XmarkIcon")],
			),
		],
	)

/** `<Combobox multiple>` with `ComboboxChips`: chips for the selection, then the chips input. */
export const chipsView = Submodel.defineView<Model, Message, ChipsViewInputs>((model, inputs, h) => {
	const chipsSelector = `[data-slot=combobox-chips]:has(> #${inputId(model.id)})`
	const isOpen = isMounted(model.isOpen, model.animation)
	const chips = h.div(
		[
			h.Key("chips"),
			h.Class(cn(C.comboboxChipsStyles, inputs.className)),
			h.DataAttribute("slot", "combobox-chips"),
			h.Role("toolbar"),
		],
		[
			...model.selected.map((value) => chip(h, value, isOpen)),
			...(isOpen ? [dismissButton(h)] : []),
			h.input([
				h.Class(cn(C.comboboxChipsInputStyles, C.comboboxChipsInputDefaultStyles)),
				h.DataAttribute("size", "default"),
				...inputAttributes(
					h,
					model,
					{
						slot: "combobox-chips-input",
						ariaLabel: inputs.ariaLabel,
						placeholder: inputs.placeholder,
						items: inputs.items,
					},
					(message) => message,
				),
			]),
		],
	)
	return inputs.toView([
		chips,
		hiddenInput(h, model),
		...(isOpen
			? [
					listPopup(h, model, {
						slot: "combobox",
						items: inputs.items,
						emptyText: inputs.emptyText,
						anchorSelector: chipsSelector,
					}),
				]
			: []),
	])
})

export type SingleViewInputs = Readonly<{
	items: ReadonlyArray<string>
	/** Omitted when the legacy input has no `aria-label`. */
	ariaLabel?: string
	placeholder: string
	emptyText: string
	startAddon?: Html
	/** `<ComboboxInput size>`. */
	size?: "sm" | "default"
	/** `<ComboboxInput showTrigger={false}>` drops the chevron button. */
	showTrigger?: boolean
	renderItem?: (value: string) => ReadonlyArray<Html | string>
	/** `<ComboboxInput className>`: lands on the input-control span. */
	className?: string
	/** Wraps the input group (`<div className="w-64">`) and places it with the hidden input and portal. */
	toView: (parts: Readonly<{ field: Html; rest: ReadonlyArray<Html> }>) => Html
}>

/** `<Combobox>` with `<ComboboxInput startAddon>`: input group, chevron trigger and its popup. */
export const view = Submodel.defineView<Model, Message, SingleViewInputs>((model, inputs, h) => {
	const hasAddon = inputs.startAddon !== undefined
	const size = inputs.size ?? "default"
	const field = h.div(
		[
			h.Key("input-group"),
			h.Class(C.comboboxInputGroupStyles),
			h.DataAttribute("slot", "combobox-input-group"),
			h.Role("group"),
		],
		[
			...(inputs.startAddon === undefined
				? []
				: [
						h.div(
							[
								h.AriaHidden(true),
								h.Class(C.comboboxStartAddonStyles),
								h.DataAttribute("slot", "combobox-start-addon"),
							],
							[inputs.startAddon],
						),
					]),
			h.span(
				[
					h.Class(
						cn(
							inputControlLayoutStyles,
							inputControlChromeStyles,
							`${C.comboboxInputControlStyles} ${cn(hasAddon && C.comboboxInputStartAddonStyles, size === "sm" ? C.comboboxInputSmStyles : C.comboboxInputDefaultStyles)}`,
							inputs.className,
						),
					),
					h.DataAttribute("size", size),
					h.DataAttribute("slot", "input-control"),
				],
				[
					h.input([
						h.Class(inputControlClassName(size)),
						...inputAttributes(
							h,
							model,
							{
								slot: "combobox-input",
								ariaLabel: inputs.ariaLabel,
								placeholder: inputs.placeholder,
								items: inputs.items,
							},
							(message) => message,
						),
					]),
				],
			),
			...(inputs.showTrigger === false ? [] : [triggerButton(h, model, size)]),
		],
	)
	return inputs.toView({
		field,
		rest: [
			hiddenInput(h, model),
			...(isMounted(model.isOpen, model.animation)
				? [
						listPopup(h, model, {
							slot: "combobox",
							items: inputs.items,
							emptyText: inputs.emptyText,
							anchorSelector: `[data-slot=combobox-input-group]:has(#${inputId(model.id)})`,
							renderItem: inputs.renderItem,
						}),
					]
				: []),
		],
	})
})

/** `ComboboxTrigger` with its chevron. */
const triggerButton = (h: H, model: Model, size: "sm" | "default"): Html =>
	h.button(
		[
			h.AriaExpanded(model.isOpen),
			h.AriaHasPopup("listbox"),
			h.Class(
				cn(
					C.comboboxTriggerStyles,
					size === "sm" ? C.comboboxTriggerSmStyles : C.comboboxTriggerDefaultStyles,
				),
			),
			h.DataAttribute("slot", "combobox-trigger"),
			h.Tabindex(-1),
			h.Type("button"),
			h.OnClick(Message.ClickedTrigger()),
		],
		[
			h.span(
				[h.AriaHidden(true), h.DataAttribute("slot", "combobox-icon")],
				[icon(h, "ChevronExpandYIcon")],
			),
		],
	)
