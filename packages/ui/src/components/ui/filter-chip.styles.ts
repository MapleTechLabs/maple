import { cva } from "class-variance-authority"
import type { Tone } from "../../lib/tone"

// One look for every on/off filter chip: muted when off, foreground + border when on.
export const filterChipVariants = cva(
	"inline-flex shrink-0 cursor-pointer select-none items-center gap-1.5 whitespace-nowrap rounded-md border font-medium text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-64 border-transparent bg-muted/40 text-muted-foreground hover:text-foreground data-pressed:bg-background data-pressed:text-foreground [&_svg:not([class*='size-'])]:size-3.5 [&_svg]:shrink-0",
	{
		defaultVariants: { size: "sm" },
		variants: {
			size: {
				xs: "h-6 px-2",
				sm: "h-7 px-2.5",
			},
		},
	},
)

// Static strings so Tailwind sees them (mirrors TONE_BORDER, scoped to the pressed state).
export const filterChipPressedBorderStyles = {
	crit: "data-pressed:border-severity-error/40",
	warn: "data-pressed:border-severity-warn/40",
	ok: "data-pressed:border-severity-info/40",
	info: "data-pressed:border-severity-info/40",
	done: "data-pressed:border-severity-debug/40",
	neutral: "data-pressed:border-border",
} satisfies Record<Tone, string>

export const filterChipDotOffStyles = "opacity-50"

export const filterChipCountStyles = "font-mono text-2xs text-muted-foreground tabular-nums"
