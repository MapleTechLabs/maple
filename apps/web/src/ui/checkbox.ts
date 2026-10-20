import { cn } from "@maple/ui/lib/utils"
import { checkboxIconStyles, checkboxIndicatorStyles, checkboxStyles } from "@maple/ui/styles/ui/checkbox"
import { Option, Schema } from "effect"
import type { Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { hiddenInput, labelIdOf, toggleKey } from "./choice"

/**
 * Base UI `Checkbox`: the checked state is the Submodel; `indeterminate` stays a view input, as it
 * is a controlled prop in @maple/ui (it overrides how the box reads, not what a click does).
 */

// MODEL

export const Model = Schema.Struct({ isChecked: Schema.Boolean })
export type Model = typeof Model.Type

export const init = (isChecked = false): Model => ({ isChecked })

// MESSAGE

export const Message = defineMessageUnion({ ToggledCheckbox: {} })
export type Message = typeof Message.Type

// UPDATE

export const update = (model: Model, message: Message): Update.Return<Model, Message> =>
	Message.match<Update.Return<Model, Message>>(message, {
		ToggledCheckbox: () => ({ model: { isChecked: !model.isChecked } }),
	})

// VIEW

export type CheckboxViewConfig<ParentMessage> = Readonly<{
	model: Model
	toParentMessage: (message: Message) => ParentMessage
	/** Base UI's `useId` for the root; the hidden input takes the next one. */
	id: string
	inputId: string
	isIndeterminate?: boolean
	isDisabled?: boolean
	className?: string
	/** `aria-label`, next to the label's `aria-labelledby`. */
	ariaLabel?: string
}>

/** The id Base UI gives a wrapping `<Label>`, which names the checkbox through `aria-labelledby`. */
export const labelId = labelIdOf

const indicatorPath = (isIndeterminate: boolean) =>
	isIndeterminate ? "M5.252 12h13.496" : "M5.252 12.7 10.2 18.63 18.748 5.37"

const indicator = <M>(h: HtmlBuilder<M>, stateAttribute: string, isIndeterminate: boolean): Html =>
	h.span(
		[
			h.Class(checkboxIndicatorStyles),
			h.DataAttribute(stateAttribute, ""),
			h.DataAttribute("slot", "checkbox-indicator"),
		],
		[
			h.svg(
				[
					h.Attribute("aria-hidden", "true"),
					h.Attribute("class", checkboxIconStyles),
					h.Attribute("fill", "none"),
					h.Attribute("height", "24"),
					h.Attribute("stroke", "currentColor"),
					h.Attribute("stroke-linecap", "round"),
					h.Attribute("stroke-linejoin", "round"),
					h.Attribute("stroke-width", "3"),
					h.Attribute("viewBox", "0 0 24 24"),
					h.Attribute("width", "24"),
					h.Attribute("xmlns", "http://www.w3.org/2000/svg"),
				],
				[h.path([h.Attribute("d", indicatorPath(isIndeterminate))])],
			),
		],
	)

/** `<Checkbox>`: the `role="checkbox"` span plus Base UI's visually hidden native input. */
export const view = <ParentMessage>(
	h: HtmlBuilder<ParentMessage>,
	config: CheckboxViewConfig<ParentMessage>,
): ReadonlyArray<Html> => {
	const isIndeterminate = config.isIndeterminate ?? false
	const isDisabled = config.isDisabled ?? false
	const { isChecked } = config.model
	const state = isIndeterminate ? "indeterminate" : isChecked ? "checked" : "unchecked"
	const toggled = config.toParentMessage(Message.ToggledCheckbox())
	return [
		h.span(
			[
				h.Id(config.id),
				h.Role("checkbox"),
				h.AriaChecked(isIndeterminate ? "mixed" : isChecked),
				...(config.ariaLabel === undefined ? [] : [h.AriaLabel(config.ariaLabel)]),
				h.AriaLabelledBy(labelIdOf(config.inputId)),
				...(isDisabled ? [h.AriaDisabled(true), h.DataAttribute("disabled", "")] : []),
				h.Class(cn(checkboxStyles, config.className)),
				h.DataAttribute(state, ""),
				h.DataAttribute("slot", "checkbox"),
				h.Tabindex(isDisabled ? -1 : 0),
				...(isDisabled
					? []
					: [
							// Prevent the wrapping label's activation, which would toggle a second time.
							h.OnClick(toggled, { defaultAction: "Prevent" }),
							h.OnKeyDownPreventDefault((key) => toggleKey(key, toggled)),
						]),
			],
			state === "unchecked" ? [] : [indicator(h, state, isIndeterminate)],
		),
		hiddenInput(h, {
			id: config.inputId,
			type: "checkbox",
			isChecked,
			isDisabled,
			onActivate: Option.some(toggled),
		}),
	]
}
