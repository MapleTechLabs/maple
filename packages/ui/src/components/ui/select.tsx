"use client"

import { mergeProps } from "@base-ui/react/merge-props"
import { Select as SelectPrimitive } from "@base-ui/react/select"
import { useRender } from "@base-ui/react/use-render"
import type { VariantProps } from "class-variance-authority"
import { CheckIcon, ChevronDownIcon, ChevronExpandYIcon, ChevronUpIcon } from "../icons"
import type * as React from "react"
import { cn } from "../../lib/utils"
import {
	selectButtonStyles,
	selectButtonValueStyles,
	selectGroupLabelStyles,
	selectItemIndicatorIconStyles,
	selectItemIndicatorStyles,
	selectItemStyles,
	selectItemTextStyles,
	selectLabelStyles,
	selectListStyles,
	selectPopupStyles,
	selectPopupSurfaceStyles,
	selectPositionerStyles,
	selectScrollDownArrowIconStyles,
	selectScrollUpArrowIconStyles,
	selectScrollDownArrowStyles,
	selectScrollUpArrowStyles,
	selectSeparatorStyles,
	selectTriggerIconClassName,
	selectTriggerVariants,
	selectValueStyles,
} from "./select.styles"

export { selectTriggerIconClassName, selectTriggerVariants }

export const Select: typeof SelectPrimitive.Root = SelectPrimitive.Root

export interface SelectButtonProps extends useRender.ComponentProps<"button"> {
	size?: VariantProps<typeof selectTriggerVariants>["size"]
}

export function SelectButton({
	className,
	size,
	render,
	children,
	...props
}: SelectButtonProps): React.ReactElement {
	const typeValue: React.ButtonHTMLAttributes<HTMLButtonElement>["type"] = render ? undefined : "button"

	const defaultProps = {
		children: (
			<>
				<span className={selectButtonValueStyles}>{children}</span>
				<ChevronExpandYIcon className={selectTriggerIconClassName} />
			</>
		),
		className: cn(selectTriggerVariants({ size }), selectButtonStyles, className),
		"data-slot": "select-button",
		type: typeValue,
	}

	return useRender({
		defaultTagName: "button",
		props: mergeProps<"button">(defaultProps, props),
		render,
	})
}

export function SelectTrigger({
	className,
	size = "default",
	children,
	...props
}: SelectPrimitive.Trigger.Props & VariantProps<typeof selectTriggerVariants>): React.ReactElement {
	return (
		<SelectPrimitive.Trigger
			className={cn(selectTriggerVariants({ size }), className)}
			data-slot="select-trigger"
			{...props}
		>
			{children}
			<SelectPrimitive.Icon data-slot="select-icon">
				<ChevronExpandYIcon className={selectTriggerIconClassName} />
			</SelectPrimitive.Icon>
		</SelectPrimitive.Trigger>
	)
}

export function SelectValue({ className, ...props }: SelectPrimitive.Value.Props): React.ReactElement {
	return (
		<SelectPrimitive.Value
			className={cn(selectValueStyles, className)}
			data-slot="select-value"
			{...props}
		/>
	)
}

export function SelectPopup({
	className,
	children,
	side = "bottom",
	sideOffset = 4,
	align = "start",
	alignOffset = 0,
	alignItemWithTrigger = true,
	anchor,
	portalProps,
	...props
}: SelectPrimitive.Popup.Props & {
	portalProps?: SelectPrimitive.Portal.Props
	side?: SelectPrimitive.Positioner.Props["side"]
	sideOffset?: SelectPrimitive.Positioner.Props["sideOffset"]
	align?: SelectPrimitive.Positioner.Props["align"]
	alignOffset?: SelectPrimitive.Positioner.Props["alignOffset"]
	alignItemWithTrigger?: SelectPrimitive.Positioner.Props["alignItemWithTrigger"]
	anchor?: SelectPrimitive.Positioner.Props["anchor"]
}): React.ReactElement {
	return (
		<SelectPrimitive.Portal {...portalProps}>
			<SelectPrimitive.Positioner
				align={align}
				alignItemWithTrigger={alignItemWithTrigger}
				alignOffset={alignOffset}
				anchor={anchor}
				className={selectPositionerStyles}
				data-slot="select-positioner"
				side={side}
				sideOffset={sideOffset}
			>
				<SelectPrimitive.Popup className={selectPopupStyles} data-slot="select-popup" {...props}>
					<SelectPrimitive.ScrollUpArrow
						className={selectScrollUpArrowStyles}
						data-slot="select-scroll-up-arrow"
					>
						<ChevronUpIcon className={selectScrollUpArrowIconStyles} />
					</SelectPrimitive.ScrollUpArrow>
					<div className={selectPopupSurfaceStyles}>
						<SelectPrimitive.List
							className={cn(selectListStyles, className)}
							data-slot="select-list"
						>
							{children}
						</SelectPrimitive.List>
					</div>
					<SelectPrimitive.ScrollDownArrow
						className={selectScrollDownArrowStyles}
						data-slot="select-scroll-down-arrow"
					>
						<ChevronDownIcon className={selectScrollDownArrowIconStyles} />
					</SelectPrimitive.ScrollDownArrow>
				</SelectPrimitive.Popup>
			</SelectPrimitive.Positioner>
		</SelectPrimitive.Portal>
	)
}

export function SelectItem({
	className,
	children,
	...props
}: SelectPrimitive.Item.Props): React.ReactElement {
	return (
		<SelectPrimitive.Item className={cn(selectItemStyles, className)} data-slot="select-item" {...props}>
			<SelectPrimitive.ItemIndicator className={selectItemIndicatorStyles}>
				<CheckIcon className={selectItemIndicatorIconStyles} />
			</SelectPrimitive.ItemIndicator>
			<SelectPrimitive.ItemText className={selectItemTextStyles}>{children}</SelectPrimitive.ItemText>
		</SelectPrimitive.Item>
	)
}

export function SelectSeparator({
	className,
	...props
}: SelectPrimitive.Separator.Props): React.ReactElement {
	return (
		<SelectPrimitive.Separator
			className={cn(selectSeparatorStyles, className)}
			data-slot="select-separator"
			{...props}
		/>
	)
}

export function SelectGroup(props: SelectPrimitive.Group.Props): React.ReactElement {
	return <SelectPrimitive.Group data-slot="select-group" {...props} />
}

export function SelectLabel({ className, ...props }: SelectPrimitive.Label.Props): React.ReactElement {
	return (
		<SelectPrimitive.Label
			className={cn(selectLabelStyles, className)}
			data-slot="select-label"
			{...props}
		/>
	)
}

export function SelectGroupLabel(props: SelectPrimitive.GroupLabel.Props): React.ReactElement {
	return (
		<SelectPrimitive.GroupLabel
			className={selectGroupLabelStyles}
			data-slot="select-group-label"
			{...props}
		/>
	)
}

export { SelectPrimitive, SelectPopup as SelectContent }
