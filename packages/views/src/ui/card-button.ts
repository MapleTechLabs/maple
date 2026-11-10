import { cn } from "@maple/ui/lib/utils"
import type { Attribute, ChildAttribute, Html, HtmlBuilder } from "foldkit/html"

// `CardButton`: a whole card as one click target (template tiles, source and destination pickers,
// metric cards). The card owns surface, border, hover, selection and focus; the caller's
// `className` owns layout (direction, gap, padding).

const BASE =
	"group rounded-md border bg-card text-left hover:border-border-strong active:border-border-strong hover:bg-surface-sunken active:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-64 disabled:hover:border-border disabled:active:border-border disabled:hover:bg-card disabled:active:bg-card"

const SELECTED =
	"border-primary-a4 bg-primary-a1 hover:border-primary-a4 active:border-primary-a4 hover:bg-primary-a2 active:bg-primary-a2"

export type CardButtonOptions<M> = Readonly<{
	onClick: M
	isSelected?: boolean
	isDisabled?: boolean
	/** `aria-label`, when the card's text alone does not name the action. */
	label?: string
	className?: string
	attributes?: ReadonlyArray<Attribute<M> | ChildAttribute>
}>

export const cardButtonClass = (isSelected = false, className?: string): string =>
	cn(BASE, isSelected && SELECTED, className)

export const cardButton = <M>(
	h: HtmlBuilder<M>,
	options: CardButtonOptions<M>,
	children: ReadonlyArray<Html | string>,
): Html =>
	h.button(
		[
			h.Type("button"),
			h.Class(cardButtonClass(options.isSelected, options.className)),
			h.OnClick(options.onClick),
			...(options.isSelected === undefined
				? []
				: [h.AriaPressed(options.isSelected ? "true" : "false")]),
			...((options.isDisabled ?? false) ? [h.Disabled(true)] : []),
			...(options.label === undefined ? [] : [h.AriaLabel(options.label)]),
			...(options.attributes ?? []),
		],
		children,
	)
