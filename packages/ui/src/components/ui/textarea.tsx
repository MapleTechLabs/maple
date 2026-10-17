"use client"

import { Field as FieldPrimitive } from "@base-ui/react/field"
import { mergeProps } from "@base-ui/react/merge-props"
import type * as React from "react"
import { cn } from "../../lib/utils"
import {
	textareaControlChromeStyles,
	textareaControlLayoutStyles,
	textareaLgStyles,
	textareaSmStyles,
	textareaStyles,
} from "./textarea.styles"

export type TextareaProps = React.ComponentPropsWithoutRef<"textarea"> &
	React.RefAttributes<HTMLTextAreaElement> & {
		size?: "sm" | "default" | "lg" | number
		unstyled?: boolean
		/**
		 * Classes for the inner `<textarea>` itself, merged last so they win over
		 * the control's own padding and min-height. Reach for this instead of a
		 * `[&_textarea]:` descendant selector on `className` — that only worked by
		 * accident of the DOM shape and silently broke on `!` specificity ties.
		 */
		controlClassName?: string
	}

export function Textarea({
	className,
	controlClassName,
	size = "default",
	unstyled = false,
	ref,
	...props
}: TextareaProps): React.ReactElement {
	return (
		<span
			className={cn(textareaControlLayoutStyles, !unstyled && textareaControlChromeStyles, className)}
			data-size={size}
			data-slot="textarea-control"
		>
			<FieldPrimitive.Control
				ref={ref}
				value={props.value}
				defaultValue={props.defaultValue}
				disabled={props.disabled}
				id={props.id}
				name={props.name}
				render={(defaultProps: React.ComponentProps<"textarea">) => (
					<textarea
						className={cn(
							textareaStyles,
							size === "sm" && textareaSmStyles,
							size === "lg" && textareaLgStyles,
							controlClassName,
						)}
						data-slot="textarea"
						{...mergeProps(defaultProps, props)}
					/>
				)}
			/>
		</span>
	)
}

export { FieldPrimitive }
