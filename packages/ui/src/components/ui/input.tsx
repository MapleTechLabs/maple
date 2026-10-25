"use client"

import { Input as InputPrimitive } from "@base-ui/react/input"
import type * as React from "react"
import { cn } from "../../lib/utils"
import {
	inputControlChromeStyles,
	inputControlLayoutStyles,
	inputFileStyles,
	inputLgStyles,
	inputSearchStyles,
	inputSmStyles,
	inputStyles,
} from "./input.styles"

export type InputProps = Omit<InputPrimitive.Props & React.RefAttributes<HTMLInputElement>, "size"> & {
	size?: "sm" | "default" | "lg" | number
	unstyled?: boolean
	nativeInput?: boolean
	/**
	 * Classes for the inner `<input>` itself, merged last so they win over the
	 * control's own height and padding. The counterpart of `Textarea`'s prop of
	 * the same name.
	 */
	controlClassName?: string
}

export function Input({
	className,
	controlClassName,
	size = "default",
	unstyled = false,
	nativeInput = false,
	style,
	...props
}: InputProps): React.ReactElement {
	const inputClassName = cn(
		inputStyles,
		size === "sm" && inputSmStyles,
		size === "lg" && inputLgStyles,
		props.type === "search" && inputSearchStyles,
		props.type === "file" && inputFileStyles,
		controlClassName,
	)

	return (
		<span
			className={cn(inputControlLayoutStyles, !unstyled && inputControlChromeStyles, className)}
			data-size={size}
			data-slot="input-control"
		>
			{nativeInput ? (
				<input
					className={inputClassName}
					data-slot="input"
					size={typeof size === "number" ? size : undefined}
					style={typeof style === "function" ? undefined : style}
					{...props}
				/>
			) : (
				<InputPrimitive
					className={inputClassName}
					data-slot="input"
					size={typeof size === "number" ? size : undefined}
					style={style}
					{...props}
				/>
			)}
		</span>
	)
}

export { InputPrimitive }
