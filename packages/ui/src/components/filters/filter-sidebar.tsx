import type { ReactNode } from "react"

import { Button } from "../ui/button"
import { ScrollArea } from "../ui/scroll-area"
import { Separator } from "../ui/separator"
import { Skeleton } from "../ui/skeleton"
import { cn } from "../../lib/utils"
import { refreshingClass } from "../../lib/refreshing"
import { Eyebrow } from "../ui/eyebrow"

interface FilterSidebarFrameProps {
	children: ReactNode
	waiting?: boolean
	className?: string
}

export function FilterSidebarFrame({ children, waiting = false, className }: FilterSidebarFrameProps) {
	// Width is owned by the container (e.g. the web app's PageLayout.FilterSidebar: an inline aside
	// on desktop, a sheet below lg). Setting one here would fight it — callers that own their own
	// layout (local mode) pass a width via className instead.
	return (
		<div
			className={cn("flex h-full w-full flex-col", refreshingClass(waiting), className)}
			aria-busy={waiting || undefined}
		>
			{children}
		</div>
	)
}

interface FilterSidebarHeaderProps {
	title?: string
	canClear?: boolean
	onClear?: () => void
}

export function FilterSidebarHeader({
	title = "Filters",
	canClear = false,
	onClear,
}: FilterSidebarHeaderProps) {
	return (
		<div className="flex h-8 items-center justify-between py-2">
			{/* Same size as the section labels below; distinguished by weight and full-strength color. */}
			<Eyebrow as="h3" variant="label" className="font-semibold text-foreground">
				{title}
			</Eyebrow>
			{canClear && onClear && (
				<Button
					variant="link"
					size="xs"
					onClick={onClear}
					className="text-muted-foreground hover:text-foreground"
				>
					Clear all
				</Button>
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
					{/* Sections carry no dividers — whitespace alone groups them, so the gap between
					    sections has to clearly beat the gap between options inside one. */}
					<div className="space-y-2 pr-4 pb-6">{children}</div>
				</ScrollArea>
				<div
					aria-hidden
					className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-background to-transparent"
				/>
			</div>
		</>
	)
}

interface FilterSidebarLoadingProps {
	sectionCount?: number
}

// Fixed, uneven widths so the placeholder reads as a list of names rather than a striped bar
// chart. Deterministic, so the skeleton never reshuffles between renders.
const OPTION_WIDTHS = ["w-[58%]", "w-[72%]", "w-[44%]", "w-[64%]", "w-[50%]"]
const LABEL_WIDTHS = ["w-14", "w-20", "w-16", "w-12"]

/** Shaped like the loaded sidebar (header, then labelled checkbox rows) so nothing jumps in. */
export function FilterSidebarLoading({ sectionCount = 3 }: FilterSidebarLoadingProps) {
	return (
		<FilterSidebarFrame>
			<div aria-busy className="contents">
				<div className="flex h-8 items-center py-2">
					<Skeleton className="h-2.5 w-12" />
				</div>
				<Separator className="my-2" />
				<div className="space-y-2 pr-4">
					{Array.from({ length: sectionCount }, (_, section) => (
						<div key={section} className="pb-3">
							<div className="flex h-8 items-center">
								<Skeleton
									className={cn("h-2", LABEL_WIDTHS[section % LABEL_WIDTHS.length])}
								/>
							</div>
							<div className="space-y-2">
								{Array.from({ length: section === 0 ? 2 : 4 }, (_, row) => (
									<div key={row} className="flex h-4 items-center gap-2">
										<Skeleton className="size-3.5 shrink-0 rounded-sm" />
										<Skeleton
											className={cn(
												"h-2.5",
												OPTION_WIDTHS[(section + row) % OPTION_WIDTHS.length],
											)}
										/>
										<Skeleton className="ml-auto h-2.5 w-5 shrink-0" />
									</div>
								))}
							</div>
						</div>
					))}
				</div>
			</div>
		</FilterSidebarFrame>
	)
}

interface FilterSidebarEmptyProps {
	title?: string
	description?: string
	/** A control that still applies with no facet values: one that changes what the page lists. */
	children?: ReactNode
}

/**
 * The sidebar when the page has nothing to filter and no filter is set. Facet controls with no
 * values (empty range inputs, checkboxes counting zero) are noise beside the page's own empty
 * state, so this keeps the frame, so nothing shifts when data lands, and says one quiet thing.
 * Pages with an active filter keep their full sidebar instead: that is where it gets undone.
 */
// Deliberately generic: the page's own empty state already names what is missing, and the
// sidebar repeating it word for word reads as two components that didn't know about each other.
export function FilterSidebarEmpty({
	title = "Nothing to filter yet",
	description = "Filters fill in from the values in your data once it arrives.",
	children,
}: FilterSidebarEmptyProps) {
	return (
		<FilterSidebarFrame>
			<FilterSidebarHeader />
			<Separator className="my-2" />
			<div className="space-y-1 py-2 pr-4">
				<p className="text-xs font-medium text-foreground">{title}</p>
				<p className="text-xs leading-relaxed text-muted-foreground">{description}</p>
				{children}
			</div>
		</FilterSidebarFrame>
	)
}
