"use client"

import { Autocomplete as AutocompletePrimitive } from "@base-ui/react/autocomplete"
import { ChevronExpandYIcon, XmarkIcon } from "../icons"
import type React from "react"
import { cn } from "../../lib/utils"
import {
	autocompleteClearStyles,
	autocompleteEmptyStyles,
	autocompleteGroupLabelStyles,
	autocompleteGroupStyles,
	autocompleteInputClearDefaultStyles,
	autocompleteInputClearSmStyles,
	autocompleteInputClearStyles,
	autocompleteInputDefaultStyles,
	autocompleteInputGroupStyles,
	autocompleteInputSmStyles,
	autocompleteInputStartAddonStyles,
	autocompleteInputTriggerDefaultStyles,
	autocompleteInputTriggerSmStyles,
	autocompleteInputTriggerStyles,
	autocompleteItemStyles,
	autocompleteListStyles,
	autocompletePopupStyles,
	autocompletePopupSurfaceStyles,
	autocompletePositionerStyles,
	autocompleteSeparatorStyles,
	autocompleteStartAddonStyles,
	autocompleteStatusStyles,
} from "./autocomplete.styles"
import { Input } from "./input"
import { ScrollArea } from "./scroll-area"

export const Autocomplete: typeof AutocompletePrimitive.Root = AutocompletePrimitive.Root

export function AutocompleteInput({
	className,
	showTrigger = false,
	showClear = false,
	startAddon,
	size,
	triggerProps,
	clearProps,
	...props
}: Omit<AutocompletePrimitive.Input.Props, "size"> & {
	showTrigger?: boolean
	showClear?: boolean
	startAddon?: React.ReactNode
	size?: "sm" | "default" | "lg" | number
	ref?: React.Ref<HTMLInputElement>
	triggerProps?: AutocompletePrimitive.Trigger.Props
	clearProps?: AutocompletePrimitive.Clear.Props
}): React.ReactElement {
	const sizeValue = size ?? "default"

	return (
		<AutocompletePrimitive.InputGroup
			className={autocompleteInputGroupStyles}
			data-slot="autocomplete-input-group"
		>
			{startAddon && (
				<div
					aria-hidden="true"
					className={autocompleteStartAddonStyles}
					data-slot="autocomplete-start-addon"
				>
					{startAddon}
				</div>
			)}
			<AutocompletePrimitive.Input
				className={cn(
					startAddon && autocompleteInputStartAddonStyles,
					sizeValue === "sm" ? autocompleteInputSmStyles : autocompleteInputDefaultStyles,
					className,
				)}
				data-slot="autocomplete-input"
				render={<Input nativeInput size={sizeValue} />}
				{...props}
			/>
			{showTrigger && (
				<AutocompleteTrigger
					className={cn(
						autocompleteInputTriggerStyles,
						sizeValue === "sm"
							? autocompleteInputTriggerSmStyles
							: autocompleteInputTriggerDefaultStyles,
					)}
					{...triggerProps}
				>
					<AutocompletePrimitive.Icon data-slot="autocomplete-icon">
						<ChevronExpandYIcon />
					</AutocompletePrimitive.Icon>
				</AutocompleteTrigger>
			)}
			{showClear && (
				<AutocompleteClear
					className={cn(
						autocompleteInputClearStyles,
						sizeValue === "sm"
							? autocompleteInputClearSmStyles
							: autocompleteInputClearDefaultStyles,
					)}
					{...clearProps}
				>
					<XmarkIcon />
				</AutocompleteClear>
			)}
		</AutocompletePrimitive.InputGroup>
	)
}

export function AutocompletePopup({
	className,
	children,
	side = "bottom",
	sideOffset = 4,
	alignOffset,
	align = "start",
	anchor,
	portalProps,
	...props
}: AutocompletePrimitive.Popup.Props & {
	align?: AutocompletePrimitive.Positioner.Props["align"]
	sideOffset?: AutocompletePrimitive.Positioner.Props["sideOffset"]
	alignOffset?: AutocompletePrimitive.Positioner.Props["alignOffset"]
	side?: AutocompletePrimitive.Positioner.Props["side"]
	anchor?: AutocompletePrimitive.Positioner.Props["anchor"]
	portalProps?: AutocompletePrimitive.Portal.Props
}): React.ReactElement {
	return (
		<AutocompletePrimitive.Portal {...portalProps}>
			<AutocompletePrimitive.Positioner
				align={align}
				alignOffset={alignOffset}
				anchor={anchor}
				className={autocompletePositionerStyles}
				data-slot="autocomplete-positioner"
				side={side}
				sideOffset={sideOffset}
			>
				<span className={cn(autocompletePopupSurfaceStyles, className)}>
					<AutocompletePrimitive.Popup
						className={autocompletePopupStyles}
						data-slot="autocomplete-popup"
						{...props}
					>
						{children}
					</AutocompletePrimitive.Popup>
				</span>
			</AutocompletePrimitive.Positioner>
		</AutocompletePrimitive.Portal>
	)
}

export function AutocompleteItem({
	className,
	children,
	...props
}: AutocompletePrimitive.Item.Props): React.ReactElement {
	return (
		<AutocompletePrimitive.Item
			className={cn(autocompleteItemStyles, className)}
			data-slot="autocomplete-item"
			{...props}
		>
			{children}
		</AutocompletePrimitive.Item>
	)
}

export function AutocompleteSeparator({
	className,
	...props
}: AutocompletePrimitive.Separator.Props): React.ReactElement {
	return (
		<AutocompletePrimitive.Separator
			className={cn(autocompleteSeparatorStyles, className)}
			data-slot="autocomplete-separator"
			{...props}
		/>
	)
}

export function AutocompleteGroup({
	className,
	...props
}: AutocompletePrimitive.Group.Props): React.ReactElement {
	return (
		<AutocompletePrimitive.Group
			className={cn(autocompleteGroupStyles, className)}
			data-slot="autocomplete-group"
			{...props}
		/>
	)
}

export function AutocompleteGroupLabel({
	className,
	...props
}: AutocompletePrimitive.GroupLabel.Props): React.ReactElement {
	return (
		<AutocompletePrimitive.GroupLabel
			className={cn(autocompleteGroupLabelStyles, className)}
			data-slot="autocomplete-group-label"
			{...props}
		/>
	)
}

export function AutocompleteEmpty({
	className,
	...props
}: AutocompletePrimitive.Empty.Props): React.ReactElement {
	return (
		<AutocompletePrimitive.Empty
			className={cn(autocompleteEmptyStyles, className)}
			data-slot="autocomplete-empty"
			{...props}
		/>
	)
}

export function AutocompleteRow({
	className,
	...props
}: AutocompletePrimitive.Row.Props): React.ReactElement {
	return <AutocompletePrimitive.Row className={className} data-slot="autocomplete-row" {...props} />
}

export function AutocompleteValue({ ...props }: AutocompletePrimitive.Value.Props): React.ReactElement {
	return <AutocompletePrimitive.Value data-slot="autocomplete-value" {...props} />
}

export function AutocompleteList({
	className,
	...props
}: AutocompletePrimitive.List.Props): React.ReactElement {
	return (
		<ScrollArea scrollbarGutter scrollFade>
			<AutocompletePrimitive.List
				className={cn(autocompleteListStyles, className)}
				data-slot="autocomplete-list"
				{...props}
			/>
		</ScrollArea>
	)
}

export function AutocompleteClear({
	className,
	...props
}: AutocompletePrimitive.Clear.Props): React.ReactElement {
	return (
		<AutocompletePrimitive.Clear
			className={cn(autocompleteClearStyles, className)}
			data-slot="autocomplete-clear"
			{...props}
		>
			<XmarkIcon />
		</AutocompletePrimitive.Clear>
	)
}

export function AutocompleteStatus({
	className,
	...props
}: AutocompletePrimitive.Status.Props): React.ReactElement {
	return (
		<AutocompletePrimitive.Status
			className={cn(autocompleteStatusStyles, className)}
			data-slot="autocomplete-status"
			{...props}
		/>
	)
}

export function AutocompleteCollection({
	...props
}: AutocompletePrimitive.Collection.Props): React.ReactElement {
	return <AutocompletePrimitive.Collection data-slot="autocomplete-collection" {...props} />
}

export function AutocompleteTrigger({
	className,
	children,
	...props
}: AutocompletePrimitive.Trigger.Props): React.ReactElement {
	return (
		<AutocompletePrimitive.Trigger className={className} data-slot="autocomplete-trigger" {...props}>
			{children}
		</AutocompletePrimitive.Trigger>
	)
}

export const useAutocompleteFilter: typeof AutocompletePrimitive.useFilter = AutocompletePrimitive.useFilter

export { AutocompletePrimitive }
