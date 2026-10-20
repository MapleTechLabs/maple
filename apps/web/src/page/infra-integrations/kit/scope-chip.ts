import { cn } from "@maple/ui/lib/utils"
import type { ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import { badge } from "../../../ui/display"

// `ScopeChip`: what a panel is scoped to. With an explanation it is a tooltip trigger; the page's Tooltip
// renders the explanation.

export type ScopeChipOptions = Readonly<{
	tone?: "default" | "muted"
	className?: string
	/** The Tooltip trigger attributes when the chip carries an explanation. */
	trigger?: ReadonlyArray<ChildAttribute>
}>

export const scopeChip = <M>(
	h: HtmlBuilder<M>,
	options: ScopeChipOptions,
	children: ReadonlyArray<Html | string>,
): Html => {
	const chipClass = cn(
		"bg-background/60 font-normal",
		options.tone === "muted" ? "text-muted-foreground/70" : "text-muted-foreground",
		options.className,
	)
	return options.trigger === undefined
		? badge(h, { variant: "meta", size: "xs", mono: true, className: chipClass }, children)
		: badge(
				h,
				{
					variant: "meta",
					size: "xs",
					mono: true,
					className: cn(chipClass, "cursor-default"),
					attributes: [...options.trigger, h.DataAttribute("slot", "tooltip-trigger")],
				},
				children,
			)
}
