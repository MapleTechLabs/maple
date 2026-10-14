// Section nav as a collapsible sidebar, grouped and iconed like apps/web's so
// moving between cloud and local keeps the same map. ⌘B or the rail collapses it.

import type { ComponentType } from "react"
import {
	ChartLineIcon,
	CircleWarningIcon,
	FileIcon,
	LayersIcon,
	NetworkNodesIcon,
	PlayRotateClockwiseIcon,
	PulseIcon,
	ServerIcon,
	type IconProps,
} from "@maple/ui/components/icons"
import { ROW_LANE } from "@maple/ui/components/ui/list-row"
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarGroupContent,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarRail,
	SidebarTrigger,
	useSidebar,
} from "@maple/ui/components/ui/sidebar"
import { hrefFor } from "../lib/router"
import { ConnectButton } from "./connect-button"
import { IngestStatus } from "./ingest-status"
import { LocalLockup } from "./local-lockup"

export type Section =
	| "traces"
	| "logs"
	| "metrics"
	| "services"
	| "service-map"
	| "errors"
	| "sessions"
	| "query"

interface NavItem {
	readonly section: Section
	readonly label: string
	readonly icon: ComponentType<IconProps>
}

const NAV_GROUPS: ReadonlyArray<{ label: string; items: ReadonlyArray<NavItem> }> = [
	{
		label: "Monitor",
		items: [
			{ section: "services", label: "Services", icon: ServerIcon },
			{ section: "service-map", label: "Service map", icon: NetworkNodesIcon },
		],
	},
	{
		label: "Explore",
		items: [
			{ section: "traces", label: "Traces", icon: PulseIcon },
			{ section: "logs", label: "Logs", icon: FileIcon },
			{ section: "metrics", label: "Metrics", icon: ChartLineIcon },
			{ section: "sessions", label: "Sessions", icon: PlayRotateClockwiseIcon },
			{ section: "query", label: "Query", icon: LayersIcon },
		],
	},
	{
		label: "Triage",
		items: [{ section: "errors", label: "Errors", icon: CircleWarningIcon }],
	},
]

/** Same selected-row rail as apps/web's sidebar: a 2px lane only the active row paints. */
const ACTIVE_RAIL = `${ROW_LANE} data-[active=true]:rounded-l-none data-[active=true]:before:bg-sidebar-primary data-[active=true]:text-sidebar-primary`

export function AppSidebar({
	active,
	linkQuery,
}: {
	active: Section
	/** Cross-cutting context every section link carries (range, service filter). */
	linkQuery: URLSearchParams
}) {
	// Hash links never unmount the mobile drawer, so close it on the way out.
	const { setOpenMobile } = useSidebar()
	return (
		<Sidebar collapsible="icon">
			<SidebarHeader className="h-12 flex-row items-center px-4 group-data-[collapsible=icon]:px-2">
				<LocalLockup />
			</SidebarHeader>
			<SidebarContent>
				{NAV_GROUPS.map((group) => (
					<SidebarGroup key={group.label}>
						<SidebarGroupLabel className="h-6 text-muted-foreground">
							{group.label}
						</SidebarGroupLabel>
						<SidebarGroupContent>
							<SidebarMenu>
								{group.items.map((item) => (
									<SidebarMenuItem key={item.section}>
										<SidebarMenuButton
											className={ACTIVE_RAIL}
											isActive={active === item.section}
											aria-current={active === item.section ? "page" : undefined}
											render={
												<a
													href={hrefFor(`/${item.section}`, linkQuery)}
													onClick={() => setOpenMobile(false)}
												/>
											}
											tooltip={item.label}
										>
											<item.icon size={18} />
											<span>{item.label}</span>
										</SidebarMenuButton>
									</SidebarMenuItem>
								))}
							</SidebarMenu>
						</SidebarGroupContent>
					</SidebarGroup>
				))}
			</SidebarContent>
			<SidebarFooter>
				<IngestStatus />
				<div className="flex items-center gap-1 group-data-[collapsible=icon]:flex-col">
					<ConnectButton />
					<SidebarTrigger className="hidden size-8 md:inline-flex" />
				</div>
			</SidebarFooter>
			<SidebarRail />
		</Sidebar>
	)
}
