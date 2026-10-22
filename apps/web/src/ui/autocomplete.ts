import { cn } from "@maple/ui/lib/utils"
import * as A from "@maple/ui/styles/ui/autocomplete"
import {
	inputControlChromeStyles,
	inputControlLayoutStyles,
	inputLgStyles,
	inputStyles,
} from "@maple/ui/styles/ui/input"
import { Submodel } from "foldkit"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"
import { inputId, Message, type Model } from "./combobox"
import { dismissButton, hiddenInput, inputAttributes, listPopup } from "./combobox-view"
import { icon } from "./icon"
import { isMounted } from "./overlay/transition"

/**
 * Base UI `Autocomplete` (`@maple/ui/autocomplete`) on the Combobox Submodel in "autocomplete"
 * mode: `AutocompleteInput` (input group, start addon, `Input` control) and its popup.
 */
export { Message, type Model } from "./combobox"

export type FieldOptions<M = never> = Readonly<{
	items: ReadonlyArray<string>
	ariaLabel?: string
	placeholder?: string
	size?: "default" | "lg"
	/** `className` of `AutocompleteInput`, on the `Input` control (the command palette's). */
	className?: string
	/** The command palette's inline list: no dismiss button, list-empty markers. */
	isInline?: boolean
	isListEmpty?: boolean
	/** `Command inline={false}` inside a dialog: the inline layout, but with the dismiss button. */
	hasDismissButton?: boolean
	/** `filter={null}`: `items` are already the list (the command palette's fuse ranking). */
	isUnfiltered?: boolean
	/** `startAddon`: the magnifier (default) or none. */
	hasStartAddon?: boolean
	/** `showClear`: Base UI renders the clear button while the input holds a value. */
	onClear?: M
}>

/** `AutocompleteInput` with a magnifier start addon (unless `hasStartAddon: false`). */
export const autocompleteField = <M>(
	h: HtmlBuilder<M>,
	model: Model,
	options: FieldOptions<M>,
	toMessage: (message: Message) => M,
): Html => {
	const size = options.size ?? "default"
	const hasStartAddon = options.hasStartAddon ?? true
	const listEmpty: ReadonlyArray<Attribute<M>> =
		options.isListEmpty === true ? [h.DataAttribute("list-empty", "")] : []
	const popupState: ReadonlyArray<Attribute<M>> = model.isOpen
		? [
				h.DataAttribute("popup-open", ""),
				...(options.isInline === true ? [] : [h.DataAttribute("popup-side", model.side)]),
				h.DataAttribute("pressed", ""),
			]
		: []
	return h.div(
		[
			h.Key("input-group"),
			h.Class(A.autocompleteInputGroupStyles),
			...listEmpty,
			...popupState,
			h.DataAttribute("slot", "autocomplete-input-group"),
			h.Role("group"),
		],
		[
			...(hasStartAddon
				? [
						h.div(
							[
								h.AriaHidden(true),
								h.Class(A.autocompleteStartAddonStyles),
								h.DataAttribute("slot", "autocomplete-start-addon"),
							],
							[icon(h, "MagnifierIcon")],
						),
					]
				: []),
			...((options.hasDismissButton ?? options.isInline !== true) &&
			isMounted(model.isOpen, model.animation)
				? [dismissButton(h)]
				: []),
			h.span(
				[
					h.Class(
						cn(
							inputControlLayoutStyles,
							inputControlChromeStyles,
							hasStartAddon && A.autocompleteInputStartAddonStyles,
							A.autocompleteInputDefaultStyles,
							options.className,
						),
					),
					h.DataAttribute("size", size),
					h.DataAttribute("slot", "input-control"),
				],
				[
					h.input([
						h.Class(cn(inputStyles, size === "lg" && inputLgStyles)),
						...listEmpty,
						...inputAttributes(
							h,
							model,
							{
								slot: "autocomplete-input",
								ariaLabel: options.ariaLabel,
								placeholder: options.placeholder,
								items: options.items,
								isInline: options.isInline,
								isUnfiltered: options.isUnfiltered,
							},
							toMessage,
						),
					]),
				],
			),
			...(options.onClear === undefined || model.inputValue === ""
				? []
				: [
						h.button(
							[
								h.Type("button"),
								h.AriaLabel("Clear"),
								h.Class(
									cn(A.autocompleteInputClearStyles, A.autocompleteInputClearDefaultStyles),
								),
								h.DataAttribute("slot", "autocomplete-clear"),
								h.OnClick(options.onClear),
							],
							[icon(h, "XmarkIcon")],
						),
					]),
		],
	)
}

export type ViewInputs = Readonly<{
	items: ReadonlyArray<string>
	ariaLabel: string
	placeholder: string
	emptyText: string
	hasStartAddon?: boolean
	/** `showClear`: the clear button empties the input. */
	hasClear?: boolean
	/** Wraps the field (`<div className="w-64">`) and places it with the hidden input and portal. */
	toView: (parts: Readonly<{ field: Html; rest: ReadonlyArray<Html> }>) => Html
}>

export const view = Submodel.defineView<Model, Message, ViewInputs>((model, inputs, h) =>
	inputs.toView({
		field: autocompleteField(
			h,
			model,
			{
				...inputs,
				onClear: inputs.hasClear === true ? Message.ChangedInput({ value: "" }) : undefined,
			},
			(message) => message,
		),
		rest: [
			hiddenInput(h, model),
			...(isMounted(model.isOpen, model.animation)
				? [
						listPopup(h, model, {
							slot: "autocomplete",
							items: inputs.items,
							emptyText: inputs.emptyText,
							anchorSelector: `[data-slot=autocomplete-input-group]:has(#${inputId(model.id)})`,
						}),
					]
				: []),
		],
	}),
)
