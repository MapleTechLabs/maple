import type React from "react"
import { cn } from "@maple/ui/lib/utils"

/**
 * Link-based underline tab strip for route tabs (issue, investigation, code
 * review). `bleed` pulls it out of a `p-4` sticky header so the underline is
 * flush with the header's bottom edge. `navigation` renders a `<nav>` for links
 * that mark the current route with `aria-current="page"` instead of a tablist.
 */
export function UnderlineTabStrip({
	label,
	bleed = true,
	divided = true,
	navigation = false,
	className,
	children,
}: {
	label: string
	bleed?: boolean
	/** Bottom border under the strip; off when the surrounding header draws it. */
	divided?: boolean
	navigation?: boolean
	className?: string
	children: React.ReactNode
}) {
	const Tag = navigation ? "nav" : "div"
	return (
		<Tag
			role={navigation ? undefined : "tablist"}
			aria-label={label}
			className={cn(
				"flex items-center gap-6 overflow-x-auto",
				divided && "border-b",
				bleed ? "-mx-4 -mb-4 px-4" : "px-0",
				className,
			)}
		>
			{children}
		</Tag>
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
