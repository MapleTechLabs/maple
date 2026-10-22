import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { field, fieldDescription, fieldLabel, type FieldIds } from "../../../ui/field"
import type { FieldState } from "../../../ui/input"
import { inputGroup, inputGroupAddon, inputGroupInput, inputGroupText } from "../../../ui/input-group"
import type { Message } from "./message"

// `NumberField` and `NoiseRow`: a Base UI field
// holding an input group with the unit as its trailing addon.

type H = HtmlBuilder<Message>

export const NUMERIC_CONTROL_CLASS =
	"font-mono tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:m-0 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
export const NOISE_CONTROL_CLASS =
	"font-mono tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"

/** Base UI's field state from the value and the value the field mounted with. */
export const fieldStateOf = (value: string, mounted: string | undefined): FieldState => ({
	isInvalid: false,
	isDirty: mounted !== undefined && value !== mounted,
	isFilled: value !== "",
	isFocused: false,
	isTouched: false,
})

export const idsOf = (id: string, hasDescription: boolean): FieldIds => {
	const ids = { control: id, label: `${id}-label`, error: `${id}-error` }
	return hasDescription ? { ...ids, description: `${id}-description` } : ids
}

export type NumberFieldOptions = Readonly<{
	id: string
	label: string
	value: string
	mounted: string | undefined
	unit: string | null
	onInput: (value: string) => Message
	description?: string
	placeholder?: string
	ariaLabel?: string
	inputMode?: "decimal" | "numeric"
	controlClassName?: string
	min?: string
	/** The saved value when it differs (`previous`): the border warns and a note says what it was. */
	previous?: string | null
}>

/** `WasNote`: what a changed field was before the edit. */
export const wasNote = (h: H, children: ReadonlyArray<string>): Html =>
	h.p(
		[h.Class("text-xs text-severity-warn")],
		[
			"Was ",
			h.span(
				[h.Class("font-mono")],
				children.filter((child) => child !== ""),
			),
		],
	)

export const numberField = (h: H, options: NumberFieldOptions): Html => {
	const previous = options.previous ?? null
	const description = options.description
	const state = fieldStateOf(options.value, options.mounted)
	const ids = idsOf(options.id, description !== undefined)
	const described = ids.description
	const unit = options.unit
	return field(h, { className: "items-stretch gap-1.5", state }, [
		fieldLabel(h, { ids, state }, options.label),
		inputGroup(h, { className: cn("h-9", previous !== null && "border-severity-warn/60") }, [
			inputGroupInput(h, {
				id: options.id,
				type: "number",
				controlClassName: options.controlClassName ?? NUMERIC_CONTROL_CLASS,
				fieldState: state,
				attributes: [
					...(described === undefined ? [] : [h.AriaDescribedBy(described)]),
					...(options.ariaLabel === undefined ? [] : [h.AriaLabel(options.ariaLabel)]),
					h.AriaLabelledBy(ids.label),
					h.InputMode(options.inputMode ?? "decimal"),
					...(options.min === undefined ? [] : [h.Min(options.min)]),
					...(options.placeholder === undefined ? [] : [h.Placeholder(options.placeholder)]),
					h.Value(options.value),
					h.OnInput(options.onInput),
				],
			}),
			...(unit === null
				? []
				: [inputGroupAddon(h, { align: "inline-end" }, [inputGroupText(h, {}, [unit])])]),
		]),
		...(previous === null
			? []
			: [
					wasNote(h, [
						previous.length > 0 ? previous : "none",
						previous.length > 0 && unit !== null ? (unit === "%" ? "%" : ` ${unit}`) : "",
					]),
				]),
		...(description === undefined ? [] : [fieldDescription(h, { ids, state }, description)]),
	])
}
