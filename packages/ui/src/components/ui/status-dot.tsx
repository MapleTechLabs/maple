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
			// In-flight work (running investigations, live streams). Pair with `pulse`.
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
	/** Adds the expanding "live" ring. Suppressed under reduced motion. */
	pulse?: boolean
}

export function StatusDot({ tone, size, pulse, className, ...props }: StatusDotProps): React.ReactElement {
	const dot = statusDotVariants({ tone, size })
	if (!pulse) {
		return <span aria-hidden className={cn(dot, className)} data-slot="status-dot" {...props} />
	}
	return (
		<span
			aria-hidden
			className={cn("relative inline-flex shrink-0", statusDotVariants({ size, tone: "custom" }))}
			data-slot="status-dot"
			{...props}
		>
			<span
				className={cn(
					dot,
					className,
					"absolute inset-0 size-full animate-ping opacity-60 motion-reduce:hidden",
				)}
			/>
			<span className={cn(dot, className, "size-full")} />
		</span>
	)
}
