import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"

// `ChoiceCard`: a whole card that picks an option, over a visually hidden native radio or checkbox
// (the onboarding and connect pickers). The card owns frame, hover, checked tint and focus ring;
// `className` owns its layout (direction, gap, padding).

const FRAME =
	"flex h-full rounded-md border transition-colors duration-150 motion-reduce:transition-none peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-background"

const UNCHECKED = "border-border group-hover:border-border-strong group-hover:bg-surface-faint"

const CHECKED = "border-primary bg-primary-a1"

export type ChoiceCardOptions<M> = Readonly<{
	type: "radio" | "checkbox"
	/** The radio group's `name`. */
	name?: string
	isChecked: boolean
	isDisabled?: boolean
	/** The hidden input's `aria-label`. */
	label: string
	onChange: M
	className?: string
}>

export const choiceCard = <M>(
	h: HtmlBuilder<M>,
	options: ChoiceCardOptions<M>,
	children: ReadonlyArray<Html | string>,
): Html =>
	h.label(
		[h.Class("group relative cursor-pointer")],
		[
			h.input([
				h.Type(options.type),
				...(options.name === undefined ? [] : [h.Name(options.name)]),
				h.Class("peer sr-only"),
				h.Checked(options.isChecked),
				...(options.isDisabled === true ? [h.Disabled(true)] : []),
				h.AriaLabel(options.label),
				h.OnChange(() => options.onChange),
			]),
			h.div([h.Class(cn(FRAME, options.className, options.isChecked ? CHECKED : UNCHECKED))], children),
		],
	)
