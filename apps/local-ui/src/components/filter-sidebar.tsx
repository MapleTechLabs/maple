// Filter-sidebar frame — mirrors the web app's `@/components/filters/filter-sidebar`.

import type { ReactNode } from "react"
import { Separator } from "@maple/ui/components/ui/separator"
import { ScrollArea } from "@maple/ui/components/ui/scroll-area"
import { cn } from "@maple/ui/utils"

export function FilterSidebarFrame({
	children,
	waiting = false,
	className,
}: {
	children: ReactNode
	waiting?: boolean
	className?: string
}) {
	return (
		<div className={cn("flex h-full w-56 shrink-0 flex-col px-4", waiting && "opacity-60", className)}>
			{children}
		</div>
	)
}

export function FilterSidebarHeader({
	title = "Filters",
	canClear = false,
	onClear,
}: {
	title?: string
	canClear?: boolean
	onClear?: () => void
}) {
	return (
		<div className="flex items-center justify-between py-2">
			<h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{title}</h3>
			{canClear && onClear && (
				<button
					type="button"
					onClick={onClear}
					className="text-xs text-muted-foreground hover:text-foreground"
				>
					Clear all
				</button>
			)}
		</div>
	)
}

export function FilterSidebarBody({ children }: { children: ReactNode }) {
	return (
		<>
			<Separator className="my-2" />
			<div className="relative min-h-0 flex-1">
				<ScrollArea className="h-full">
					<div className="space-y-1 pb-6 pr-4">{children}</div>
				</ScrollArea>
				<div
					aria-hidden
					className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-background to-transparent"
				/>
			</div>
		</>
	)
}
