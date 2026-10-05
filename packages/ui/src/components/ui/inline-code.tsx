import type React from "react"
import { cn } from "../../lib/utils"

// Inline monospace chip for identifiers, attribute keys and commands inside prose or table cells.
// Sized in `em` so it tracks whatever text size it sits in.
export function InlineCode({ className, ...props }: React.ComponentProps<"code">): React.ReactElement {
	return (
		<code
			className={cn("rounded bg-muted px-1 py-px font-mono text-[0.9em] text-foreground", className)}
			data-slot="inline-code"
			{...props}
		/>
	)
}
