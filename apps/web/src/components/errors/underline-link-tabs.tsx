import type React from "react"
import { cn } from "@maple/ui/lib/utils"

/**
 * The Link-based underline tab strip shared by the issue and investigation pages.
 * Full-bleed out of the sticky area's `p-4` and flush to its bottom edge, so the
 * underline reads as the boundary between header and content.
 */
export function UnderlineTabStrip({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div
			role="tablist"
			aria-label={label}
			className="-mx-4 -mb-4 flex items-center gap-6 overflow-x-auto border-b px-4"
		>
			{children}
		</div>
	)
}

export function underlineTabClass(isActive: boolean): string {
	return cn(
		"-mb-px flex h-[34px] shrink-0 items-center gap-1.5 border-b-2 text-sm transition-colors",
		isActive
			? "border-primary font-medium text-foreground"
			: "border-transparent text-muted-foreground hover:text-foreground",
	)
}

export function UnderlineTabCount({ count }: { count: number | undefined }) {
	if (count === undefined) return null
	return <span className="text-xs text-muted-foreground tabular-nums">{count}</span>
}
