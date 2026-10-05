import type React from "react"
import { cn } from "@maple/ui/lib/utils"

/**
 * Link-based underline tab strip for route tabs (issue, investigation, code
 * review). `bleed` pulls it out of a `p-4` sticky header so the underline is
 * flush with the header's bottom edge.
 */
export function UnderlineTabStrip({
	label,
	bleed = true,
	className,
	children,
}: {
	label: string
	bleed?: boolean
	className?: string
	children: React.ReactNode
}) {
	return (
		<div
			role="tablist"
			aria-label={label}
			className={cn(
				"flex items-center gap-6 overflow-x-auto border-b",
				bleed ? "-mx-4 -mb-4 px-4" : "px-0",
				className,
			)}
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
