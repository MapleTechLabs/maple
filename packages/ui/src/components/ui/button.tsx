"use client"

import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import type { VariantProps } from "class-variance-authority"
import type * as React from "react"
import { cn } from "../../lib/utils"
import { buttonLoadingIndicatorStyles, buttonVariants } from "./button.styles"
import { Spinner } from "./spinner"

export { buttonVariants }

export interface ButtonProps extends useRender.ComponentProps<"button"> {
	variant?: VariantProps<typeof buttonVariants>["variant"]
	size?: VariantProps<typeof buttonVariants>["size"]
	loading?: boolean
}

export function Button({
	className,
	variant,
	size,
	render,
	children,
	loading = false,
	disabled: disabledProp,
	...props
}: ButtonProps): React.ReactElement {
	const isDisabled: boolean = Boolean(loading || disabledProp)
	const typeValue: React.ButtonHTMLAttributes<HTMLButtonElement>["type"] = render ? undefined : "button"

	const defaultProps = {
		children: (
			<>
				{children}
				{loading && (
					<Spinner className={buttonLoadingIndicatorStyles} data-slot="button-loading-indicator" />
				)}
			</>
		),
		className: cn(buttonVariants({ className, size, variant })),
		"aria-disabled": loading || undefined,
		"data-loading": loading ? "" : undefined,
		"data-slot": "button",
		disabled: isDisabled,
		type: typeValue,
	}

	return useRender({
		defaultTagName: "button",
		props: mergeProps<"button">(defaultProps, props),
		render,
	})
}
