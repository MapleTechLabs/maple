import { NavigationMenu as NavigationMenuPrimitive } from "@base-ui/react/navigation-menu"

import { cn } from "../../lib/utils"
import { ChevronDownIcon } from "../icons"
import {
	navigationMenuContentStyles,
	navigationMenuIndicatorArrowStyles,
	navigationMenuIndicatorStyles,
	navigationMenuItemStyles,
	navigationMenuLinkStyles,
	navigationMenuListStyles,
	navigationMenuPopupStyles,
	navigationMenuPositionerStyles,
	navigationMenuStyles,
	navigationMenuTriggerGroupStyles,
	navigationMenuTriggerIconStyles,
	navigationMenuTriggerStyle,
	navigationMenuViewportStyles,
} from "./navigation-menu.styles"

function NavigationMenu({
	align = "start",
	className,
	children,
	...props
}: NavigationMenuPrimitive.Root.Props & Pick<NavigationMenuPrimitive.Positioner.Props, "align">) {
	return (
		<NavigationMenuPrimitive.Root
			data-slot="navigation-menu"
			className={cn(navigationMenuStyles, className)}
			{...props}
		>
			{children}
			<NavigationMenuPositioner align={align} />
		</NavigationMenuPrimitive.Root>
	)
}

function NavigationMenuList({
	className,
	...props
}: React.ComponentPropsWithRef<typeof NavigationMenuPrimitive.List>) {
	return (
		<NavigationMenuPrimitive.List
			data-slot="navigation-menu-list"
			className={cn(navigationMenuListStyles, className)}
			{...props}
		/>
	)
}

function NavigationMenuItem({
	className,
	...props
}: React.ComponentPropsWithRef<typeof NavigationMenuPrimitive.Item>) {
	return (
		<NavigationMenuPrimitive.Item
			data-slot="navigation-menu-item"
			className={cn(navigationMenuItemStyles, className)}
			{...props}
		/>
	)
}

function NavigationMenuTrigger({ className, children, ...props }: NavigationMenuPrimitive.Trigger.Props) {
	return (
		<NavigationMenuPrimitive.Trigger
			data-slot="navigation-menu-trigger"
			className={cn(navigationMenuTriggerStyle(), navigationMenuTriggerGroupStyles, className)}
			{...props}
		>
			{children}{" "}
			<ChevronDownIcon strokeWidth={2} className={navigationMenuTriggerIconStyles} aria-hidden="true" />
		</NavigationMenuPrimitive.Trigger>
	)
}

function NavigationMenuContent({ className, ...props }: NavigationMenuPrimitive.Content.Props) {
	return (
		<NavigationMenuPrimitive.Content
			data-slot="navigation-menu-content"
			className={cn(navigationMenuContentStyles, className)}
			{...props}
		/>
	)
}

function NavigationMenuPositioner({
	className,
	side = "bottom",
	sideOffset = 8,
	align = "start",
	alignOffset = 0,
	...props
}: NavigationMenuPrimitive.Positioner.Props) {
	return (
		<NavigationMenuPrimitive.Portal>
			<NavigationMenuPrimitive.Positioner
				side={side}
				sideOffset={sideOffset}
				align={align}
				alignOffset={alignOffset}
				className={cn(navigationMenuPositionerStyles, className)}
				{...props}
			>
				<NavigationMenuPrimitive.Popup className={navigationMenuPopupStyles}>
					<NavigationMenuPrimitive.Viewport className={navigationMenuViewportStyles} />
				</NavigationMenuPrimitive.Popup>
			</NavigationMenuPrimitive.Positioner>
		</NavigationMenuPrimitive.Portal>
	)
}

function NavigationMenuLink({ className, ...props }: NavigationMenuPrimitive.Link.Props) {
	return (
		<NavigationMenuPrimitive.Link
			data-slot="navigation-menu-link"
			className={cn(navigationMenuLinkStyles, className)}
			{...props}
		/>
	)
}

function NavigationMenuIndicator({
	className,
	...props
}: React.ComponentPropsWithRef<typeof NavigationMenuPrimitive.Icon>) {
	return (
		<NavigationMenuPrimitive.Icon
			data-slot="navigation-menu-indicator"
			className={cn(navigationMenuIndicatorStyles, className)}
			{...props}
		>
			<div className={navigationMenuIndicatorArrowStyles} />
		</NavigationMenuPrimitive.Icon>
	)
}

export {
	NavigationMenu,
	NavigationMenuContent,
	NavigationMenuIndicator,
	NavigationMenuItem,
	NavigationMenuLink,
	NavigationMenuList,
	NavigationMenuTrigger,
	navigationMenuTriggerStyle,
	NavigationMenuPositioner,
}
