import { cn } from "@maple/ui/lib/utils"
import type { Attribute, ChildAttribute, Html, HtmlBuilder } from "foldkit/html"

// `CardButton`: a whole card as one click target (template tiles, source and destination pickers,
// metric cards). The card owns surface, border, hover, selection and focus; the caller's
// `className` owns layout (direction, gap, padding).

const BASE =
	"group rounded-md border bg-card text-left transition-colors hover:border-ring/50 hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-border disabled:hover:bg-card"

const SELECTED = "border-primary/60 bg-primary/5 hover:border-primary/60 hover:bg-primary/5"

export type CardButtonOptions<M> = Readonly<{
	onClick: M
	isSelected?: boolean
	isDisabled?: boolean
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
			...(options.attributes ?? []),
		],
		children,
	)
