import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { FieldIds } from "@maple/views/ui/field"
import type { FieldState } from "@maple/views/ui/input"
import { inputGroup, inputGroupAddon, inputGroupInput, inputGroupText } from "@maple/views/ui/input-group"
import { Message } from "./message"
import { typography } from "@maple/views/ui/typography"
import { Array as Arr } from "effect"

// The editor's field helpers: Base UI's field state, and the number that sits inside a sentence row.

type H = HtmlBuilder<Message>

export const NUMERIC_CONTROL_CLASS =
	"font-mono tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:m-0 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"

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

export type InlineNumberOptions = Readonly<{
	id: string
	/** The field's name: a sentence row has no label element, the words around it are its label. */
	ariaLabel: string
	value: string
	mounted: string | undefined
	/** A unit read as part of the number ("%", "ms"); a word unit is written after the field. */
	unit?: string | null
	onInput: (value: string) => Message
	placeholder?: string
	inputMode?: "decimal" | "numeric"
	min?: string
	/** The saved value when it differs (`previous`): the border warns. */
	previous?: string | null
	/** The field has an error the user has seen a reason for (left it, or tried to save). */
	isInvalid?: boolean
	className?: string
}>

/** A number inside a sentence row: about 96px wide, 32px tall (36px on a phone). */
export const inlineNumber = (h: H, options: InlineNumberOptions): Html => {
	const unit = options.unit ?? null
	const state = { ...fieldStateOf(options.value, options.mounted), isInvalid: options.isInvalid ?? false }
	return inputGroup(
		h,
		{
			className: cn(
				"h-9 w-24 shrink-0 sm:h-8",
				options.className,
				(options.previous ?? null) !== null && "border-severity-warn/60",
			),
		},
		[
			inputGroupInput(h, {
				id: options.id,
				type: "number",
				controlClassName: NUMERIC_CONTROL_CLASS,
				fieldState: state,
				attributes: [
					h.AriaLabel(options.ariaLabel),
					...(state.isInvalid ? [h.AriaInvalid(true)] : []),
					h.InputMode(options.inputMode ?? "decimal"),
					...(options.min === undefined ? [] : [h.Min(options.min)]),
					...(options.placeholder === undefined ? [] : [h.Placeholder(options.placeholder)]),
					h.Value(options.value),
					h.OnInput(options.onInput),
					h.OnBlur(Message.BlurredField({ id: options.id })),
				],
			}),
			...(unit === null
				? []
				: [inputGroupAddon(h, { align: "inline-end" }, [inputGroupText(h, {}, [unit])])]),
		],
	)
}

/** Under a sentence row: what each changed field was before the edit ("Threshold was 5%"). */
export const wasLine = (
	h: H,
	changes: ReadonlyArray<Readonly<{ label: string; previous: string | null; unit?: string | null }>>,
): ReadonlyArray<Html> =>
	Arr.flatMap(changes, (change) => {
		const previous = change.previous
		if (previous === null) return []
		const unit = change.unit ?? null
		const suffix = previous.length > 0 && unit !== null ? (unit === "%" ? "%" : ` ${unit}`) : ""
		return [
			typography(h, { size: "xs", tone: "warning", as: "p" }, [
				`${change.label} was `,
				typography(h, { mono: true }, [previous.length > 0 ? `${previous}${suffix}` : "none"]),
			]),
		]
	})
