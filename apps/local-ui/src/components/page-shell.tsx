// Page layout: left filter sidebar + main column (toolbar over scrollable
// content). Below `md` the sidebar moves into a drawer behind a Filters button.

import { useState, type ReactNode } from "react"
import { Button } from "@maple/ui/components/ui/button"
import { Sheet, SheetPopup, SheetTitle } from "@maple/ui/components/ui/sheet"
import { FilterIcon } from "@maple/ui/components/icons"

export function PageShell({
	sidebar,
	toolbar,
	children,
	activeFilterCount = 0,
}: {
	sidebar: ReactNode
	toolbar: ReactNode
	children: ReactNode
	/** Shown on the small-screen Filters button, so hidden filters are never invisible. */
	activeFilterCount?: number
}) {
	const [drawerOpen, setDrawerOpen] = useState(false)
	return (
		<div className="flex h-full min-h-0">
			<aside className="hidden h-full border-r py-1 md:block">{sidebar}</aside>
			<div className="flex min-w-0 flex-1 flex-col">
				<div className="flex items-center border-b px-4 py-2 md:hidden">
					<Button
						variant="outline"
						size="sm"
						className="gap-1.5"
						onClick={() => setDrawerOpen(true)}
					>
						<FilterIcon size={14} />
						Filters
						{activeFilterCount > 0 ? (
							<span className="rounded-sm bg-primary/15 px-1 text-[10px] tabular-nums text-primary">
								{activeFilterCount}
							</span>
						) : null}
					</Button>
				</div>
				{toolbar}
				<div className="min-h-0 flex-1 overflow-auto">{children}</div>
			</div>
			<Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
				<SheetPopup side="left" className="py-3">
					<SheetTitle className="sr-only">Filters</SheetTitle>
					{drawerOpen ? <div className="h-full min-h-0">{sidebar}</div> : null}
				</SheetPopup>
			</Sheet>
		</div>
	)
}
