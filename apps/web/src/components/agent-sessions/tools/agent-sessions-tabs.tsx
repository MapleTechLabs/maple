import { Link } from "@tanstack/react-router"

import { formatToolCount } from "@/lib/agent-sessions/tool-analytics"
import { cn } from "@maple/ui/lib/utils"

import { UnderlineTabStrip, underlineTabClass } from "@/components/common/underline-link-tabs"

import { GearIcon, LayersIcon } from "@/components/icons"
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
	counts,
	className,
}: {
	active: AgentSessionsTab
	/** The current window, carried across. Absent from the Sessions list, which has none. */
	search?: TimeRangeSearch
	/** Shown beside the label where the page knows the number. */
	counts?: { sessions?: number; tools?: number }
	className?: string
}) {
	const window = search === undefined ? {} : pickTimeRangeSearch(search)
	return (
		<UnderlineTabStrip
			navigation
			label="Agent sessions views"
			bleed={false}
			divided={false}
			className={cn("gap-0 overflow-visible", className)}
		>
			<TabLink
				to="/agent-sessions"
				search={{}}
				active={active === "sessions"}
				icon={<LayersIcon size={13} aria-hidden />}
				count={counts?.sessions}
			>
				Sessions
			</TabLink>
			<TabLink
				to="/agent-sessions/tools"
				search={{ ...window }}
				active={active === "tools"}
				icon={<GearIcon size={13} aria-hidden />}
				count={counts?.tools}
			>
				Tools
			</TabLink>
		</UnderlineTabStrip>
	)
}

function TabLink({
	to,
	search,
	active,
	icon,
	count,
	children,
}: {
	to: "/agent-sessions" | "/agent-sessions/tools"
	search: Record<string, unknown>
	active: boolean
	icon: React.ReactNode
	count?: number
	children: React.ReactNode
}) {
	return (
		<Link
			to={to}
			search={search}
			aria-current={active ? "page" : undefined}
			className={cn(
				underlineTabClass(active),
				"px-3 font-mono text-xs first:pl-0.5",
				active ? "[&_svg]:text-primary" : "[&_svg]:text-muted-foreground",
			)}
		>
			{icon}
			{children}
			{count === undefined ? null : (
				<span
					className={cn(
						"text-2xs tabular-nums",
						active ? "text-primary" : "text-muted-foreground/60",
					)}
				>
					{formatToolCount(count)}
				</span>
			)}
		</Link>
	)
}
