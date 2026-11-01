import { formatToolCount } from "@maple/web-data/lib/tool-analytics"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { linkTabStrip } from "../../kit/underline-tabs"

// The agent sessions tabs: two route links on the kit's `linkTabStrip`.

export type AgentSessionsTab = "sessions" | "tools"

export type TimeRangeSearch = Readonly<{ startTime?: string; endTime?: string; timePreset?: string }>

/** `pickTimeRangeSearch`: only the window travels between the two tabs. */
const pickWindow = (search: TimeRangeSearch | undefined): TimeRangeSearch =>
	search === undefined
		? {}
		: { startTime: search.startTime, endTime: search.endTime, timePreset: search.timePreset }

const countOf = (count: number | undefined): string | undefined =>
	count === undefined ? undefined : formatToolCount(count)

export const agentSessionsTabs = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		active: AgentSessionsTab
		search?: TimeRangeSearch
		counts?: Readonly<{ sessions?: number; tools?: number }>
		/** `false` off the agent sessions routes (a lab): the router marks no link active. */
		isOnRoute?: boolean
	}>,
): Html => {
	const isOnRoute = options.isOnRoute ?? true
	return linkTabStrip(h, "Agent sessions views", [
		{
			key: "sessions",
			href: hrefOf(AppRoute.AgentSessions({ search: {} })),
			label: "Sessions",
			icon: "LayersIcon",
			count: countOf(options.counts?.sessions),
			isCurrent: options.active === "sessions",
			isRouteActive: isOnRoute && options.active === "sessions",
		},
		{
			key: "tools",
			href: hrefOf(AppRoute.AgentSessionTools({ search: pickWindow(options.search) })),
			label: "Tools",
			icon: "GearIcon",
			count: countOf(options.counts?.tools),
			isCurrent: options.active === "tools",
			isRouteActive: isOnRoute && options.active === "tools",
		},
	])
}
