"use client"

import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox"
import { ChevronExpandYIcon, XmarkIcon } from "../icons"
import * as React from "react"
import { cn } from "../../lib/utils"
import {
	comboboxClearDefaultStyles,
	comboboxClearSmStyles,
	comboboxClearStyles,
	comboboxChipRemoveStyles,
	comboboxChipStyles,
	comboboxChipTextStyles,
	comboboxChipsInputDefaultStyles,
	comboboxChipsInputSmStyles,
	comboboxChipsInputStyles,
	comboboxChipsStartAddonStyles,
	comboboxChipsStyles,
	comboboxEmptyStyles,
	comboboxGroupLabelStyles,
	comboboxGroupStyles,
	comboboxTriggerDefaultStyles,
	comboboxTriggerSmStyles,
	comboboxTriggerStyles,
	comboboxInputControlStyles,
	comboboxInputDefaultStyles,
	comboboxInputGroupStyles,
	comboboxInputSmStyles,
	comboboxInputStartAddonStyles,
	comboboxItemIndicatorStyles,
	comboboxItemStyles,
	comboboxItemTextStyles,
	comboboxListStyles,
	comboboxPopupFrameStyles,
	comboboxPopupStyles,
	comboboxPositionerStyles,
	comboboxSeparatorStyles,
	comboboxStartAddonStyles,
	comboboxStatusStyles,
} from "./combobox.styles"
import { Input } from "./input"
import { ScrollArea } from "./scroll-area"

export const ComboboxContext: React.Context<{
	chipsRef: React.RefObject<Element | null> | null
	multiple: boolean
}> = React.createContext<{
	chipsRef: React.RefObject<Element | null> | null
	multiple: boolean
}>({
	chipsRef: null,
	multiple: false,
})

export function Combobox<Value, Multiple extends boolean | undefined = false>(
	props: ComboboxPrimitive.Root.Props<Value, Multiple>,
): React.ReactElement {
	const chipsRef = React.useRef<Element | null>(null)
	return (
		<ComboboxContext.Provider value={{ chipsRef, multiple: !!props.multiple }}>
			<ComboboxPrimitive.Root {...props} />
		</ComboboxContext.Provider>
	)
}

export function ComboboxChipsInput({
	className,
	size,
	...props
}: Omit<ComboboxPrimitive.Input.Props, "size"> & {
	size?: "sm" | "default" | "lg" | number
	ref?: React.Ref<HTMLInputElement>
}): React.ReactElement {
	const sizeValue = size ?? "default"

	return (
		<ComboboxPrimitive.Input
			className={cn(
				comboboxChipsInputStyles,
				sizeValue === "sm" ? comboboxChipsInputSmStyles : comboboxChipsInputDefaultStyles,
				className,
			)}
			data-size={typeof sizeValue === "string" ? sizeValue : undefined}
			data-slot="combobox-chips-input"
			size={typeof sizeValue === "number" ? sizeValue : undefined}
			{...props}
		/>
	)
}

export function ComboboxInput({
	className,
	showTrigger = true,
	showClear = false,
	startAddon,
	size,
	triggerProps,
	clearProps,
	...props
}: Omit<ComboboxPrimitive.Input.Props, "size"> & {
	showTrigger?: boolean
	showClear?: boolean
	startAddon?: React.ReactNode
	size?: "sm" | "default" | "lg" | number
	ref?: React.Ref<HTMLInputElement>
	triggerProps?: ComboboxPrimitive.Trigger.Props
	clearProps?: ComboboxPrimitive.Clear.Props
}): React.ReactElement {
	const sizeValue = size ?? "default"

	return (
		<ComboboxPrimitive.InputGroup className={comboboxInputGroupStyles} data-slot="combobox-input-group">
			{startAddon && (
				<div aria-hidden="true" className={comboboxStartAddonStyles} data-slot="combobox-start-addon">
					{startAddon}
				</div>
			)}
			<ComboboxPrimitive.Input
				className={cn(
					startAddon && comboboxInputStartAddonStyles,
					sizeValue === "sm" ? comboboxInputSmStyles : comboboxInputDefaultStyles,
					className,
				)}
				data-slot="combobox-input"
				render={<Input className={comboboxInputControlStyles} nativeInput size={sizeValue} />}
				{...props}
			/>
			{showTrigger && (
				<ComboboxTrigger
					className={cn(
						comboboxTriggerStyles,
						sizeValue === "sm" ? comboboxTriggerSmStyles : comboboxTriggerDefaultStyles,
					)}
					{...triggerProps}
				>
					<ComboboxPrimitive.Icon data-slot="combobox-icon">
						<ChevronExpandYIcon />
					</ComboboxPrimitive.Icon>
				</ComboboxTrigger>
			)}
			{showClear && (
				<ComboboxClear
					className={cn(
						comboboxClearStyles,
						sizeValue === "sm" ? comboboxClearSmStyles : comboboxClearDefaultStyles,
					)}
					{...clearProps}
				>
					<XmarkIcon />
				</ComboboxClear>
			)}
		</ComboboxPrimitive.InputGroup>
	)
}

export function ComboboxTrigger({
	className,
	children,
	...props
}: ComboboxPrimitive.Trigger.Props): React.ReactElement {
	return (
		<ComboboxPrimitive.Trigger className={className} data-slot="combobox-trigger" {...props}>
			{children}
		</ComboboxPrimitive.Trigger>
	)
}

export function ComboboxPopup({
	className,
	children,
	side = "bottom",
	sideOffset = 4,
	alignOffset,
	align = "start",
	anchor: anchorProp,
	portalProps,
	positionerClassName,
	...props
}: ComboboxPrimitive.Popup.Props & {
	align?: ComboboxPrimitive.Positioner.Props["align"]
	/** Extra classes on the positioner, e.g. a higher `z-*` when the combobox lives inside a popover (`z-55`). */
	positionerClassName?: string
	sideOffset?: ComboboxPrimitive.Positioner.Props["sideOffset"]
	alignOffset?: ComboboxPrimitive.Positioner.Props["alignOffset"]
	side?: ComboboxPrimitive.Positioner.Props["side"]
	anchor?: ComboboxPrimitive.Positioner.Props["anchor"]
	portalProps?: ComboboxPrimitive.Portal.Props
}): React.ReactElement {
	const { chipsRef } = React.useContext(ComboboxContext)
	const anchor = anchorProp ?? chipsRef

	return (
		<ComboboxPrimitive.Portal {...portalProps}>
			<ComboboxPrimitive.Positioner
				align={align}
				alignOffset={alignOffset}
				anchor={anchor}
				className={cn(comboboxPositionerStyles, positionerClassName)}
				data-slot="combobox-positioner"
				side={side}
				sideOffset={sideOffset}
			>
				<span className={cn(comboboxPopupFrameStyles, className)}>
					<ComboboxPrimitive.Popup
						className={comboboxPopupStyles}
						data-slot="combobox-popup"
						{...props}
					>
						{children}
					</ComboboxPrimitive.Popup>
				</span>
			</ComboboxPrimitive.Positioner>
		</ComboboxPrimitive.Portal>
	)
}

export function ComboboxItem({
	className,
	children,
	...props
}: ComboboxPrimitive.Item.Props): React.ReactElement {
	return (
		<ComboboxPrimitive.Item
			className={cn(comboboxItemStyles, className)}
			data-slot="combobox-item"
			{...props}
		>
			<ComboboxPrimitive.ItemIndicator className={comboboxItemIndicatorStyles}>
				<svg
					aria-hidden="true"
					fill="none"
					height="24"
					stroke="currentColor"
					strokeLinecap="round"
					strokeLinejoin="round"
					strokeWidth="2"
					viewBox="0 0 24 24"
					width="24"
					xmlns="http://www.w3.org/2000/svg"
				>
					<path d="M5.252 12.7 10.2 18.63 18.748 5.37" />
				</svg>
			</ComboboxPrimitive.ItemIndicator>
			<div className={comboboxItemTextStyles}>{children}</div>
		</ComboboxPrimitive.Item>
	)
}

export function ComboboxSeparator({
	className,
	...props
}: ComboboxPrimitive.Separator.Props): React.ReactElement {
	return (
		<ComboboxPrimitive.Separator
			className={cn(comboboxSeparatorStyles, className)}
			data-slot="combobox-separator"
			{...props}
		/>
	)
}

export function ComboboxGroup({ className, ...props }: ComboboxPrimitive.Group.Props): React.ReactElement {
	return (
		<ComboboxPrimitive.Group
			className={cn(comboboxGroupStyles, className)}
			data-slot="combobox-group"
			{...props}
		/>
	)
}

export function ComboboxGroupLabel({
	className,
	...props
}: ComboboxPrimitive.GroupLabel.Props): React.ReactElement {
	return (
		<ComboboxPrimitive.GroupLabel
			className={cn(comboboxGroupLabelStyles, className)}
			data-slot="combobox-group-label"
			{...props}
		/>
	)
}

export function ComboboxEmpty({ className, ...props }: ComboboxPrimitive.Empty.Props): React.ReactElement {
	return (
		<ComboboxPrimitive.Empty
			className={cn(comboboxEmptyStyles, className)}
			data-slot="combobox-empty"
			{...props}
		/>
	)
}

export function ComboboxRow({ className, ...props }: ComboboxPrimitive.Row.Props): React.ReactElement {
	return <ComboboxPrimitive.Row className={className} data-slot="combobox-row" {...props} />
}

export function ComboboxValue({ ...props }: ComboboxPrimitive.Value.Props): React.ReactElement {
	return <ComboboxPrimitive.Value data-slot="combobox-value" {...props} />
}

export function ComboboxList({ className, ...props }: ComboboxPrimitive.List.Props): React.ReactElement {
	return (
		<ScrollArea scrollbarGutter scrollFade>
			<ComboboxPrimitive.List
				className={cn(comboboxListStyles, className)}
				data-slot="combobox-list"
				{...props}
			/>
		</ScrollArea>
	)
}

export function ComboboxClear({ className, ...props }: ComboboxPrimitive.Clear.Props): React.ReactElement {
	return <ComboboxPrimitive.Clear className={className} data-slot="combobox-clear" {...props} />
}

export function ComboboxStatus({ className, ...props }: ComboboxPrimitive.Status.Props): React.ReactElement {
	return (
		<ComboboxPrimitive.Status
			className={cn(comboboxStatusStyles, className)}
			data-slot="combobox-status"
			{...props}
		/>
	)
}

export function ComboboxCollection(props: ComboboxPrimitive.Collection.Props): React.ReactElement {
	return <ComboboxPrimitive.Collection data-slot="combobox-collection" {...props} />
}

export function ComboboxChips({
	className,
	children,
	startAddon,
	...props
}: ComboboxPrimitive.Chips.Props & {
	startAddon?: React.ReactNode
}): React.ReactElement {
	const { chipsRef } = React.useContext(ComboboxContext)

	return (
		<ComboboxPrimitive.Chips
			className={cn(comboboxChipsStyles, className)}
			data-slot="combobox-chips"
			ref={chipsRef as React.Ref<HTMLDivElement> | null}
			{...props}
		>
			{startAddon && (
				<div
					aria-hidden="true"
					className={comboboxChipsStartAddonStyles}
					data-slot="combobox-start-addon"
				>
					{startAddon}
				</div>
			)}
			{children}
		</ComboboxPrimitive.Chips>
	)
}

export function ComboboxChip({
	children,
	className,
	removeProps,
	...props
}: ComboboxPrimitive.Chip.Props & {
	removeProps?: ComboboxPrimitive.ChipRemove.Props
}): React.ReactElement {
	return (
		<ComboboxPrimitive.Chip
			className={cn(comboboxChipStyles, className)}
			data-slot="combobox-chip"
			{...props}
		>
			{/* Text children truncate so a long label never pushes the remove button out. */}
			{React.Children.map(children, (child) =>
				typeof child === "string" || typeof child === "number" ? (
					<span className={comboboxChipTextStyles} title={String(child)}>
						{child}
					</span>
				) : (
					child
				),
			)}
			<ComboboxChipRemove {...removeProps} />
		</ComboboxPrimitive.Chip>
	)
}

export function ComboboxChipRemove(props: ComboboxPrimitive.ChipRemove.Props): React.ReactElement {
	return (
		<ComboboxPrimitive.ChipRemove
			aria-label="Remove"
			className={comboboxChipRemoveStyles}
			data-slot="combobox-chip-remove"
			{...props}
		>
			<XmarkIcon />
		</ComboboxPrimitive.ChipRemove>
	)
}

export const useComboboxFilter: typeof ComboboxPrimitive.useFilter = ComboboxPrimitive.useFilter

export function useComboboxAnchor(): React.RefObject<HTMLDivElement | null> {
	return React.useRef<HTMLDivElement | null>(null)
}

export { ComboboxPrimitive, ComboboxPopup as ComboboxContent, ComboboxGroupLabel as ComboboxLabel }
