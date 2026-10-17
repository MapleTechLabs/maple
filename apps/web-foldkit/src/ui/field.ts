import { cn } from "@maple/ui/lib/utils"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"

// Class lists copied from packages/ui/src/components/ui/{field,input}.tsx (React modules).
// Phase 1 moves them to shared framework-free *.styles.ts files.
const FIELD = "flex flex-col items-start gap-2"
const FIELD_LABEL =
	"inline-flex items-center gap-2 font-medium text-base/4.5 text-foreground data-disabled:opacity-64 sm:text-sm/4"
const FIELD_ERROR = "text-destructive-foreground text-xs"
const CONTROL_LAYOUT = "relative inline-flex w-full"
const CONTROL_CHROME =
	"rounded-lg border border-input bg-background not-dark:bg-clip-padding text-base text-foreground shadow-xs/5 ring-ring/24 transition-shadow before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] not-has-disabled:not-has-focus-visible:not-has-aria-invalid:before:shadow-[0_1px_--theme(--color-black/4%)] has-focus-visible:has-aria-invalid:border-destructive/64 has-focus-visible:has-aria-invalid:ring-destructive/16 has-aria-invalid:border-destructive/36 has-focus-visible:border-ring has-autofill:bg-foreground/4 has-disabled:opacity-64 has-[:disabled,:focus-visible,[aria-invalid]]:shadow-none has-focus-visible:ring-[3px] sm:text-sm dark:bg-input/32 dark:has-autofill:bg-foreground/8 dark:has-aria-invalid:ring-destructive/24 dark:not-has-disabled:not-has-focus-visible:not-has-aria-invalid:before:shadow-[0_-1px_--theme(--color-white/6%)]"
const INPUT =
	"h-8.5 w-full min-w-0 rounded-[inherit] px-[calc(--spacing(3)-1px)] leading-8.5 outline-none [transition:background-color_5000000s_ease-in-out_0s] placeholder:text-muted-foreground/72 sm:h-7.5 sm:leading-7.5"

/** Base UI's field state, which it mirrors as data attributes on every field part. */
export type FieldState = Readonly<{
	isInvalid: boolean
	isDirty: boolean
	isFilled: boolean
	isFocused: boolean
	isTouched: boolean
}>

const stateAttributes = <Message>(h: HtmlBuilder<Message>, state: FieldState): ReadonlyArray<Attribute<Message>> => [
	...(state.isDirty ? [h.DataAttribute("dirty", "")] : []),
	...(state.isFilled ? [h.DataAttribute("filled", "")] : []),
	...(state.isFocused ? [h.DataAttribute("focused", "")] : []),
	...(state.isInvalid ? [h.DataAttribute("invalid", "")] : []),
	...(state.isTouched ? [h.DataAttribute("touched", "")] : []),
]

/** Base UI `Field.Root`. */
export const field = <Message>(
	h: HtmlBuilder<Message>,
	options: Readonly<{ className?: string; state: FieldState }>,
	children: ReadonlyArray<Html>,
): Html =>
	h.div(
		[h.DataAttribute("slot", "field"), h.Class(cn(FIELD, options.className)), ...stateAttributes(h, options.state)],
		children,
	)

export type FieldIds = Readonly<{ control: string; label: string; error: string }>

/** Base UI `Field.Label`, wired to the control by id. */
export const fieldLabel = <Message>(
	h: HtmlBuilder<Message>,
	options: Readonly<{ ids: FieldIds; className?: string; state: FieldState }>,
	text: string,
): Html =>
	h.label(
		[
			h.Id(options.ids.label),
			h.For(options.ids.control),
			h.DataAttribute("slot", "field-label"),
			h.Class(cn(FIELD_LABEL, options.className)),
			...stateAttributes(h, options.state),
		],
		[text],
	)

/** `<Input>` inside a Base UI field: the control wrapper and the labelled native input. */
export const input = <Message>(
	h: HtmlBuilder<Message>,
	options: Readonly<{ ids: FieldIds; state: FieldState; attributes: ReadonlyArray<Attribute<Message>> }>,
): Html =>
	h.span(
		[
			h.Class(cn(CONTROL_LAYOUT, CONTROL_CHROME)),
			h.DataAttribute("size", "default"),
			h.DataAttribute("slot", "input-control"),
		],
		[
			h.input([
				h.Id(options.ids.control),
				h.DataAttribute("slot", "input"),
				...options.attributes,
				h.Class(cn(INPUT)),
				h.AriaLabelledBy(options.ids.label),
				...(options.state.isInvalid ? [h.AriaInvalid(true), h.AriaDescribedBy(options.ids.error)] : []),
				...stateAttributes(h, options.state),
			]),
		],
	)

/** Base UI `Field.Error` with `match`: always shown while rendered. */
export const fieldError = <Message>(
	h: HtmlBuilder<Message>,
	options: Readonly<{ ids: FieldIds; className?: string; state: FieldState }>,
	text: string,
): Html =>
	h.div(
		[
			h.Id(options.ids.error),
			h.DataAttribute("slot", "field-error"),
			h.Role("alert"),
			h.Class(cn(FIELD_ERROR, options.className)),
			...stateAttributes(h, options.state),
		],
		[text],
	)
