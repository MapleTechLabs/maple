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

export type SwitchControlOptions<Message> = Readonly<{
	/** Base UI's `useId` for the root; the hidden input takes the next one. */
	id: string
	inputId: string
	isChecked: boolean
	isDisabled?: boolean
	ariaLabel?: string
	labelledBy?: string
	describedBy?: string
	/** The enclosing Base UI field's `data-filled`. */
	isFilled?: boolean
	className?: string
	/** Omitted for a switch that only shows a state. */
	onToggle?: Message
}>

/** `<Switch>`: the `role="switch"` span, its thumb, and the hidden native checkbox. */
export const switchControl = <Message>(
	h: HtmlBuilder<Message>,
	options: SwitchControlOptions<Message>,
): ReadonlyArray<Html> => {
	const isDisabled = options.isDisabled ?? false
	const { isChecked } = options
	const toggled = isDisabled ? undefined : options.onToggle
	const stateAttributes = [
		h.DataAttribute(isChecked ? "checked" : "unchecked", ""),
		...(isDisabled ? [h.DataAttribute("disabled", "")] : []),
		...((options.isFilled ?? false) ? [h.DataAttribute("filled", "")] : []),
	]
	const describedBy = options.describedBy === undefined ? [] : [h.AriaDescribedBy(options.describedBy)]
	return [
		h.span(
			[
				h.Id(options.id),
				h.Role("switch"),
				h.AriaChecked(isChecked),
				...(options.ariaLabel === undefined ? [] : [h.AriaLabel(options.ariaLabel)]),
				...(options.labelledBy === undefined ? [] : [h.AriaLabelledBy(options.labelledBy)]),
				...describedBy,
				...(isDisabled ? [h.AriaDisabled(true)] : []),
				h.Class(cn(switchStyles, options.className)),
				...stateAttributes,
				h.DataAttribute("slot", "switch"),
				h.Tabindex(isDisabled ? -1 : 0),
				...(toggled === undefined
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
			id: options.inputId,
			type: "checkbox",
			isChecked,
			isDisabled,
			onActivate: Option.fromUndefinedOr(toggled),
			attributes: describedBy,
		}),
	]
}

export type SwitchViewConfig<ParentMessage> = Readonly<{
	model: Model
	toParentMessage: (message: Message) => ParentMessage
	id: string
	inputId: string
	isDisabled?: boolean
	className?: string
}>

export const labelId = labelIdOf

/** The Submodel's `<Switch>`, labelled by the wrapping `<Label>`. */
export const view = <ParentMessage>(
	h: HtmlBuilder<ParentMessage>,
	config: SwitchViewConfig<ParentMessage>,
): ReadonlyArray<Html> =>
	switchControl(h, {
		id: config.id,
		inputId: config.inputId,
		isChecked: config.model.isChecked,
		isDisabled: config.isDisabled,
		labelledBy: labelIdOf(config.inputId),
		className: config.className,
		onToggle: config.toParentMessage(Message.ToggledSwitch()),
	})
