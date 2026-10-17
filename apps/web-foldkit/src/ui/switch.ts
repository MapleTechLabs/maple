import { cn } from "@maple/ui/lib/utils"
import { switchStyles, switchThumbStyles } from "@maple/ui/styles/ui/switch"
import type { Html, HtmlBuilder } from "foldkit/html"

/** Base UI's visually hidden form input that follows every Switch root. */
const HIDDEN_INPUT_STYLE = {
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
}

/** `<Switch checked onCheckedChange aria-label>`: Base UI's span root, thumb and hidden checkbox. */
export const switchControl = <Message>(
	h: HtmlBuilder<Message>,
	options: Readonly<{ id: string; isChecked: boolean; ariaLabel: string; onToggle: Message }>,
): ReadonlyArray<Html> => {
	const state = h.DataAttribute(options.isChecked ? "checked" : "unchecked", "")
	return [
		h.span(
			[
				h.AriaChecked(options.isChecked),
				h.AriaLabel(options.ariaLabel),
				h.Class(cn(switchStyles)),
				h.DataAttribute("slot", "switch"),
				state,
				h.Id(options.id),
				h.Role("switch"),
				h.Tabindex(0),
				h.OnClick(options.onToggle),
			],
			[h.span([h.Class(cn(switchThumbStyles)), h.DataAttribute("slot", "switch-thumb"), state], [])],
		),
		h.input([
			h.AriaHidden(true),
			h.Id(`${options.id}-input`),
			h.Style(HIDDEN_INPUT_STYLE),
			h.Tabindex(-1),
			h.Type("checkbox"),
			h.Checked(options.isChecked),
		]),
	]
}
