"use client"

import * as React from "react"
import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu"

import { cn } from "../../lib/utils"
import {
	contextMenuCheckboxItemIndicatorStyles,
	contextMenuCheckboxItemStyles,
	contextMenuContentStyles,
	contextMenuItemStyles,
	contextMenuLabelStyles,
	contextMenuPositionerStyles,
	contextMenuRadioItemIndicatorStyles,
	contextMenuRadioItemStyles,
	contextMenuSeparatorStyles,
	contextMenuShortcutStyles,
	contextMenuSubContentStyles,
	contextMenuSubTriggerIconStyles,
	contextMenuSubTriggerStyles,
	contextMenuTriggerStyles,
} from "./context-menu.styles"
import { ChevronRightIcon, CheckIcon } from "../icons"
import { InMenuGroupContext, useInMenuGroup } from "./menu-group-context"

function ContextMenu({ ...props }: ContextMenuPrimitive.Root.Props) {
	return <ContextMenuPrimitive.Root data-slot="context-menu" {...props} />
}

function ContextMenuPortal({ ...props }: ContextMenuPrimitive.Portal.Props) {
	return <ContextMenuPrimitive.Portal data-slot="context-menu-portal" {...props} />
}

function ContextMenuTrigger({ className, ...props }: ContextMenuPrimitive.Trigger.Props) {
	return (
		<ContextMenuPrimitive.Trigger
			data-slot="context-menu-trigger"
			className={cn(contextMenuTriggerStyles, className)}
			{...props}
		/>
	)
}

function ContextMenuContent({
	className,
	align = "start",
	alignOffset = 4,
	side = "right",
	sideOffset = 0,
	...props
}: ContextMenuPrimitive.Popup.Props &
	Pick<ContextMenuPrimitive.Positioner.Props, "align" | "alignOffset" | "side" | "sideOffset">) {
	return (
		<ContextMenuPrimitive.Portal>
			<ContextMenuPrimitive.Positioner
				className={contextMenuPositionerStyles}
				align={align}
				alignOffset={alignOffset}
				side={side}
				sideOffset={sideOffset}
			>
				<ContextMenuPrimitive.Popup
					data-slot="context-menu-content"
					className={cn(contextMenuContentStyles, className)}
					{...props}
				/>
			</ContextMenuPrimitive.Positioner>
		</ContextMenuPrimitive.Portal>
	)
}

function ContextMenuGroup({ ...props }: ContextMenuPrimitive.Group.Props) {
	return (
		<InMenuGroupContext.Provider value={true}>
			<ContextMenuPrimitive.Group data-slot="context-menu-group" {...props} />
		</InMenuGroupContext.Provider>
	)
}

function ContextMenuLabel({
	className,
	inset,
	...props
}: ContextMenuPrimitive.GroupLabel.Props & {
	inset?: boolean
}) {
	const label = (
		<ContextMenuPrimitive.GroupLabel
			data-slot="context-menu-label"
			data-inset={inset}
			className={cn(contextMenuLabelStyles, className)}
			{...props}
		/>
	)

	// Same crash as the dropdown label — context-menu re-exports the very same
	// Base UI group parts. See menu-group-context.tsx.
	return useInMenuGroup() ? label : <ContextMenuPrimitive.Group>{label}</ContextMenuPrimitive.Group>
}

function ContextMenuItem({
	className,
	inset,
	variant = "default",
	...props
}: ContextMenuPrimitive.Item.Props & {
	inset?: boolean
	variant?: "default" | "destructive"
}) {
	return (
		<ContextMenuPrimitive.Item
			data-slot="context-menu-item"
			data-inset={inset}
			data-variant={variant}
			className={cn(contextMenuItemStyles, className)}
			{...props}
		/>
	)
}

function ContextMenuSub({ ...props }: ContextMenuPrimitive.SubmenuRoot.Props) {
	return <ContextMenuPrimitive.SubmenuRoot data-slot="context-menu-sub" {...props} />
}

function ContextMenuSubTrigger({
	className,
	inset,
	children,
	...props
}: ContextMenuPrimitive.SubmenuTrigger.Props & {
	inset?: boolean
}) {
	return (
		<ContextMenuPrimitive.SubmenuTrigger
			data-slot="context-menu-sub-trigger"
			data-inset={inset}
			className={cn(contextMenuSubTriggerStyles, className)}
			{...props}
		>
			{children}
			<ChevronRightIcon strokeWidth={2} className={contextMenuSubTriggerIconStyles} />
		</ContextMenuPrimitive.SubmenuTrigger>
	)
}

function ContextMenuSubContent({ ...props }: React.ComponentProps<typeof ContextMenuContent>) {
	return (
		<ContextMenuContent
			data-slot="context-menu-sub-content"
			className={contextMenuSubContentStyles}
			side="right"
			{...props}
		/>
	)
}

function ContextMenuCheckboxItem({
	className,
	children,
	checked,
	...props
}: ContextMenuPrimitive.CheckboxItem.Props) {
	return (
		<ContextMenuPrimitive.CheckboxItem
			data-slot="context-menu-checkbox-item"
			className={cn(contextMenuCheckboxItemStyles, className)}
			checked={checked}
			{...props}
		>
			<span className={contextMenuCheckboxItemIndicatorStyles}>
				<ContextMenuPrimitive.CheckboxItemIndicator>
					<CheckIcon strokeWidth={2} />
				</ContextMenuPrimitive.CheckboxItemIndicator>
			</span>
			{children}
		</ContextMenuPrimitive.CheckboxItem>
	)
}

function ContextMenuRadioGroup({ ...props }: ContextMenuPrimitive.RadioGroup.Props) {
	return (
		<InMenuGroupContext.Provider value={true}>
			<ContextMenuPrimitive.RadioGroup data-slot="context-menu-radio-group" {...props} />
		</InMenuGroupContext.Provider>
	)
}

function ContextMenuRadioItem({ className, children, ...props }: ContextMenuPrimitive.RadioItem.Props) {
	return (
		<ContextMenuPrimitive.RadioItem
			data-slot="context-menu-radio-item"
			className={cn(contextMenuRadioItemStyles, className)}
			{...props}
		>
			<span className={contextMenuRadioItemIndicatorStyles}>
				<ContextMenuPrimitive.RadioItemIndicator>
					<CheckIcon strokeWidth={2} />
				</ContextMenuPrimitive.RadioItemIndicator>
			</span>
			{children}
		</ContextMenuPrimitive.RadioItem>
	)
}

function ContextMenuSeparator({ className, ...props }: ContextMenuPrimitive.Separator.Props) {
	return (
		<ContextMenuPrimitive.Separator
			data-slot="context-menu-separator"
			className={cn(contextMenuSeparatorStyles, className)}
			{...props}
		/>
	)
}

function ContextMenuShortcut({ className, ...props }: React.ComponentProps<"span">) {
	return (
		<span
			data-slot="context-menu-shortcut"
			className={cn(contextMenuShortcutStyles, className)}
			{...props}
		/>
	)
}

export {
	ContextMenu,
	ContextMenuTrigger,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuCheckboxItem,
	ContextMenuRadioItem,
	ContextMenuLabel,
	ContextMenuSeparator,
	ContextMenuShortcut,
	ContextMenuGroup,
	ContextMenuPortal,
	ContextMenuSub,
	ContextMenuSubContent,
	ContextMenuSubTrigger,
	ContextMenuRadioGroup,
}
