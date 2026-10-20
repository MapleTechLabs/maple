import { cn } from "@maple/ui/lib/utils"
import { refreshButtonIconPendingStyles, refreshButtonIconStyles } from "@maple/ui/styles/ui/refresh-button"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "./button"
import { icon } from "./icon"

export type RefreshButtonOptions<Message> = Readonly<{
	onRefresh: Message
	isPending?: boolean
	isIconOnly?: boolean
	label?: string
	size?: "xs" | "sm" | "default"
	variant?: "default" | "secondary" | "outline" | "ghost"
	isDisabled?: boolean
	className?: string
	/** Base UI's `useId` for the tooltip trigger of the icon-only form. */
	triggerId?: string
}>

/**
 * `<RefreshButton>`: the icon spins while pending and the button disables.
 * TODO(tooltip): the icon-only form renders the tooltip trigger only; the popup is the overlay port's.
 */
export const refreshButton = <Message>(
	h: HtmlBuilder<Message>,
	options: RefreshButtonOptions<Message>,
): Html => {
	const isPending = options.isPending ?? false
	const label = options.label ?? "Refresh"
	const size = options.size ?? "sm"
	const glyph = icon(h, "ArrowRotateAnticlockwiseIcon", {
		className: cn(refreshButtonIconStyles, isPending && refreshButtonIconPendingStyles),
	})
	const common = [...(isPending ? [h.AriaBusy(true)] : []), h.OnClick(options.onRefresh)]
	const isDisabled = (options.isDisabled ?? false) || isPending
	if (options.isIconOnly === true) {
		return button(
			h,
			{
				size: size === "default" ? "icon" : size === "sm" ? "icon-sm" : "icon-xs",
				variant: options.variant ?? "outline",
				isDisabled,
				// TooltipTrigger's `data-slot` overrides Button's.
				slot: "tooltip-trigger",
				attributes: [
					...common,
					h.AriaLabel(label),
					h.DataAttribute("base-ui-tooltip-trigger", ""),
					...(options.triggerId === undefined ? [] : [h.Id(options.triggerId)]),
				],
			},
			[glyph],
		)
	}
	return button(
		h,
		{
			size,
			variant: options.variant ?? "outline",
			isDisabled,
			className: options.className,
			attributes: common,
		},
		[glyph, h.span([], [label])],
	)
}
