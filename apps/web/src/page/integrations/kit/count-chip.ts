import type { Tone } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import {
	filterChipCountStyles,
	filterChipPressedBorderStyles,
	filterChipVariants,
} from "@maple/ui/styles/ui/filter-chip"
import type { HtmlBuilder } from "foldkit/html"
import { statusDot } from "../../../ui/status-dot"
import type * as ToggleGroup from "../../../ui/toggle-group"

/** A ToggleGroup item drawn as a `filterChip`: label, optional tone dot, trailing count. */
export const countChipItem = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ value: string; label: string; count: number; tone?: Tone | undefined }>,
): ToggleGroup.ToggleGroupItem => ({
	value: options.value,
	label: options.label,
	className: cn(
		filterChipVariants({ size: "xs" }),
		filterChipPressedBorderStyles[options.tone ?? "neutral"],
	),
	children: [
		...(options.tone === undefined ? [] : [statusDot(h, { tone: options.tone })]),
		options.label,
		h.span([h.Class(filterChipCountStyles)], [String(options.count)]),
	],
})
