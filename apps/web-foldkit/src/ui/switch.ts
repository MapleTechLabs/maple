import { cn } from "@maple/ui/lib/utils"
import { switchStyles, switchThumbStyles } from "@maple/ui/styles/ui/switch"
import { Option, Schema } from "effect"
import type { Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { hiddenInput, labelIdOf, toggleKey } from "./choice"

/** Base UI `Switch`: on or off, with a thumb and a visually hidden checkbox. */

// MODEL

export const Model = Schema.Struct({ isChecked: Schema.Boolean })
export type Model = typeof Model.Type

export const init = (isChecked = false): Model => ({ isChecked })

// MESSAGE

export const Message = defineMessageUnion({ ToggledSwitch: {} })
export type Message = typeof Message.Type

// UPDATE

export const update = (model: Model, message: Message): Update.Return<Model, Message> =>
	Message.match<Update.Return<Model, Message>>(message, {
		ToggledSwitch: () => ({ model: { isChecked: !model.isChecked } }),
	})

// VIEW

export type SwitchViewConfig<ParentMessage> = Readonly<{
	model: Model
	toParentMessage: (message: Message) => ParentMessage
	/** Base UI's `useId` for the root; the hidden input takes the next one. */
	id: string
	inputId: string
	isDisabled?: boolean
	className?: string
}>

export const labelId = labelIdOf

/** `<Switch>`: the `role="switch"` span, its thumb, and the hidden native checkbox. */
export const view = <ParentMessage>(
	h: HtmlBuilder<ParentMessage>,
	config: SwitchViewConfig<ParentMessage>,
): ReadonlyArray<Html> => {
	const isDisabled = config.isDisabled ?? false
	const { isChecked } = config.model
	const stateAttributes = [
		...(isChecked ? [h.DataAttribute("checked", "")] : [h.DataAttribute("unchecked", "")]),
		...(isDisabled ? [h.DataAttribute("disabled", "")] : []),
	]
	const toggled = config.toParentMessage(Message.ToggledSwitch())
	return [
		h.span(
			[
				h.Id(config.id),
				h.Role("switch"),
				h.AriaChecked(isChecked),
				h.AriaLabelledBy(labelIdOf(config.inputId)),
				...(isDisabled ? [h.AriaDisabled(true)] : []),
				h.Class(cn(switchStyles, config.className)),
				...stateAttributes,
				h.DataAttribute("slot", "switch"),
				h.Tabindex(isDisabled ? -1 : 0),
				...(isDisabled
					? []
					: [
							h.OnClick(toggled, { defaultAction: "Prevent" }),
							h.OnKeyDownPreventDefault((key) => toggleKey(key, toggled)),
						]),
			],
			[
				h.span([
					h.Class(cn(switchThumbStyles)),
					...stateAttributes,
					h.DataAttribute("slot", "switch-thumb"),
				]),
			],
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
