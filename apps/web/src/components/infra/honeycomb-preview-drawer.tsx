import type { ReactElement, ReactNode } from "react"

import { Button } from "@maple/ui/components/ui/button"
import {
	Sheet,
	SheetContent,
	SheetFooter,
	SheetHeader,
	SheetPanel,
	SheetTitle,
} from "@maple/ui/components/ui/sheet"

interface EntityPreviewDrawerProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	/** Entity name — rendered monospace in the header. */
	title: string
	/** Status indicator beside the title (e.g. a HostStatusBadge). */
	status?: ReactNode
	/** Key metrics — typically a <StatRail>. */
	stats: ReactNode
	/** Metadata chips row (HeroChips). */
	meta?: ReactNode
	/** A `<Link>` to the full detail page, styled as the primary footer action. */
	detailLink: ReactElement
}

/**
 * Right-slide drawer that previews a single infra entity (host / pod / node)
 * from the data already in hand, with a "View full details" action into the
 * full detail page. Shared by all three honeycomb views.
 */
export function EntityPreviewDrawer({
	open,
	onOpenChange,
	title,
	status,
	stats,
	meta,
	detailLink,
}: EntityPreviewDrawerProps) {
	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent side="right" className="sm:max-w-md">
				<SheetHeader>
					<SheetTitle className="truncate pr-8 font-mono text-base" title={title}>
						{title}
					</SheetTitle>
					{status}
				</SheetHeader>

				<SheetPanel className="space-y-4">
					{stats}
					{meta && <div className="flex flex-wrap items-center gap-1.5">{meta}</div>}
				</SheetPanel>

				<SheetFooter>
					<Button className="w-full sm:w-auto" render={detailLink}>
						View full details
					</Button>
				</SheetFooter>
			</SheetContent>
		</Sheet>
	)
}
