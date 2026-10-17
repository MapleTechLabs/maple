"use client"

import { OTPField as OTPFieldPrimitive } from "@base-ui/react/otp-field"
import type * as React from "react"
import { cn } from "../../lib/utils"
import { Separator } from "./separator"
import { otpFieldInputStyles, otpFieldSeparatorStyles, otpFieldStyles } from "./otp-field.styles"

export function OTPField({
	className,
	size = "default",
	...props
}: React.ComponentProps<typeof OTPFieldPrimitive.Root> & {
	size?: "default" | "lg"
}): React.ReactElement {
	return (
		<OTPFieldPrimitive.Root
			className={cn(otpFieldStyles, className)}
			data-size={size}
			data-slot="otp-field"
			{...props}
		/>
	)
}

export function OTPFieldInput({
	className,
	...props
}: React.ComponentProps<typeof OTPFieldPrimitive.Input>): React.ReactElement {
	return (
		<OTPFieldPrimitive.Input
			className={cn(otpFieldInputStyles, className)}
			data-slot="otp-field-input"
			spellCheck={false}
			{...props}
		/>
	)
}

export function OTPFieldSeparator({
	className,
	...props
}: React.ComponentProps<typeof Separator>): React.ReactElement {
	return (
		<OTPFieldPrimitive.Separator
			render={
				<Separator
					className={cn(otpFieldSeparatorStyles, className)}
					orientation="horizontal"
					{...props}
				/>
			}
		/>
	)
}

export { OTPFieldPrimitive }
