"use client"

import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import type { VariantProps } from "class-variance-authority"
import type React from "react"
import { cn } from "../../lib/utils"
import { badgeVariants } from "./badge.styles"

export { badgeVariants }

export interface BadgeProps extends useRender.ComponentProps<"span"> {
	variant?: VariantProps<typeof badgeVariants>["variant"]
	size?: VariantProps<typeof badgeVariants>["size"]
	/** Fully rounded chip for states and meta tags. */
	pill?: boolean
	/** Mono + tabular figures, for ids, versions and counts. */
	mono?: boolean
}

export function Badge({
	className,
	variant,
	size,
	pill = false,
	mono = false,
	render,
	...props
}: BadgeProps): React.ReactElement {
	const defaultProps = {
		className: cn(badgeVariants({ className, mono, pill, size, variant })),
		"data-slot": "badge",
	}

	return useRender({
		defaultTagName: "span",
		props: mergeProps<"span">(defaultProps, props),
		render,
	})
}
