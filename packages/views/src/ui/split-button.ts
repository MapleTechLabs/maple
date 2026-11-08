import { cn } from "@maple/ui/lib/utils"

/**
 * `SplitButton`'s two halves: the classes that join an action button and its chevron menu trigger
 * into one control. Pass the result as `className` to `button` / `linkButton` / `refreshButton`.
 */
export const splitButtonClass = (part: "lead" | "tail", variant: "default" | "outline" = "default"): string =>
	part === "lead"
		? "relative rounded-r-none before:rounded-r-none focus-visible:z-10"
		: cn(
				"relative -ml-px rounded-l-none before:rounded-l-none focus-visible:z-10",
				// A solid button has no border of its own, so the seam is drawn in its foreground.
				variant === "default" && "border-l border-l-primary-foreground/20",
			)
