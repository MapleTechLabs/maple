import { cn } from "@maple/ui/lib/utils"
import {
	autocompleteEmptyStyles,
	autocompleteInputDefaultStyles,
	autocompleteInputGroupStyles,
	autocompleteInputStartAddonStyles,
	autocompleteItemStyles,
	autocompleteListStyles,
	autocompletePopupStyles,
	autocompletePopupSurfaceStyles,
	autocompletePositionerStyles,
	autocompleteStartAddonStyles,
} from "@maple/ui/styles/ui/autocomplete"
import { inputControlChromeStyles, inputControlLayoutStyles } from "@maple/ui/styles/ui/input"
import type { Html, HtmlBuilder } from "foldkit/html"
import { hiddenInput } from "./choice"
import * as Combobox from "./combobox"
import { inputControlClassName } from "./input"

/**
 * `<Autocomplete>` with `<AutocompleteInput startAddon>`: a free-text input that suggests items.
 * State is a Combobox Submodel in `autocomplete` mode (`Combobox.init({ mode: "autocomplete" })`).
 */

const AUTOCOMPLETE_SLOTS: Combobox.PopupSlots = {
	prefix: "autocomplete",
	positionerClassName: autocompletePositionerStyles,
	frameClassName: autocompletePopupSurfaceStyles,
	popupClassName: autocompletePopupStyles,
	emptyClassName: cn(autocompleteEmptyStyles),
	listClassName: cn(autocompleteListStyles),
	itemClassName: cn(autocompleteItemStyles),
}

export const view = <P>(h: HtmlBuilder<P>, config: Combobox.ComboboxViewConfig<P>): ReadonlyArray<Html> => {
	const wrap = config.wrap ?? ((group: Html) => group)
	const hasAddon = config.startAddon !== undefined
	const controlClassName = cn(hasAddon && autocompleteInputStartAddonStyles, autocompleteInputDefaultStyles)
	const group = h.div(
		[
			h.Class(autocompleteInputGroupStyles),
			h.DataAttribute("slot", "autocomplete-input-group"),
			h.Role("group"),
		],
		[
			...(config.startAddon === undefined
				? []
				: [
						h.div(
							[
								h.AriaHidden(true),
								h.Class(autocompleteStartAddonStyles),
								h.DataAttribute("slot", "autocomplete-start-addon"),
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
						...Combobox.comboboxInputAttributes(h, config, "autocomplete-input"),
						h.Class(inputControlClassName("default")),
					]),
				],
			),
		],
	)
	return [
		wrap(group),
		...(config.model.isOpen ? [Combobox.popup(h, config, AUTOCOMPLETE_SLOTS)] : []),
		hiddenInput(h, { id: `${config.id}-hidden-input`, value: config.model.inputValue }),
	]
}
