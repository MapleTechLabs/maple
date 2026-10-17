import type React from "react"
import { cn } from "../../lib/utils"
import { inlineCodeChipStyles, inlineCodePlainStyles, inlineCodeStyles } from "./inline-code.styles"

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
				inlineCodeStyles,
				variant === "chip" ? inlineCodeChipStyles : inlineCodePlainStyles,
				className,
			)}
			data-slot="inline-code"
			{...props}
		/>
	)
}
