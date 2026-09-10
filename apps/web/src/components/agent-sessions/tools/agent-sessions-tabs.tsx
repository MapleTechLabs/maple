import { Link } from "@tanstack/react-router"

import { cn } from "@maple/ui/lib/utils"

import { pickTimeRangeSearch, type TimeRangeSearch } from "@/components/time-range-picker/search"

/** The two readings of the same spans: one session at a time, or one tool across all of them. */
export type AgentSessionsTab = "sessions" | "tools"

/**
 * The tab strip both Agent Sessions pages carry.
 *
 * Real links rather than a `Tabs` widget, because the two tabs are two routes:
 * middle-click and Copy link have to work, and the browser's own Back is what
 * undoes the switch. Only the window travels between them — a tool selection
 * means nothing to the sessions list, and the list's vendor/agent filters mean
 * nothing here.
 *
 * The Sessions list has no time picker (it is fixed to a rolling week), so a
 * jump from there carries no window and this page falls back to its own default.
 */
export function AgentSessionsTabs({
	active,
	search,
	className,
}: {
	active: AgentSessionsTab
	/** The current window, carried across. Absent from the Sessions list, which has none. */
	search?: TimeRangeSearch
	className?: string
}) {
	const window = search === undefined ? {} : pickTimeRangeSearch(search)
	return (
		<nav className={cn("flex items-center gap-1", className)} aria-label="Agent sessions views">
			<TabLink to="/agent-sessions" search={{}} active={active === "sessions"}>
				Sessions
			</TabLink>
			<TabLink to="/agent-sessions/tools" search={window} active={active === "tools"}>
				Tools
			</TabLink>
		</nav>
	)
}

function TabLink({
	to,
	search,
	active,
	children,
}: {
	to: "/agent-sessions" | "/agent-sessions/tools"
	search: Record<string, unknown>
	active: boolean
	children: React.ReactNode
}) {
	return (
		<Link
			to={to}
			search={search}
			aria-current={active ? "page" : undefined}
			className={cn(
				"rounded-sm px-2 py-0.5 text-[12px] transition-colors",
				active
					? "bg-muted font-medium text-foreground"
					: "text-muted-foreground hover:text-foreground",
			)}
		>
			{children}
		</Link>
	)
}
