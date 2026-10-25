import { formatToolCount } from "@maple/web-data/lib/tool-analytics"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { underlineTabClass, underlineTabStrip } from "../../kit/underline-tabs"

// The agent sessions tabs: two route links. A link is active by path prefix, so Sessions is
// active on both pages.

export type AgentSessionsTab = "sessions" | "tools"

export type TimeRangeSearch = Readonly<{ startTime?: string; endTime?: string; timePreset?: string }>

/** `pickTimeRangeSearch`: only the window travels between the two tabs. */
const pickWindow = (search: TimeRangeSearch | undefined): TimeRangeSearch =>
	search === undefined
		? {}
		: { startTime: search.startTime, endTime: search.endTime, timePreset: search.timePreset }

const tabLink = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		href: string
		isActive: boolean
		isLinkActive: boolean
		label: string
		count: number | undefined
	}>,
): Html =>
	h.a(
		[
			...(options.isActive || options.isLinkActive ? [h.AriaCurrent("page")] : []),
			h.Class(
				cn(
					underlineTabClass(options.isActive),
					"h-9 px-3 first:pl-0.5",
					options.isLinkActive && "active",
				),
			),
			...(options.isLinkActive ? [h.DataAttribute("status", "active")] : []),
			h.Href(options.href),
		],
		[
			options.label,
			...(options.count === undefined
				? []
				: [
						h.span(
							[
								h.Class(
									cn(
										"text-2xs tabular-nums",
										options.isActive ? "text-muted-foreground" : "text-muted-foreground/60",
									),
								),
							],
							[formatToolCount(options.count)],
						),
					]),
		],
	)

export const agentSessionsTabs = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		active: AgentSessionsTab
		search?: TimeRangeSearch
		counts?: Readonly<{ sessions?: number; tools?: number }>
		className?: string
		/** `false` off the agent sessions routes (a lab): the router marks no link active. */
		isOnRoute?: boolean
	}>,
): Html =>
	underlineTabStrip(
		h,
		{
			label: "Agent sessions views",
			navigation: true,
			bleed: false,
			divided: false,
			className: cn("gap-0 overflow-visible", options.className),
		},
		[
			tabLink(h, {
				href: hrefOf(AppRoute.AgentSessions({ search: {} })),
				isActive: options.active === "sessions",
				isLinkActive: options.isOnRoute ?? true,
				label: "Sessions",
				count: options.counts?.sessions,
			}),
			tabLink(h, {
				href: hrefOf(AppRoute.AgentSessionTools({ search: pickWindow(options.search) })),
				isActive: options.active === "tools",
				isLinkActive: (options.isOnRoute ?? true) && options.active === "tools",
				label: "Tools",
				count: options.counts?.tools,
			}),
		],
	)
