"use client"

import type { VariantProps } from "class-variance-authority"
import type * as React from "react"
import { cn } from "../../lib/utils"
import { inputGroupAddonVariants, inputGroupStyles, inputGroupTextStyles } from "./input-group.styles"
import { Button, type ButtonProps } from "./button"
import { Input, type InputProps } from "./input"
import { Textarea, type TextareaProps } from "./textarea"

export function InputGroup({ className, ...props }: React.ComponentProps<"div">): React.ReactElement {
	return <div className={cn(inputGroupStyles, className)} data-slot="input-group" role="group" {...props} />
}

export function InputGroupAddon({
	className,
	align = "inline-start",
	...props
}: React.ComponentProps<"div"> & VariantProps<typeof inputGroupAddonVariants>): React.ReactElement {
	return (
		<div
			className={cn(inputGroupAddonVariants({ align }), className)}
			data-align={align}
			data-slot="input-group-addon"
			onMouseDown={(e: React.MouseEvent<HTMLDivElement>) => {
				const target = e.target as HTMLElement
				const isInteractive = target.closest(
					"button, a, input, select, textarea, [role='button'], [role='combobox'], [role='listbox'], [data-slot='select-trigger']",
				)
				if (isInteractive) return
				e.preventDefault()
				const parent = e.currentTarget.parentElement
				const input = parent?.querySelector<HTMLInputElement | HTMLTextAreaElement>("input, textarea")
				if (input && !parent?.querySelector("input:focus, textarea:focus")) {
					input.focus()
				}
			}}
			{...props}
		/>
	)
}

export function InputGroupText({ className, ...props }: React.ComponentProps<"span">): React.ReactElement {
	return <span className={cn(inputGroupTextStyles, className)} {...props} />
}

export function InputGroupButton({
	className,
	variant = "ghost",
	size = "xs",
	...props
}: ButtonProps): React.ReactElement {
	return (
		<Button
			className={className}
			data-slot="input-group-button"
			size={size}
			variant={variant}
			{...props}
		/>
	)
}

export function InputGroupInput({ className, ...props }: InputProps): React.ReactElement {
	return <Input className={className} unstyled {...props} />
}

export function InputGroupTextarea({ className, ...props }: TextareaProps): React.ReactElement {
	return <Textarea className={className} unstyled {...props} />
}
