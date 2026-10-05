import type React from "react"
import { cn } from "@maple/ui/lib/utils"

/** Neutral bordered meta pill (service, counts, reopen markers) on anomaly rows and cards. */
export function MetaChip({ className, ...props }: React.ComponentProps<"span">) {
	return (
		<span
			className={cn(
				"inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full border border-border/70 bg-background px-2 text-[11px] text-muted-foreground",
				className,
			)}
			{...props}
		/>
	)
}
