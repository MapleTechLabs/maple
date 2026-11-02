import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"

// `ChoiceCard`: a whole card that picks an option, over a visually hidden native radio or checkbox
// (the onboarding and connect pickers). The card owns frame, hover, checked tint and focus ring;
// `className` owns its layout (direction, gap, padding).

const FRAME =
	"flex h-full rounded-md border transition-colors duration-150 motion-reduce:transition-none peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-background"

const UNCHECKED = "border-border group-hover:border-border-strong group-hover:bg-surface-faint"

const CHECKED = "border-primary bg-primary-a1"

const CHECK_BOX = "flex size-4 shrink-0 items-center justify-center rounded-sm border"

/**
 * The 16px square a choice card draws its tick in, filled primary while checked. `drawn` is for a
 * tick drawn by stroke: the fill eases with it and the empty box firms on the card's hover.
 */
export const choiceCheckClass = (isChecked: boolean, drawn = false, className?: string | false): string =>
	cn(
		CHECK_BOX,
		drawn && "transition-[color,background-color,border-color,opacity] duration-150 motion-reduce:transition-none",
		isChecked
			? "border-primary bg-primary text-primary-foreground"
			: drawn
				? "border-input bg-background group-hover:border-border-strong"
				: "border-input",
		className,
	)

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
