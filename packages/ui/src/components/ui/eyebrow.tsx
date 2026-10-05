import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"
import type React from "react"
import { cn } from "../../lib/utils"

// The small uppercase overline that titles a group of fields, a stat, or a table column.
// `overline` is the canonical section label; `label` is the slightly larger stat-tile caption.
export const eyebrowVariants = cva("font-medium uppercase text-muted-foreground", {
	defaultVariants: { variant: "overline" },
	variants: {
		variant: {
			overline: "text-[10px] tracking-[0.12em]",
			label: "text-[11px] tracking-[0.08em]",
			mono: "font-mono text-[10px] tracking-[0.12em] text-muted-foreground/70",
		},
	},
})

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
