import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import type { VariantProps } from "class-variance-authority"
import type React from "react"
import { cn } from "../../lib/utils"
import { eyebrowVariants } from "./eyebrow.styles"

export { eyebrowVariants }

export interface EyebrowProps extends useRender.ComponentProps<"span"> {
	variant?: VariantProps<typeof eyebrowVariants>["variant"]
	/** Intrinsic tag to render; use `render` for components. */
	as?: "span" | "div" | "p" | "h2" | "h3" | "h4" | "h5" | "dt" | "tr"
}

export function Eyebrow({
	className,
	variant,
	as = "span",
	render,
	...props
}: EyebrowProps): React.ReactElement {
	const defaultProps = {
		className: cn(eyebrowVariants({ variant }), className),
		"data-slot": "eyebrow",
	}
	return useRender({ defaultTagName: as, props: mergeProps<"span">(defaultProps, props), render })
}
