import { formatNumber } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { icon } from "../../../ui/icon"
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
		iconName: "LayersIcon" | "GearIcon"
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
					"px-3 font-mono text-xs first:pl-0.5",
					options.isActive ? "[&_svg]:text-foreground" : "[&_svg]:text-muted-foreground",
					options.isLinkActive && "active",
				),
			),
			...(options.isLinkActive ? [h.DataAttribute("status", "active")] : []),
			h.Href(options.href),
		],
		[
			icon(h, options.iconName, { size: 14, attributes: [h.AriaHidden(true)] }),
			options.label,
			...(options.count === undefined
				? []
				: [
						h.span(
							[
								h.Class(
									cn(
										"text-2xs tabular-nums",
										options.isActive
											? "text-muted-foreground"
											: "text-foreground-subtle",
									),
								),
							],
							[formatNumber(options.count)],
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
				iconName: "LayersIcon",
				label: "Sessions",
				count: options.counts?.sessions,
			}),
			tabLink(h, {
				href: hrefOf(AppRoute.AgentSessionTools({ search: pickWindow(options.search) })),
				isActive: options.active === "tools",
				isLinkActive: (options.isOnRoute ?? true) && options.active === "tools",
				iconName: "GearIcon",
				label: "Tools",
				count: options.counts?.tools,
			}),
		],
	)
