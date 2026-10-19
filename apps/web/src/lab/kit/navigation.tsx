import {
	BellIcon,
	ChartLineIcon,
	DatabaseIcon,
	LayersIcon,
	PlusIcon,
	ServerIcon,
} from "@maple/ui/components/icons"
import {
	NavigationMenu,
	NavigationMenuContent,
	NavigationMenuItem,
	NavigationMenuLink,
	NavigationMenuList,
	NavigationMenuTrigger,
} from "@maple/ui/components/ui/navigation-menu"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@maple/ui/components/ui/resizable"
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarGroupAction,
	SidebarGroupContent,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarInset,
	SidebarMenu,
	SidebarMenuBadge,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarMenuSub,
	SidebarMenuSubButton,
	SidebarMenuSubItem,
	SidebarProvider,
	SidebarSeparator,
} from "@maple/ui/components/ui/sidebar"

import { KitPage, KitSection } from "./kit-layout"

const TELEMETRY = [
	{ title: "Traces", icon: ChartLineIcon, badge: "12", active: true },
	{ title: "Logs", icon: LayersIcon, badge: undefined, active: false },
	{ title: "Metrics", icon: DatabaseIcon, badge: undefined, active: false },
] as const

// A layout-contained frame is the containing block for the sidebar's `fixed` container,
// so an expanded and a collapsed sidebar can sit side by side on one page.
function SidebarFrame({ name, open }: { name: string; open: boolean }) {
	return (
		<section
			aria-label={name}
			className="relative h-[480px] flex-1 overflow-hidden rounded-md border [contain:layout]"
		>
			<SidebarProvider defaultOpen={open} className="h-full min-h-0">
				<Sidebar collapsible="icon" className="h-full">
					<SidebarHeader>
						<span className="truncate px-2 font-semibold text-sm">Maple</span>
					</SidebarHeader>
					<SidebarContent>
						<SidebarGroup>
							<SidebarGroupLabel>Telemetry</SidebarGroupLabel>
							<SidebarGroupAction aria-label="Add view">
								<PlusIcon />
							</SidebarGroupAction>
							<SidebarGroupContent>
								<SidebarMenu>
									{TELEMETRY.map((item) => (
										<SidebarMenuItem key={item.title}>
											<SidebarMenuButton isActive={item.active} tooltip={item.title}>
												<item.icon />
												<span>{item.title}</span>
											</SidebarMenuButton>
											{item.badge !== undefined ? (
												<SidebarMenuBadge>{item.badge}</SidebarMenuBadge>
											) : null}
										</SidebarMenuItem>
									))}
								</SidebarMenu>
							</SidebarGroupContent>
						</SidebarGroup>
						<SidebarSeparator />
						<SidebarGroup>
							<SidebarGroupLabel>Infrastructure</SidebarGroupLabel>
							<SidebarMenu>
								<SidebarMenuItem>
									<SidebarMenuButton tooltip="Hosts">
										<ServerIcon />
										<span>Hosts</span>
									</SidebarMenuButton>
									<SidebarMenuSub>
										<SidebarMenuSubItem>
											<SidebarMenuSubButton href="#kubernetes" isActive>
												Kubernetes
											</SidebarMenuSubButton>
										</SidebarMenuSubItem>
										<SidebarMenuSubItem>
											<SidebarMenuSubButton href="#railway">
												Railway
											</SidebarMenuSubButton>
										</SidebarMenuSubItem>
									</SidebarMenuSub>
								</SidebarMenuItem>
							</SidebarMenu>
						</SidebarGroup>
					</SidebarContent>
					<SidebarFooter>
						<SidebarMenu>
							<SidebarMenuItem>
								<SidebarMenuButton tooltip="Alerts">
									<BellIcon />
									<span>Alerts</span>
								</SidebarMenuButton>
								<SidebarMenuBadge>3</SidebarMenuBadge>
							</SidebarMenuItem>
						</SidebarMenu>
					</SidebarFooter>
				</Sidebar>
				<SidebarInset className="p-4 text-muted-foreground text-sm">{name}</SidebarInset>
			</SidebarProvider>
		</section>
	)
}

export function KitNavigationLab() {
	return (
		<KitPage
			title="Kit: navigation"
			description="Sidebar, navigation menu and resizable panels from @maple/ui."
		>
			<KitSection title="Navigation menu">
				<div className="min-h-40">
					<NavigationMenu defaultValue="product">
						<NavigationMenuList>
							<NavigationMenuItem value="product">
								<NavigationMenuTrigger>Product</NavigationMenuTrigger>
								<NavigationMenuContent>
									<ul className="grid w-96 grid-cols-2 gap-1 p-2">
										{["Traces", "Logs", "Metrics", "Session replay"].map((title) => (
											<li key={title}>
												<NavigationMenuLink
													href={`#${title.toLowerCase().replace(" ", "-")}`}
												>
													{title}
												</NavigationMenuLink>
											</li>
										))}
									</ul>
								</NavigationMenuContent>
							</NavigationMenuItem>
							<NavigationMenuItem value="docs">
								<NavigationMenuTrigger>Docs</NavigationMenuTrigger>
								<NavigationMenuContent>
									<div className="w-64 p-3 text-sm">Guides and API reference.</div>
								</NavigationMenuContent>
							</NavigationMenuItem>
							<NavigationMenuItem>
								<NavigationMenuLink href="#pricing">Pricing</NavigationMenuLink>
							</NavigationMenuItem>
						</NavigationMenuList>
					</NavigationMenu>
				</div>
			</KitSection>
			<KitSection title="Sidebar (expanded and collapsed)">
				<div className="flex gap-6">
					<SidebarFrame name="Expanded sidebar" open />
					<SidebarFrame name="Collapsed sidebar" open={false} />
				</div>
			</KitSection>
			<KitSection title="Resizable">
				<div className="h-40 overflow-hidden rounded-md border">
					<ResizablePanelGroup orientation="horizontal">
						<ResizablePanel defaultSize="40%">
							<div className="p-3 text-sm">Waterfall</div>
						</ResizablePanel>
						<ResizableHandle withHandle />
						<ResizablePanel defaultSize="60%">
							<ResizablePanelGroup orientation="vertical">
								<ResizablePanel defaultSize="50%">
									<div className="p-3 text-sm">Span details</div>
								</ResizablePanel>
								<ResizableHandle />
								<ResizablePanel defaultSize="50%">
									<div className="p-3 text-sm">Events</div>
								</ResizablePanel>
							</ResizablePanelGroup>
						</ResizablePanel>
					</ResizablePanelGroup>
				</div>
			</KitSection>
		</KitPage>
	)
}
