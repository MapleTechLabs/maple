import * as React from "react"
import { Menu as MenuPrimitive } from "@base-ui/react/menu"

import { cn } from "../../lib/utils"
import {
	dropdownMenuCheckboxItemIndicatorStyles,
	dropdownMenuCheckboxItemStyles,
	dropdownMenuContentStyles,
	dropdownMenuItemStyles,
	dropdownMenuLabelStyles,
	dropdownMenuPositionerStyles,
	dropdownMenuRadioItemIndicatorStyles,
	dropdownMenuRadioItemStyles,
	dropdownMenuSeparatorStyles,
	dropdownMenuShortcutStyles,
	dropdownMenuSubContentStyles,
	dropdownMenuSubTriggerIconStyles,
	dropdownMenuSubTriggerStyles,
} from "./dropdown-menu.styles"
import { ChevronRightIcon, CheckIcon } from "../icons"
import { InMenuGroupContext, useInMenuGroup } from "./menu-group-context"

function DropdownMenu({ ...props }: MenuPrimitive.Root.Props) {
	return <MenuPrimitive.Root data-slot="dropdown-menu" {...props} />
}

function DropdownMenuPortal({ ...props }: MenuPrimitive.Portal.Props) {
	return <MenuPrimitive.Portal data-slot="dropdown-menu-portal" {...props} />
}

function DropdownMenuTrigger({ ...props }: MenuPrimitive.Trigger.Props) {
	return <MenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />
}

function DropdownMenuContent({
	align = "start",
	alignOffset = 0,
	side = "bottom",
	sideOffset = 4,
	className,
	...props
}: MenuPrimitive.Popup.Props &
	Pick<MenuPrimitive.Positioner.Props, "align" | "alignOffset" | "side" | "sideOffset">) {
	return (
		<MenuPrimitive.Portal>
			<MenuPrimitive.Positioner
				className={dropdownMenuPositionerStyles}
				align={align}
				alignOffset={alignOffset}
				side={side}
				sideOffset={sideOffset}
			>
				<MenuPrimitive.Popup
					data-slot="dropdown-menu-content"
					className={cn(dropdownMenuContentStyles, className)}
					{...props}
				/>
			</MenuPrimitive.Positioner>
		</MenuPrimitive.Portal>
	)
}

function DropdownMenuGroup({ ...props }: MenuPrimitive.Group.Props) {
	return (
		<InMenuGroupContext.Provider value={true}>
			<MenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />
		</InMenuGroupContext.Provider>
	)
}

function DropdownMenuLabel({
	className,
	inset,
	...props
}: MenuPrimitive.GroupLabel.Props & {
	inset?: boolean
}) {
	const label = (
		<MenuPrimitive.GroupLabel
			data-slot="dropdown-menu-label"
			data-inset={inset}
			className={cn(dropdownMenuLabelStyles, className)}
			{...props}
		/>
	)

	// A bare label would throw `MenuGroupContext is missing` and take out the
	// page. See menu-group-context.tsx for why this detects instead of wrapping
	// unconditionally.
	return useInMenuGroup() ? label : <MenuPrimitive.Group>{label}</MenuPrimitive.Group>
}

function DropdownMenuItem({
	className,
	inset,
	variant = "default",
	...props
}: MenuPrimitive.Item.Props & {
	inset?: boolean
	variant?: "default" | "destructive"
}) {
	return (
		<MenuPrimitive.Item
			data-slot="dropdown-menu-item"
			data-inset={inset}
			data-variant={variant}
			className={cn(dropdownMenuItemStyles, className)}
			{...props}
		/>
	)
}

function DropdownMenuSub({ ...props }: MenuPrimitive.SubmenuRoot.Props) {
	return <MenuPrimitive.SubmenuRoot data-slot="dropdown-menu-sub" {...props} />
}

function DropdownMenuSubTrigger({
	className,
	inset,
	children,
	...props
}: MenuPrimitive.SubmenuTrigger.Props & {
	inset?: boolean
}) {
	return (
		<MenuPrimitive.SubmenuTrigger
			data-slot="dropdown-menu-sub-trigger"
			data-inset={inset}
			className={cn(dropdownMenuSubTriggerStyles, className)}
			{...props}
		>
			{children}
			<ChevronRightIcon strokeWidth={2} className={dropdownMenuSubTriggerIconStyles} />
		</MenuPrimitive.SubmenuTrigger>
	)
}

function DropdownMenuSubContent({
	align = "start",
	alignOffset = -3,
	side = "right",
	sideOffset = 0,
	className,
	...props
}: React.ComponentProps<typeof DropdownMenuContent>) {
	return (
		<DropdownMenuContent
			data-slot="dropdown-menu-sub-content"
			className={cn(dropdownMenuSubContentStyles, className)}
			align={align}
			alignOffset={alignOffset}
			side={side}
			sideOffset={sideOffset}
			{...props}
		/>
	)
}

function DropdownMenuCheckboxItem({
	className,
	children,
	checked,
	...props
}: MenuPrimitive.CheckboxItem.Props) {
	return (
		<MenuPrimitive.CheckboxItem
			data-slot="dropdown-menu-checkbox-item"
			className={cn(dropdownMenuCheckboxItemStyles, className)}
			checked={checked}
			{...props}
		>
			<span
				className={dropdownMenuCheckboxItemIndicatorStyles}
				data-slot="dropdown-menu-checkbox-item-indicator"
			>
				<MenuPrimitive.CheckboxItemIndicator>
					<CheckIcon strokeWidth={2} />
				</MenuPrimitive.CheckboxItemIndicator>
			</span>
			{children}
		</MenuPrimitive.CheckboxItem>
	)
}

function DropdownMenuRadioGroup({ ...props }: MenuPrimitive.RadioGroup.Props) {
	return (
		<InMenuGroupContext.Provider value={true}>
			<MenuPrimitive.RadioGroup data-slot="dropdown-menu-radio-group" {...props} />
		</InMenuGroupContext.Provider>
	)
}

function DropdownMenuRadioItem({ className, children, ...props }: MenuPrimitive.RadioItem.Props) {
	return (
		<MenuPrimitive.RadioItem
			data-slot="dropdown-menu-radio-item"
			className={cn(dropdownMenuRadioItemStyles, className)}
			{...props}
		>
			<span
				className={dropdownMenuRadioItemIndicatorStyles}
				data-slot="dropdown-menu-radio-item-indicator"
			>
				<MenuPrimitive.RadioItemIndicator>
					<CheckIcon strokeWidth={2} />
				</MenuPrimitive.RadioItemIndicator>
			</span>
			{children}
		</MenuPrimitive.RadioItem>
	)
}

function DropdownMenuSeparator({ className, ...props }: MenuPrimitive.Separator.Props) {
	return (
		<MenuPrimitive.Separator
			data-slot="dropdown-menu-separator"
			className={cn(dropdownMenuSeparatorStyles, className)}
			{...props}
		/>
	)
}

function DropdownMenuShortcut({ className, ...props }: React.ComponentProps<"span">) {
	return (
		<span
			data-slot="dropdown-menu-shortcut"
			className={cn(dropdownMenuShortcutStyles, className)}
			{...props}
		/>
	)
}

export {
	DropdownMenu,
	DropdownMenuPortal,
	DropdownMenuTrigger,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuLabel,
	DropdownMenuItem,
	DropdownMenuCheckboxItem,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuShortcut,
	DropdownMenuSub,
	DropdownMenuSubTrigger,
	DropdownMenuSubContent,
}
