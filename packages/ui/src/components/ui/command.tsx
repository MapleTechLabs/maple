"use client"

import { Dialog as CommandDialogPrimitive } from "@base-ui/react/dialog"
import { MagnifierIcon } from "../icons"
import type * as React from "react"
import { cn } from "../../lib/utils"
import {
	commandDialogBackdropStyles,
	commandDialogPopupStyles,
	commandDialogViewportStyles,
	commandEmptyStyles,
	commandFooterStyles,
	commandInputStyles,
	commandInputWrapperStyles,
	commandItemStyles,
	commandListStyles,
	commandPanelStyles,
	commandSeparatorStyles,
	commandShortcutStyles,
} from "./command.styles"
import {
	Autocomplete,
	AutocompleteCollection,
	AutocompleteEmpty,
	AutocompleteGroup,
	AutocompleteGroupLabel,
	AutocompleteInput,
	AutocompleteItem,
	AutocompleteList,
	AutocompleteSeparator,
} from "./autocomplete"

export const CommandDialog: typeof CommandDialogPrimitive.Root = CommandDialogPrimitive.Root

export const CommandDialogPortal: typeof CommandDialogPrimitive.Portal = CommandDialogPrimitive.Portal

export const CommandCreateHandle: typeof CommandDialogPrimitive.createHandle =
	CommandDialogPrimitive.createHandle

export function CommandDialogTrigger(props: CommandDialogPrimitive.Trigger.Props): React.ReactElement {
	return <CommandDialogPrimitive.Trigger data-slot="command-dialog-trigger" {...props} />
}

export function CommandDialogBackdrop({
	className,
	...props
}: CommandDialogPrimitive.Backdrop.Props): React.ReactElement {
	return (
		<CommandDialogPrimitive.Backdrop
			className={cn(commandDialogBackdropStyles, className)}
			data-slot="command-dialog-backdrop"
			{...props}
		/>
	)
}

export function CommandDialogViewport({
	className,
	...props
}: CommandDialogPrimitive.Viewport.Props): React.ReactElement {
	return (
		<CommandDialogPrimitive.Viewport
			className={cn(commandDialogViewportStyles, className)}
			data-slot="command-dialog-viewport"
			{...props}
		/>
	)
}

export function CommandDialogPopup({
	className,
	children,
	portalProps,
	...props
}: CommandDialogPrimitive.Popup.Props & {
	portalProps?: CommandDialogPrimitive.Portal.Props
}): React.ReactElement {
	return (
		<CommandDialogPortal {...portalProps}>
			<CommandDialogBackdrop />
			<CommandDialogViewport>
				<CommandDialogPrimitive.Popup
					className={cn(commandDialogPopupStyles, className)}
					data-slot="command-dialog-popup"
					{...props}
				>
					{children}
				</CommandDialogPrimitive.Popup>
			</CommandDialogViewport>
		</CommandDialogPortal>
	)
}

export function Command({
	autoHighlight = "always",
	keepHighlight = true,
	...props
}: React.ComponentProps<typeof Autocomplete>): React.ReactElement {
	return <Autocomplete autoHighlight={autoHighlight} inline keepHighlight={keepHighlight} open {...props} />
}

export function CommandInput({
	className,
	placeholder = undefined,
	...props
}: React.ComponentProps<typeof AutocompleteInput>): React.ReactElement {
	return (
		<div className={commandInputWrapperStyles}>
			<AutocompleteInput
				autoFocus
				className={cn(commandInputStyles, className)}
				placeholder={placeholder}
				size="lg"
				startAddon={<MagnifierIcon />}
				{...props}
			/>
		</div>
	)
}

export function CommandList({
	className,
	...props
}: React.ComponentProps<typeof AutocompleteList>): React.ReactElement {
	return (
		<AutocompleteList className={cn(commandListStyles, className)} data-slot="command-list" {...props} />
	)
}

export function CommandEmpty({
	className,
	...props
}: React.ComponentProps<typeof AutocompleteEmpty>): React.ReactElement {
	return (
		<AutocompleteEmpty
			className={cn(commandEmptyStyles, className)}
			data-slot="command-empty"
			{...props}
		/>
	)
}

export function CommandPanel({ className, ...props }: React.ComponentProps<"div">): React.ReactElement {
	return <div className={cn(commandPanelStyles, className)} {...props} />
}

export function CommandGroup({
	className,
	...props
}: React.ComponentProps<typeof AutocompleteGroup>): React.ReactElement {
	return <AutocompleteGroup className={className} data-slot="command-group" {...props} />
}

export function CommandGroupLabel({
	className,
	...props
}: React.ComponentProps<typeof AutocompleteGroupLabel>): React.ReactElement {
	return <AutocompleteGroupLabel className={className} data-slot="command-group-label" {...props} />
}

export function CommandCollection({
	...props
}: React.ComponentProps<typeof AutocompleteCollection>): React.ReactElement {
	return <AutocompleteCollection data-slot="command-collection" {...props} />
}

export function CommandItem({
	className,
	...props
}: React.ComponentProps<typeof AutocompleteItem>): React.ReactElement {
	return (
		<AutocompleteItem className={cn(commandItemStyles, className)} data-slot="command-item" {...props} />
	)
}

export function CommandSeparator({
	className,
	...props
}: React.ComponentProps<typeof AutocompleteSeparator>): React.ReactElement {
	return (
		<AutocompleteSeparator
			className={cn(commandSeparatorStyles, className)}
			data-slot="command-separator"
			{...props}
		/>
	)
}

export function CommandShortcut({ className, ...props }: React.ComponentProps<"kbd">): React.ReactElement {
	return <kbd className={cn(commandShortcutStyles, className)} data-slot="command-shortcut" {...props} />
}

export function CommandFooter({ className, ...props }: React.ComponentProps<"div">): React.ReactElement {
	return <div className={cn(commandFooterStyles, className)} data-slot="command-footer" {...props} />
}

export { CommandDialogPrimitive }
