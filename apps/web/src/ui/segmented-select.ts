import { cn } from "@maple/ui/lib/utils"
import { toggleVariants } from "@maple/ui/styles/ui/toggle"
import {
	toggleGroupHorizontalStyles,
	toggleGroupStandaloneStyles,
	toggleGroupStyles,
	toggleGroupTrackStyles,
} from "@maple/ui/styles/ui/toggle-group"
import type { Html, HtmlBuilder } from "foldkit/html"
import { icon } from "./icon"
import { segmentItemHeight, togglePrimitive } from "./toggle"

export type MultiSegmentedOption<T extends string> = Readonly<{
	value: T
	label: Html | string
	/** The option's accessible name (`optionAriaLabel`: the value when the label is not text). */
	ariaLabel: string
	icon?: Html
	isDisabled?: boolean
}>

/** `MultiSegmentedSelect`: standalone outline toggles; a pressed one swaps its icon for a check. */
export const multiSegmentedSelect = <T extends string, M>(
	h: HtmlBuilder<M>,
	config: Readonly<{
		options: ReadonlyArray<MultiSegmentedOption<T>>
		value: ReadonlyArray<T>
		onToggle: (value: T) => M
		size?: "sm" | "default"
		ariaLabel?: string
		isDisabled?: boolean
		className?: string
	}>,
): Html => {
	const size = config.size ?? "default"
	const isDisabled = config.isDisabled ?? false
	return h.div(
		[
			...(config.ariaLabel === undefined ? [] : [h.AriaLabel(config.ariaLabel)]),
			h.Class(
				cn(
					toggleGroupStyles,
					toggleGroupHorizontalStyles,
					toggleGroupStandaloneStyles,
					config.className,
				),
			),
			...(isDisabled ? [h.DataAttribute("disabled", "")] : []),
			h.DataAttribute("multiple", ""),
			h.DataAttribute("orientation", "horizontal"),
			h.DataAttribute("size", size),
			h.DataAttribute("slot", "toggle-group"),
			h.DataAttribute("variant", "outline"),
			h.Role("group"),
		],
		config.options.map((option, index) => {
			const isSelected = config.value.includes(option.value)
			const isOptionDisabled = isDisabled || (option.isDisabled ?? false)
			return togglePrimitive(
				h,
				{
					isPressed: isSelected,
					isDisabled: isOptionDisabled,
					onClick: config.onToggle(option.value),
					className: cn(
						toggleVariants({
							size,
							variant: "outline",
							className: cn(
								"transition-colors",
								isSelected &&
									"border-primary/70 data-pressed:border-primary/70 data-pressed:bg-primary/10 data-pressed:text-foreground hover:bg-primary/15 dark:hover:bg-primary/15",
							),
						}),
					),
					slot: "toggle",
					tabIndex: index === 0 ? 0 : -1,
					attributes: [
						h.AriaDisabled(isOptionDisabled),
						h.AriaLabel(option.ariaLabel),
						h.DataAttribute("size", size),
						h.DataAttribute("variant", "outline"),
					],
				},
				[
					...(option.icon !== undefined || isSelected
						? [
								h.span(
									[h.Class("flex size-3.5 shrink-0 items-center justify-center")],
									[
										isSelected
											? icon(h, "CheckIcon", {
													className: "size-3.5 text-primary opacity-100",
												})
											: (option.icon ?? h.empty),
									],
								),
							]
						: []),
					option.label,
				],
			)
		}),
	)
}

// The segmented select: an `outline`
// ToggleGroup track with one raised pill. Stateless: the value is the caller's (often the URL).
// TODO(motion): slide the pill between items; it jumps.

/** An icon-only option passes `label: ""`, its `icon` and an `ariaLabel`. */
export type SegmentedOption<T extends string> = Readonly<{
	value: T
	label: string
	icon?: Html
	ariaLabel?: string
	/** `disabled`: shown, not selectable. */
	isDisabled?: boolean
}>

export type SegmentedSelectConfig<T extends string, M> = Readonly<{
	options: ReadonlyArray<SegmentedOption<T>>
	value: T
	onChange: (value: T) => M
	size?: "xs" | "sm" | "default"
	ariaLabel?: string
	className?: string
}>

const XS_ITEM = "text-2xs sm:text-2xs"

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
					isDisabled: option.isDisabled,
					onClick: config.onChange(option.value),
					className: cn(
						toggleVariants({
							size: groupSize,
							variant: "segment",
							className: cn(
								"relative",
								segmentItemHeight[size],
								size === "xs" && XS_ITEM,
								"data-pressed:border-transparent data-pressed:bg-transparent data-pressed:shadow-none dark:data-pressed:bg-transparent",
							),
						}),
					),
					slot: "toggle",
					tabIndex: isSelected ? 0 : -1,
					attributes: [
						h.AriaDisabled(option.isDisabled ?? false),
						h.AriaLabel(option.ariaLabel ?? option.label),
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
					...(option.icon === undefined ? [] : [option.icon]),
					...(option.label === "" ? [] : [option.label]),
				],
			)
		}),
	)
}
