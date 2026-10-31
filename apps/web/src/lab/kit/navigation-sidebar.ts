import type { ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import { icon, type IconName } from "../../ui/icon"
import {
	sidebarContent,
	sidebarDesktop,
	sidebarFooter,
	sidebarGroup,
	sidebarGroupAction,
	sidebarGroupContent,
	sidebarGroupLabel,
	sidebarHeader,
	sidebarInset,
	sidebarMenu,
	sidebarMenuBadge,
	sidebarMenuButton,
	sidebarMenuItem,
	sidebarMenuSub,
	sidebarMenuSubButton,
	sidebarMenuSubItem,
	sidebarSeparator,
	type SidebarState,
	sidebarWrapper,
} from "../../ui/sidebar"

// `SidebarFrame`: a layout-contained frame holds the sidebar's
// fixed container, so an expanded and a collapsed sidebar sit side by side.

/** The app sidebar's group label (`GROUP_LABEL` in shell/view-sidebar.ts): muted, not bold white. */
const GROUP_LABEL = "h-6 text-muted-foreground"

const TELEMETRY: ReadonlyArray<
	Readonly<{ title: string; icon: IconName; badge?: string; isActive: boolean }>
> = [
	{ title: "Traces", icon: "ChartLineIcon", badge: "12", isActive: true },
	{ title: "Logs", icon: "UiLayersIcon", isActive: false },
	{ title: "Metrics", icon: "DatabaseIcon", isActive: false },
]

export type SidebarFrameOptions = Readonly<{
	name: string
	state: SidebarState
	/** The tooltip trigger attributes of the button titled `title` (the collapsed rail's tooltips). */
	tooltipTrigger: (title: string) => ReadonlyArray<ChildAttribute>
	/** The open tooltip's portal, if any. */
	tooltipPortal: Html | null
}>

export const sidebarFrame = <Message>(h: HtmlBuilder<Message>, options: SidebarFrameOptions): Html => {
	const menuButton = (title: string, iconName: IconName, isActive: boolean) =>
		sidebarMenuButton(h, { isActive, hasTooltip: true, attributes: options.tooltipTrigger(title) }, [
			icon(h, iconName),
			h.span([], [title]),
		])
	return h.section(
		[
			h.AriaLabel(options.name),
			h.Class("relative h-[480px] flex-1 overflow-hidden rounded-md border [contain:layout]"),
		],
		[
			sidebarWrapper(
				h,
				[
					sidebarDesktop(
						h,
						options.state,
						[
							sidebarHeader(h, [
								h.span(
									[
										h.Class(
											"truncate px-2 font-semibold text-sm group-data-[collapsible=icon]:hidden",
										),
									],
									["Maple"],
								),
								// Collapsed, the brand is a monogram tile like the app's org avatar, not "M…".
								h.span(
									[
										h.AriaHidden(true),
										h.Class(
											"hidden size-8 items-center justify-center rounded-md bg-primary font-semibold text-primary-foreground text-sm group-data-[collapsible=icon]:flex",
										),
									],
									["M"],
								),
							]),
							sidebarContent(h, [
								sidebarGroup(h, undefined, [
									sidebarGroupLabel(h, GROUP_LABEL, ["Telemetry"]),
									// Centred on the h-6 group label, not the shared style's h-8 one.
									sidebarGroupAction(h, { ariaLabel: "Add view", className: "top-2.5" }, [
										icon(h, "PlusIcon"),
									]),
									sidebarGroupContent(h, [
										sidebarMenu(
											h,
											undefined,
											TELEMETRY.map((item) =>
												sidebarMenuItem(h, undefined, [
													menuButton(item.title, item.icon, item.isActive),
													...(item.badge === undefined
														? []
														: [sidebarMenuBadge(h, [item.badge])]),
												]),
											),
										),
									]),
								]),
								sidebarSeparator(h),
								sidebarGroup(h, undefined, [
									sidebarGroupLabel(h, GROUP_LABEL, ["Infrastructure"]),
									sidebarMenu(h, undefined, [
										sidebarMenuItem(h, undefined, [
											menuButton("Hosts", "ServerIcon", false),
											sidebarMenuSub(h, undefined, [
												sidebarMenuSubItem(h, undefined, [
													sidebarMenuSubButton(
														h,
														{ isActive: true, href: "#kubernetes" },
														["Kubernetes"],
													),
												]),
												sidebarMenuSubItem(h, undefined, [
													sidebarMenuSubButton(
														h,
														{ isActive: false, href: "#railway" },
														["Railway"],
													),
												]),
											]),
										]),
									]),
								]),
							]),
							sidebarFooter(h, [
								sidebarMenu(h, undefined, [
									sidebarMenuItem(h, undefined, [
										menuButton("Alerts", "BellIcon", false),
										sidebarMenuBadge(h, ["3"]),
									]),
								]),
							]),
						],
						"h-full",
					),
					sidebarInset(h, [options.name], "p-4 text-muted-foreground text-sm"),
					...(options.tooltipPortal === null ? [] : [options.tooltipPortal]),
				],
				[],
				"h-full min-h-0",
			),
		],
	)
}
