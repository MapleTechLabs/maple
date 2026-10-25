import type { Tone } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import {
	filterChipCountStyles,
	filterChipDotOffStyles,
	filterChipPressedBorderStyles,
	filterChipVariants,
} from "@maple/ui/styles/ui/filter-chip"
import type { Attribute, ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import { statusDot } from "./status-dot"
import { togglePrimitive } from "./toggle"

export type FilterChipOptions<Message> = Readonly<{
	isPressed: boolean
	/** `onPressedChange`: the parent owns `pressed`, as in @maple/ui. */
	onClick: Message
	tone?: Tone
	size?: "xs" | "sm"
	hasDot?: boolean
	count?: string
	className?: string
	/** `data-slot` when a wrapper renders through it (`TooltipTrigger render={<FilterChip />}`). */
	slot?: string
	attributes?: ReadonlyArray<Attribute<Message> | ChildAttribute>
}>

/** `<FilterChip>`: an on/off filter toggle with an optional tone dot and trailing count. */
export const filterChip = <Message>(
	h: HtmlBuilder<Message>,
	options: FilterChipOptions<Message>,
	children: ReadonlyArray<Html | string>,
): Html => {
	const tone = options.tone ?? "neutral"
	return togglePrimitive(
		h,
		{
			isPressed: options.isPressed,
			onClick: options.onClick,
			className: cn(
				filterChipVariants({ size: options.size }),
				filterChipPressedBorderStyles[tone],
				options.className,
			),
			slot: options.slot ?? "filter-chip",
			attributes: options.attributes,
		},
		[
			...(options.hasDot === true
				? [statusDot(h, { tone, className: options.isPressed ? undefined : filterChipDotOffStyles })]
				: []),
			...children,
			...(options.count === undefined
				? []
				: [h.span([h.Class(filterChipCountStyles)], [options.count])]),
		],
	)
}
