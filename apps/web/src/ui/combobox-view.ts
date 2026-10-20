import { cn } from "@maple/ui/lib/utils"
import * as A from "@maple/ui/styles/ui/autocomplete"
import * as C from "@maple/ui/styles/ui/combobox"
import { inputControlChromeStyles, inputControlLayoutStyles } from "@maple/ui/styles/ui/input"
import { Option } from "effect"
import { Submodel } from "foldkit"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"
import {
	inputId,
	itemId,
	listId,
	Message,
	type Model,
	MountCombobox,
	queryOf,
	visibleItems,
} from "./combobox"
import { icon } from "./icon"
import { portalId } from "./overlay/popup-state"
import { focusGuard, isMounted, SR_ONLY_STYLE, stateAttributes } from "./overlay/transition"
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
		isUnfiltered?: boolean
		/** Opening highlights the selected item, as a single Base UI combobox with a value does. */
		highlightsSelected?: boolean
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
		h.OnClick(
			toMessage(
				options.highlightsSelected === true ? Message.ClickedInputOf({ items: options.items, selected: model.selected[0] ?? null }) : Message.ClickedInput(),
			),
		),
		h.OnKeyDownPreventDefault((key) =>
			INPUT_KEYS.has(key) && !(options.isInline === true && key === "Escape")
				? Option.some(
						toMessage(
							Message.PressedInputKey({
								key,
								items: options.items,
								isUnfiltered: options.isUnfiltered,
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
	className?: string,
): Html => {
	const isSelected = model.selected.includes(value)
	return h.div(
		[
			h.AriaSelected(isSelected),
			h.Class(cn(C.comboboxItemStyles, className)),
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
	positionSelector?: string
	className?: string
	/** A `<ComboboxItem>`'s children when they are more than its value. */
	renderItem?: (value: string) => ReadonlyArray<Html | string>
	isUnfiltered?: boolean
	/** `<ComboboxContent>` under a `<ComboboxTrigger>`: a dialog popup with its search input on top. */
	trigger?: Readonly<{ returnFocusId: string; header: Html; footer?: ReadonlyArray<Html>; sideOffset?: number }>
	/** `<ComboboxItem className>`. */
	itemClassName?: (value: string) => string | undefined
	listClassName?: string
	/** A custom `filter` already applied: `items` are the matches, empty means "no match". */
	isPrefiltered?: boolean
	/** `<ComboboxContent positionerClassName>` (a list above a popover: `z-60`). */
	positionerClassName?: string
	/** The id of the popover this list opens from: a press in the list is not outside it. */
	nestedIn?: string
}>

/** `ComboboxPopup` / `AutocompletePopup` with `Empty` and `List` (in a ScrollArea) inside. */
export const listPopup = (h: H, model: Model, options: PopupOptions): Html => {
	const styles = SLOT_STYLES[options.slot]
	const state = stateAttributes(h, model.isOpen, model.animation)
	const placement = [h.DataAttribute("align", model.align), ...state, h.DataAttribute("side", model.side)]
	const filtered =
		options.isUnfiltered === true || options.isPrefiltered === true ? options.items : visibleItems(model, options.items)
	const isEmpty =
		options.isUnfiltered === true && options.isPrefiltered !== true ? queryOf(model).trim() !== "" : filtered.length === 0
	return h.div(
		[
			h.Key(portalId(model.id)),
			h.DataAttribute("base-ui-portal", ""),
			...(options.nestedIn === undefined ? [] : [h.DataAttribute("nested-in", options.nestedIn)]),
			h.Id(portalId(model.id)),
			h.OnMount(
				MountCombobox({
					slot: options.slot,
					anchorSelector: options.anchorSelector,
					positionSelector: options.positionSelector,
					returnFocusId: options.trigger?.returnFocusId,
					sideOffset: options.trigger?.sideOffset,
				}),
			),
		],
		[
			h.div(
				[
					h.Class(cn(styles.positioner, options.positionerClassName)),
					...placement,
					h.DataAttribute("slot", `${options.slot}-positioner`),
					h.Role("presentation"),
				],
				[
					h.span(
						[h.Class(cn(styles.frame, options.className))],
						[
							...(options.trigger === undefined ? [] : [focusGuard(h, "inside")]),
							h.div(
								[
									h.Class(styles.popup),
									h.DataAttribute("align", model.align),
									h.DataAttribute("base-ui-focusable", ""),
									...state,
									h.DataAttribute("side", model.side),
									h.DataAttribute("slot", `${options.slot}-popup`),
									h.Id(`${model.id}-popup`),
									h.Role(options.trigger === undefined ? "presentation" : "dialog"),
									h.Tabindex(-1),
								],
								[
									...(options.trigger === undefined ? [] : [options.trigger.header]),
									h.div(
										[
											h.AriaAtomic(true),
											h.AriaLive("polite"),
											h.Class(styles.empty),
											h.DataAttribute("slot", `${options.slot}-empty`),
											h.Role("status"),
										],
										isEmpty ? [options.emptyText] : [],
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
													...(options.trigger !== undefined && model.highlighted !== null
														? [h.AriaActiveDescendant(itemId(model.id, model.highlighted))]
														: []),
													h.Class(cn(styles.list, options.listClassName)),
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
																options.itemClassName?.(value),
															)
														: autocompleteItem(h, model, value, index),
												),
											),
										],
									),
									...(options.trigger?.footer ?? []),
								],
							),
							...(options.trigger === undefined ? [] : [focusGuard(h, "inside")]),
						],
					),
					...(options.trigger === undefined ? [dismissButton(h)] : []),
				],
			),
		],
	)
}

export type ChipsViewInputs = Readonly<{
	items: ReadonlyArray<string>
	/** Omitted when a field label names the input (`ariaLabelledBy`). */
	ariaLabel?: string
	/** A Base UI `Field`'s label and description ids. */
	ariaLabelledBy?: string
	ariaDescribedBy?: string
	placeholder: string
	emptyText: string
	className?: string
	/**
	 * `MultiSelectCombobox disabled`: the field stays mounted, dimmed and inert, so cards holding
	 * several conditionally disabled pickers never reflow.
	 */
	isDisabled?: boolean
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
	const isDisabled = inputs.isDisabled ?? false
	const chips = h.div(
		[
			h.Key("chips"),
			...(isDisabled ? [h.AriaDisabled(true)] : []),
			h.Class(cn(C.comboboxChipsStyles, isDisabled && "pointer-events-none opacity-60", inputs.className)),
			h.DataAttribute("slot", "combobox-chips"),
			// Base UI's chips are a toolbar once there is a chip to move between.
			...(model.selected.length === 0 ? [] : [h.Role("toolbar")]),
		],
		[
			...model.selected.map((value) => chip(h, value, isOpen)),
			...(isOpen ? [dismissButton(h)] : []),
			h.input([
				h.Class(cn(C.comboboxChipsInputStyles, C.comboboxChipsInputDefaultStyles)),
				h.DataAttribute("size", "default"),
				...(isDisabled ? [h.Disabled(true)] : []),
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
				...(inputs.ariaLabelledBy === undefined ? [] : [h.AriaLabelledBy(inputs.ariaLabelledBy)]),
				...(inputs.ariaDescribedBy === undefined ? [] : [h.AriaDescribedBy(inputs.ariaDescribedBy)]),
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
	/** Omitted when the input has no `aria-label`. */
	ariaLabel?: string
	placeholder: string
	emptyText: string
	startAddon?: Html
	/** `<ComboboxInput size>`. */
	size?: "sm" | "default"
	/** `<ComboboxInput showTrigger={false}>` drops the chevron button. */
	showTrigger?: boolean
	renderItem?: (value: string) => ReadonlyArray<Html | string>
	/**
	 * A `<Combobox>` without `items` (its items only as children): Base UI filters nothing, so the
	 * list keeps every item, and reports Empty as soon as something is typed.
	 */
	isUnfiltered?: boolean
	/** Opening highlights the selected item (Base UI's single combobox with a value). */
	highlightsSelected?: boolean
	/**
	 * Place the popup under the input instead of the input group. Measured on the service map's
	 * toolbar combobox, whose Base UI positioner resolves no input group and falls back to the input.
	 */
	anchorsInput?: boolean
	/** `<ComboboxInput className>`: lands on the input-control span. */
	className?: string
	/** Wraps the input group (`<div className="w-64">`) and places it with the hidden input and portal. */
	toView: (parts: Readonly<{ field: Html; rest: ReadonlyArray<Html> }>) => Html
}>

export type InputFieldOptions = Pick<
	SingleViewInputs,
	"items" | "ariaLabel" | "placeholder" | "startAddon" | "size" | "showTrigger" | "isUnfiltered" | "className" | "highlightsSelected"
> &
	Readonly<{
		/** Inside a trigger's popup the input carries no dismiss button of its own. */
		hasDismiss?: boolean
	}>

/** `<ComboboxInput startAddon>`: the input group, also the search field atop a trigger's popup. */
export const inputField = (h: H, model: Model, inputs: InputFieldOptions): Html => {
	const hasAddon = inputs.startAddon !== undefined
	const size = inputs.size ?? "default"
	return h.div(
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
			// `ComboboxInput` renders its dismiss button before itself while open (`focusManagerModal`).
			...(model.isOpen && inputs.hasDismiss !== false ? [dismissButton(h)] : []),
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
								isUnfiltered: inputs.isUnfiltered,
								highlightsSelected: inputs.highlightsSelected,
							},
							(message) => message,
						),
					]),
				],
			),
			...(inputs.showTrigger === false ? [] : [triggerButton(h, model, size)]),
		],
	)
}

/** `<Combobox>` with `<ComboboxInput startAddon>`: input group, chevron trigger and its popup. */
export const view = Submodel.defineView<Model, Message, SingleViewInputs>((model, inputs, h) =>
	inputs.toView({
		field: inputField(h, model, inputs),
		rest: [
			hiddenInput(h, model),
			...(isMounted(model.isOpen, model.animation)
				? [
						listPopup(h, model, {
							slot: "combobox",
							items: inputs.items,
							emptyText: inputs.emptyText,
							anchorSelector: `[data-slot=combobox-input-group]:has(#${inputId(model.id)})`,
							positionSelector:
								inputs.anchorsInput === true ? `#${inputId(model.id)}` : undefined,
							renderItem: inputs.renderItem,
							isUnfiltered: inputs.isUnfiltered,
						}),
					]
				: []),
		],
	}),
)

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
