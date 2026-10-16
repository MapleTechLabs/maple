import type React from "react"
import { cn } from "../../lib/utils"

// Inline monospace for identifiers, attribute keys and commands inside prose or table cells.
// Sized in `em` so it tracks whatever text size it sits in. `plain` drops the chip for dense prose.
export function InlineCode({
	variant = "chip",
	className,
	...props
}: React.ComponentProps<"code"> & { variant?: "chip" | "plain" }): React.ReactElement {
	return (
		<code
			className={cn(
				"font-mono text-[0.9em]",
				variant === "chip" ? "rounded bg-muted px-1 py-px text-foreground" : "text-muted-foreground",
				className,
			)}
			data-slot="inline-code"
			{...props}
		/>
	)
}
