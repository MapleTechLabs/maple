import { cva, type VariantProps } from "class-variance-authority"
import type React from "react"
import { TONE_FILL } from "../../lib/tone"
import { cn } from "../../lib/utils"

export const statusDotVariants = cva("relative inline-flex shrink-0 rounded-full", {
	defaultVariants: { tone: "neutral", size: "default" },
	variants: {
		tone: {
			// The shared status vocabulary (lib/tone), on the same severity tokens the logs page uses.
			crit: TONE_FILL.crit,
			warn: TONE_FILL.warn,
			ok: TONE_FILL.ok,
			info: TONE_FILL.info,
			neutral: TONE_FILL.neutral,
			// In-flight work (running investigations, live streams).
			live: "bg-primary",
			// Colour comes from the caller's className (service colours, severity maps).
			custom: "",
		},
		size: {
			sm: "size-1",
			default: "size-1.5",
			lg: "size-2",
		},
	},
})

export interface StatusDotProps extends Omit<React.ComponentProps<"span">, "children"> {
	tone?: VariantProps<typeof statusDotVariants>["tone"]
	size?: VariantProps<typeof statusDotVariants>["size"]
}

/** A static status dot. Deliberately never animated: live state reads from tone and copy. */
export function StatusDot({ tone, size, className, ...props }: StatusDotProps): React.ReactElement {
	return (
		<span
			aria-hidden
			className={cn(statusDotVariants({ tone, size }), className)}
			data-slot="status-dot"
			{...props}
		/>
	)
}
