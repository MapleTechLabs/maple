// Page layout: left filter sidebar + main column (sticky toolbar over scrollable
// content). Mirrors the web app's DashboardLayout filterSidebar + stickyContent.

import type { ReactNode } from "react"

export function PageShell({
	sidebar,
	toolbar,
	children,
}: {
	sidebar: ReactNode
	toolbar: ReactNode
	children: ReactNode
}) {
	return (
		<div className="flex h-full min-h-0">
			<aside className="hidden h-full border-r py-1 md:block">{sidebar}</aside>
			<div className="flex min-w-0 flex-1 flex-col">
				{toolbar}
				<div className="min-h-0 flex-1 overflow-auto">{children}</div>
			</div>
		</div>
	)
}
