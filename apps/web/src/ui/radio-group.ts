import { cn } from "@maple/ui/lib/utils"
import { radioGroupStyles, radioIndicatorStyles, radioStyles } from "@maple/ui/styles/ui/radio-group"
import { Effect, Option, Schema } from "effect"
import { Command, Dom, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { modifyFields } from "foldkit/struct"
import { hiddenInput, labelIdOf, toggleKey } from "./choice"

/**
 * Base UI `RadioGroup`: the checked value. The checked radio is the group's tab stop; arrow keys
 * move to the next enabled radio and check it, as a native radio group does.
 */

// MODEL

export const Model = Schema.Struct({ maybeValue: Schema.Option(Schema.String) })
export type Model = typeof Model.Type

export const init = (value?: string): Model => ({ maybeValue: Option.fromNullishOr(value) })

// MESSAGE

export const Message = defineMessageUnion({
	SelectedRadio: { value: Schema.String },
	PressedArrowKey: { value: Schema.String, id: Schema.String },
	CompletedFocusRadio: {},
})
export type Message = typeof Message.Type

// COMMAND

export const FocusRadio = Command.define("FocusRadio", {
	args: { id: Schema.String },
	messages: [Message.CompletedFocusRadio],
	execute: ({ id }) =>
		Dom.focus(`#${CSS.escape(id)}`).pipe(Effect.ignore, Effect.as(Message.CompletedFocusRadio())),
})

// UPDATE

export const update = (model: Model, message: Message): Update.Return<Model, Message> =>
	Message.match<Update.Return<Model, Message>>(message, {
		SelectedRadio: ({ value }) => ({
			model: modifyFields(model, { maybeValue: () => Option.some(value) }),
		}),
		PressedArrowKey: ({ value, id }) => ({
			model: modifyFields(model, { maybeValue: () => Option.some(value) }),
			commands: [FocusRadio({ id })],
		}),
		CompletedFocusRadio: () => ({ model }),
	})

// VIEW

export type RadioItem = Readonly<{ value: string; id: string; inputId: string; isDisabled?: boolean }>

export type RadioGroupViewConfig<ParentMessage> = Readonly<{
	model: Model
	toParentMessage: (message: Message) => ParentMessage
	items: ReadonlyArray<RadioItem>
}>

/** `<RadioGroup>`: the `role="radiogroup"` container. */
export const radioGroup = <ParentMessage>(
	h: HtmlBuilder<ParentMessage>,
	options: Readonly<{ label?: string; className?: string }>,
	children: ReadonlyArray<Html>,
): Html =>
	h.div(
		[
			...(options.label === undefined ? [] : [h.AriaLabel(options.label)]),
			h.Class(cn(radioGroupStyles, options.className)),
			h.DataAttribute("slot", "radio-group"),
			h.Role("radiogroup"),
		],
		children,
	)

const isChecked = (model: Model, value: string) => Option.contains(model.maybeValue, value)

/** The tab stop: the checked radio, else the first enabled one. */
const tabStop = (config: RadioGroupViewConfig<unknown>): Option.Option<string> =>
	Option.isSome(config.model.maybeValue)
		? config.model.maybeValue
		: Option.map(
				Option.fromNullishOr(config.items.find((item) => item.isDisabled !== true)),
				(item) => item.value,
			)

const arrowTarget = (
	config: RadioGroupViewConfig<unknown>,
	value: string,
	key: string,
): Option.Option<RadioItem> => {
	const enabled = config.items.filter((item) => item.isDisabled !== true)
	const index = enabled.findIndex((item) => item.value === value)
	const step =
		key === "ArrowRight" || key === "ArrowDown" ? 1 : key === "ArrowLeft" || key === "ArrowUp" ? -1 : 0
	if (step === 0 || index === -1) return Option.none()
	return Option.fromNullishOr(enabled[(index + step + enabled.length) % enabled.length])
}

export const labelId = labelIdOf

/**
 * `<Radio>`: the `role="radio"` span, its indicator while checked, and the hidden native radio.
 * `primitive` is `RadioPrimitive.Root` with its own classes and children (no label, slot or indicator).
 */
export const radio = <ParentMessage>(
	h: HtmlBuilder<ParentMessage>,
	config: RadioGroupViewConfig<ParentMessage>,
	value: string,
	className?: string,
	primitive?: Readonly<{ children: ReadonlyArray<Html | string> }>,
): ReadonlyArray<Html> => {
	const item = config.items.find((candidate) => candidate.value === value)
	if (item === undefined) return []
	const isDisabled = item.isDisabled ?? false
	const checked = isChecked(config.model, value)
	const isTabStop = !isDisabled && Option.contains(tabStop(config), value)
	const select = config.toParentMessage(Message.SelectedRadio({ value }))
	const stateAttribute = h.DataAttribute(checked ? "checked" : "unchecked", "")
	return [
		h.span(
			[
				h.Id(item.id),
				h.Role("radio"),
				h.AriaChecked(checked),
				...(primitive === undefined ? [h.AriaLabelledBy(labelIdOf(item.inputId))] : []),
				...(isDisabled ? [h.AriaDisabled(true), h.DataAttribute("disabled", "")] : []),
				h.Class(primitive === undefined ? cn(radioStyles, className) : (className ?? "")),
				stateAttribute,
				...(checked ? [h.DataAttribute("composite-item-active", "")] : []),
				...(primitive === undefined ? [h.DataAttribute("slot", "radio")] : []),
				h.Tabindex(isTabStop ? 0 : -1),
				...(isDisabled
					? []
					: [
							h.OnClick(select, { defaultAction: "Prevent" }),
							h.OnKeyDownPreventDefault((key) =>
								Option.orElse(toggleKey(key, select), () =>
									Option.map(arrowTarget(config, value, key), (target) =>
										config.toParentMessage(
											Message.PressedArrowKey({ value: target.value, id: target.id }),
										),
									),
								),
							),
						]),
			],
			primitive !== undefined
				? primitive.children
				: checked
				? [
						h.span([
							h.Class(radioIndicatorStyles),
							stateAttribute,
							h.DataAttribute("slot", "radio-indicator"),
						]),
					]
				: [],
		),
		hiddenInput(h, {
			id: item.inputId,
			type: "radio",
			value,
			isChecked: checked,
			isDisabled,
			onActivate: Option.some(select),
		}),
	]
}
