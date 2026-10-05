import type { ReactNode } from "react"
import { cn } from "@maple/ui/lib/utils"

// Compact mono filter tabs for settings tables. Lighter than ToggleGroup's recessed track
// on purpose: they sit inline in dense table toolbars next to counts.
export function FilterTabs({ className, children }: { className?: string; children: ReactNode }) {
	return (
		<div className={cn("border-border flex items-center gap-0.5 rounded-md border p-0.5", className)}>
			{children}
		</div>
	)
}

export function FilterTab({
	active,
	onClick,
	children,
}: {
	active: boolean
	onClick: () => void
	children: ReactNode
}) {
	return (
		<button
			type="button"
			aria-pressed={active}
			onClick={onClick}
			className={cn(
				"rounded px-2.5 py-1 font-mono text-[11px] leading-4 transition-colors",
				"focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-1",
				active
					? "bg-accent text-foreground font-medium"
					: "text-muted-foreground hover:text-foreground",
			)}
		>
			{children}
		</button>
	)
}
