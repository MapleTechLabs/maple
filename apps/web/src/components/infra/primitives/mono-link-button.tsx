import type React from "react"

import { cn } from "@maple/ui/lib/utils"

/** A 10px mono text action that underlines on hover ("Clear all", "+3 more"). */
export function MonoLinkButton({ className, type = "button", ...props }: React.ComponentProps<"button">) {
	return (
		<button
			type={type}
			className={cn(
				"font-mono text-[10px] text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline",
				className,
			)}
			{...props}
		/>
	)
}
