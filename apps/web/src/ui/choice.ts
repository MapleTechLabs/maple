import { Option } from "effect"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"

// Shared by checkbox, radio, switch, select and combobox: the parts Base UI renders the same way.

/** Base UI's `visuallyHidden` inline style on the native input it keeps beside a custom control. */
export const VISUALLY_HIDDEN_STYLE = {
	"clip-path": "inset(50%)",
	overflow: "hidden",
	"white-space": "nowrap",
	border: "0px",
	padding: "0px",
	width: "1px",
	height: "1px",
	margin: "-1px",
	position: "fixed",
	top: "0px",
	left: "0px",
} satisfies Record<string, string>

/** The id Base UI gives a wrapping `<Label>` (`<input id>-label`). */
export const labelIdOf = (inputId: string): string => `${inputId}-label`

/** Space presses a checkbox, radio or switch (keydown, so the page does not scroll). */
export const toggleKey = <Message>(key: string, message: Message): Option.Option<Message> =>
	key === " " ? Option.some(message) : Option.none()

export type HiddenInputOptions<Message> = Readonly<{
	id: string
	type?: "checkbox" | "radio"
	value?: string
	isChecked?: boolean
	isDisabled?: boolean
	/** A wrapping label's click lands here; the custom control prevents its own. */
	onActivate?: Option.Option<Message>
	attributes?: ReadonlyArray<Attribute<Message>>
}>

/** The visually hidden native input Base UI renders after a checkbox, radio, switch or select. */
export const hiddenInput = <Message>(h: HtmlBuilder<Message>, options: HiddenInputOptions<Message>): Html =>
	h.input([
		h.AriaHidden(true),
		...(options.type === undefined ? [] : [h.Checked(options.isChecked === true)]),
		...(options.isDisabled === true ? [h.Disabled(true)] : []),
		h.Id(options.id),
		h.Style(VISUALLY_HIDDEN_STYLE),
		h.Tabindex(-1),
		...(options.type === undefined ? [] : [h.Type(options.type)]),
		...(options.value === undefined ? [] : [h.Value(options.value)]),
		...Option.match(options.onActivate ?? Option.none(), {
			onNone: () => [],
			onSome: (message) => [h.OnClick(message)],
		}),
		...(options.attributes ?? []),
	])
