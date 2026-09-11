import { Link } from "@tanstack/react-router"

import { cn } from "@maple/ui/lib/utils"

import { ChartBarTrendUpIcon, LayersIcon } from "@/components/icons"
import { pickTimeRangeSearch, type TimeRangeSearch } from "@/components/time-range-picker/search"

/** The two readings of the same spans: the whole population, or one session at a time. */
export type AgentSessionsTab = "overview" | "sessions"

/**
 * The tab strip both Agent Sessions pages carry.
 *
 * Real links rather than a `Tabs` widget, because the two tabs are two routes:
 * middle-click and Copy link have to work, and the browser's own Back is what
 * undoes the switch. Only the window travels between them — the overview's
 * dimension filters mean nothing to a list that pages one session at a time.
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
		<nav className={cn("flex items-center", className)} aria-label="Agent sessions views">
			<TabLink
				to="/agent-sessions/overview"
				search={window}
				active={active === "overview"}
				icon={<ChartBarTrendUpIcon size={13} aria-hidden />}
			>
				Overview
			</TabLink>
			<TabLink
				to="/agent-sessions"
				search={{}}
				active={active === "sessions"}
				icon={<LayersIcon size={13} aria-hidden />}
			>
				Sessions
			</TabLink>
		</nav>
	)
}

function TabLink({
	to,
	search,
	active,
	icon,
	children,
}: {
	to: "/agent-sessions" | "/agent-sessions/overview"
	search: Record<string, unknown>
	active: boolean
	icon: React.ReactNode
	children: React.ReactNode
}) {
	return (
		<Link
			to={to}
			search={search}
			aria-current={active ? "page" : undefined}
			className={cn(
				"flex h-9 items-center gap-[7px] border-b-2 px-3 font-mono text-[12.5px] transition-colors first:pl-0.5",
				active
					? "border-primary font-medium text-foreground [&_svg]:text-primary"
					: "border-transparent text-muted-foreground hover:text-foreground [&_svg]:text-muted-foreground",
			)}
		>
			{icon}
			{children}
		</Link>
	)
}
