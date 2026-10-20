"use client"

import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import type React from "react"
import { cn } from "../../lib/utils"
import { labelStyles } from "./label.styles"

export function Label({
	className,
	render,
	...props
}: useRender.ComponentProps<"label">): React.ReactElement {
	const defaultProps = {
		className: cn(labelStyles, className),
		"data-slot": "label",
	}

	return useRender({
		defaultTagName: "label",
		props: mergeProps<"label">(defaultProps, props),
		render,
	})
}
