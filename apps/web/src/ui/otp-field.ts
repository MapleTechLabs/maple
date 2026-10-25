import { cn } from "@maple/ui/lib/utils"
import { otpFieldInputStyles, otpFieldSeparatorStyles, otpFieldStyles } from "@maple/ui/styles/ui/otp-field"
import { Effect, Option, Schema } from "effect"
import { Command, Dom, type Update } from "foldkit"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { modifyFields } from "foldkit/struct"
import { VISUALLY_HIDDEN_STYLE } from "./choice"
import { separator } from "./display"

/**
 * Base UI `OTPField`: one digit per slot. Typing fills from the slot and moves focus on,
 * Backspace on an empty slot clears the previous one. The hidden input carries the joined code.
 */

// MODEL

/** Base UI's `validationType`: which characters a slot accepts. */
export const Validation = Schema.Literals(["numeric", "alphanumeric"])
export type Validation = typeof Validation.Type

export const Model = Schema.Struct({
	id: Schema.String,
	slots: Schema.Array(Schema.String),
	validation: Validation,
	/** `normalizeValue={(value) => value.toUpperCase()}`. */
	isUppercase: Schema.Boolean,
})
export type Model = typeof Model.Type

export const init = (config: {
	id: string
	length: number
	value?: string
	validation?: Validation
	isUppercase?: boolean
}): Model => ({
	id: config.id,
	slots: Array.from({ length: config.length }, (_, index) => config.value?.[index] ?? ""),
	validation: config.validation ?? "numeric",
	isUppercase: config.isUppercase ?? false,
})

/** Every slot is filled (Base UI's `complete` state). */
export const isComplete = (model: Model): boolean => model.slots.every((slot) => slot !== "")

const REJECTED = { numeric: /\D/g, alphanumeric: /[^a-zA-Z0-9]/g } as const
const SLOT_PATTERN = { numeric: "\\d", alphanumeric: "[a-zA-Z0-9]" } as const
const INPUT_MODE = { numeric: "numeric", alphanumeric: "text" } as const

const normalize = (model: Model, text: string): string => {
	const valid = text.replace(REJECTED[model.validation], "")
	return model.isUppercase ? valid.toUpperCase() : valid
}

export const valueOf = (model: Model): string => model.slots.join("")

// MESSAGE

export const Message = defineMessageUnion({
	EnteredText: { index: Schema.Finite, text: Schema.String },
	PressedBackspace: { index: Schema.Finite },
	CompletedFocusSlot: {},
})
export type Message = typeof Message.Type

// COMMAND

/** Base UI ids: the first slot is the field id, the rest `<id>-<n>`. */
export const slotId = (id: string, index: number): string => (index === 0 ? id : `${id}-${index + 1}`)

export const FocusSlot = Command.define("FocusOtpSlot", {
	args: { id: Schema.String },
	messages: [Message.CompletedFocusSlot],
	execute: ({ id }) =>
		Dom.focus(`#${CSS.escape(id)}`).pipe(Effect.ignore, Effect.as(Message.CompletedFocusSlot())),
})

// UPDATE

const focusSlot = (model: Model, index: number) =>
	FocusSlot({ id: slotId(model.id, Math.max(0, Math.min(index, model.slots.length - 1))) })

export const update = (model: Model, message: Message): Update.Return<Model, Message> =>
	Message.match<Update.Return<Model, Message>>(message, {
		EnteredText: ({ index, text }) => {
			const digits = normalize(model, text)
				.split("")
				.slice(0, model.slots.length - index)
			if (digits.length === 0) {
				return {
					model: modifyFields(model, {
						slots: (slots) => slots.map((slot, i) => (i === index ? "" : slot)),
					}),
				}
			}
			return {
				model: modifyFields(model, {
					slots: (slots) =>
						slots.map((slot, i) =>
							i >= index && i < index + digits.length ? (digits[i - index] ?? slot) : slot,
						),
				}),
				commands: [focusSlot(model, index + digits.length)],
			}
		},
		PressedBackspace: ({ index }) => {
			if (model.slots[index] !== "" || index === 0) return { model }
			return {
				model: modifyFields(model, {
					slots: (slots) => slots.map((slot, i) => (i === index - 1 ? "" : slot)),
				}),
				commands: [focusSlot(model, index - 1)],
			}
		},
		CompletedFocusSlot: () => ({ model }),
	})

// VIEW

export type OtpFieldViewConfig<ParentMessage> = Readonly<{
	model: Model
	toParentMessage: (message: Message) => ParentMessage
	/** The group's `aria-label`, or `labelledBy`: the id of a `<Label>` naming the field. */
	label?: string
	labelledBy?: string
	/** `aria-invalid` on the group. */
	isInvalid?: boolean
	size?: "default" | "lg"
	className?: string
}>

/** Base UI's `data-complete` / `data-filled` state attributes. */
const fillAttributes = <M>(h: HtmlBuilder<M>, model: Model, isFilled: boolean) => [
	...(isComplete(model) ? [h.DataAttribute("complete", "")] : []),
	...(isFilled ? [h.DataAttribute("filled", "")] : []),
]

/** The roving tab stop: the first empty slot, else the last. */
const activeIndex = (model: Model): number => {
	const empty = model.slots.indexOf("")
	return empty === -1 ? model.slots.length - 1 : empty
}

/** `<OTPField>`: the slot group, then Base UI's hidden input holding the whole code. */
export const otpField = <ParentMessage>(
	h: HtmlBuilder<ParentMessage>,
	config: OtpFieldViewConfig<ParentMessage>,
	children: ReadonlyArray<Html>,
): ReadonlyArray<Html> => {
	const length = config.model.slots.length
	return [
		h.div(
			[
				...(config.label === undefined ? [] : [h.AriaLabel(config.label)]),
				...(config.isInvalid === undefined ? [] : [h.AriaInvalid(config.isInvalid)]),
				...(config.labelledBy === undefined ? [] : [h.AriaLabelledBy(config.labelledBy)]),
				h.Class(cn(otpFieldStyles, config.className)),
				...fillAttributes(h, config.model, config.model.slots.some((slot) => slot !== "")),
				h.DataAttribute("size", config.size ?? "default"),
				h.DataAttribute("slot", "otp-field"),
				h.Role("group"),
			],
			children,
		),
		h.input([
			h.AriaHidden(true),
			h.Autocomplete("one-time-code"),
			h.Id(`${config.model.id}-hidden-input`),
			h.InputMode(INPUT_MODE[config.model.validation]),
			h.Maxlength(length),
			h.Attribute("minlength", String(length)),
			h.Pattern(`${SLOT_PATTERN[config.model.validation]}{${length}}`),
			h.Style(VISUALLY_HIDDEN_STYLE),
			h.Tabindex(-1),
			h.Type("text"),
			h.Value(valueOf(config.model)),
		]),
	]
}

/** `<OTPFieldInput>` for slot `index`. */
export const otpFieldInput = <ParentMessage>(
	h: HtmlBuilder<ParentMessage>,
	config: OtpFieldViewConfig<ParentMessage>,
	index: number,
	className?: string,
	/** `<OTPFieldInput aria-label>`: the slots after the first name their position. */
	attributes: ReadonlyArray<Attribute<ParentMessage>> = [],
): Html => {
	const { model, toParentMessage } = config
	const length = model.slots.length
	const slot = model.slots[index] ?? ""
	return h.input([
		...(index === 0 && config.labelledBy !== undefined ? [h.AriaLabelledBy(config.labelledBy)] : []),
		...attributes,
		h.Autocomplete(index === 0 ? "one-time-code" : "off"),
		h.Autocorrect("off"),
		h.Class(cn(otpFieldInputStyles, className)),
		...fillAttributes(h, model, slot !== ""),
		h.DataAttribute("length", String(length)),
		h.DataAttribute("slot", "otp-field-input"),
		h.EnterKeyHint(index === length - 1 ? "done" : "next"),
		h.Id(slotId(model.id, index)),
		h.InputMode(INPUT_MODE[model.validation]),
		...(index === 0 ? [h.Maxlength(length)] : []),
		h.Pattern(`${SLOT_PATTERN[model.validation]}{1}`),
		h.Spellcheck(false),
		h.Tabindex(index === activeIndex(model) ? 0 : -1),
		h.Type("text"),
		h.Value(slot),
		h.OnInput((text) => toParentMessage(Message.EnteredText({ index, text }))),
		// Only an empty slot's Backspace is ours; a filled slot deletes its digit natively.
		h.OnKeyDownPreventDefault((key) =>
			key === "Backspace" && slot === "" && index > 0
				? Option.some(toParentMessage(Message.PressedBackspace({ index })))
				: Option.none(),
		),
	])
}

/** `<OTPFieldSeparator>`: a short horizontal rule between slot groups. */
export const otpFieldSeparator = <M>(h: HtmlBuilder<M>, className?: string): Html =>
	separator(h, "horizontal", cn(otpFieldSeparatorStyles, className))
