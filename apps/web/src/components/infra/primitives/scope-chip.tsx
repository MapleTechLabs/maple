// The scope marker chip.
//
// A panel that sits under a filter sidebar, a branch selector, or any other
// scope control implies "I obey that control". Where that is only partly true —
// Cloudflare's single-dimension slices, PlanetScale's database-wide gauges — the
// panel says so itself rather than letting the implication be quietly false.
//
// This is the chip; the vendor-specific components that decide *what* it says
// (Cloudflare's `PanelScope`) compose it.

import type { ReactNode } from "react"
import { Badge } from "@maple/ui/components/ui/badge"
import { cn } from "@maple/ui/lib/utils"
import { Tooltip, TooltipContent, TooltipTrigger } from "@maple/ui/components/ui/tooltip"

/**
 * A scope marker. `tone="muted"` is for the markers that describe a *limit* of the
 * panel ("zone-wide", "partial", "all branches"); the default reads as an applied
 * scope. Pass `explanation` to attach the tooltip that says why.
 */
export function ScopeChip({
	children,
	explanation,
	tone = "default",
	className,
}: {
	children: ReactNode
	explanation?: ReactNode
	tone?: "default" | "muted"
	className?: string
}) {
	const chipClass = cn(
		"bg-background/60 font-normal",
		tone === "muted" ? "text-muted-foreground/70" : "text-muted-foreground",
		className,
	)

	if (explanation === undefined) {
		return (
			<Badge variant="meta" size="xs" mono className={chipClass}>
				{children}
			</Badge>
		)
	}

	return (
		<Tooltip>
			<TooltipTrigger
				render={<Badge variant="meta" size="xs" mono />}
				className={cn(chipClass, "cursor-default")}
			>
				{children}
			</TooltipTrigger>
			<TooltipContent className="max-w-[32ch]">{explanation}</TooltipContent>
		</Tooltip>
	)
}
