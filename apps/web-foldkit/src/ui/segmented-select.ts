import { cn } from "@maple/ui/lib/utils"
import { toggleVariants } from "@maple/ui/styles/ui/toggle"
import {
	toggleGroupHorizontalStyles,
	toggleGroupStyles,
	toggleGroupTrackStyles,
} from "@maple/ui/styles/ui/toggle-group"
import type { Html, HtmlBuilder } from "foldkit/html"
import { togglePrimitive } from "./toggle"

// Port of `SegmentedSelect` (apps/web/src/components/common/segmented-select.tsx): an `outline`
// ToggleGroup track with one raised pill. Stateless: the value is the caller's (often the URL).
// TODO(motion): legacy slides the pill between items (motion `layoutId`); here it jumps.

export type SegmentedOption<T extends string> = Readonly<{ value: T; label: string }>

export type SegmentedSelectConfig<T extends string, M> = Readonly<{
	options: ReadonlyArray<SegmentedOption<T>>
	value: T
	onChange: (value: T) => M
	size?: "xs" | "sm" | "default"
	ariaLabel?: string
	className?: string
}>

const XS_ITEM = "h-6 text-2xs sm:h-6 sm:text-2xs"

export const segmentedSelect = <T extends string, M>(
	h: HtmlBuilder<M>,
	config: SegmentedSelectConfig<T, M>,
): Html => {
	const size = config.size ?? "default"
	const groupSize = size === "xs" ? "sm" : size
	return h.div(
		[
			h.Role("group"),
			...(config.ariaLabel === undefined ? [] : [h.AriaLabel(config.ariaLabel)]),
			h.Class(
				cn(toggleGroupStyles, toggleGroupHorizontalStyles, toggleGroupTrackStyles, config.className),
			),
			h.DataAttribute("orientation", "horizontal"),
			h.DataAttribute("size", groupSize),
			h.DataAttribute("slot", "toggle-group"),
			h.DataAttribute("variant", "outline"),
		],
		config.options.map((option) => {
			const isSelected = option.value === config.value
			return togglePrimitive(
				h,
				{
					isPressed: isSelected,
					onClick: config.onChange(option.value),
					className: cn(
						toggleVariants({
							size: groupSize,
							variant: "segment",
							className: cn(
								"relative",
								size === "xs" && XS_ITEM,
								"data-pressed:border-transparent data-pressed:bg-transparent data-pressed:shadow-none dark:data-pressed:bg-transparent",
							),
						}),
					),
					slot: "toggle",
					tabIndex: isSelected ? 0 : -1,
					attributes: [
						h.AriaDisabled(false),
						h.AriaLabel(option.label),
						h.DataAttribute("size", groupSize),
						h.DataAttribute("variant", "segment"),
					],
				},
				[
					...(isSelected
						? [
								h.span(
									[
										h.AriaHidden(true),
										h.Class(
											"-z-10 absolute inset-0 rounded-md bg-background shadow-sm ring-1 ring-border/70 dark:bg-input dark:ring-white/10",
										),
										h.Style({ opacity: "1" }),
									],
									[],
								),
							]
						: []),
					option.label,
				],
			)
		}),
	)
}
