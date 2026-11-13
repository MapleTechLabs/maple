import { KUBERNETES_ROOT, KUBERNETES_VIEWS } from "../page/infra/kubernetes/views"
import { Schema, Array as Arr, String as Str } from "effect"
import type { IconName } from "@maple/views/ui/icon"
import { PROVIDERS } from "../page/kit/providers"

// The sidebar's nav tree and helpers, with generated icon names.

export const NavSurface = Schema.Literals([
	"hosts",
	"containers",
	"k8sPods",
	"k8sNodes",
	"k8sWorkloads",
	"cloudflare",
	"planetscale",
	"railway",
	"vercel",
	"supabase",
	"gcp",
	"aws",
])
export type NavSurface = typeof NavSurface.Type

export interface NavSubItem {
	readonly title: string
	readonly href: string
	readonly icon?: IconName
	readonly iconColor?: string
	readonly surfaces?: ReadonlyArray<NavSurface>
	readonly views?: ReadonlyArray<{
		readonly title: string
		readonly href: string
		readonly paletteTitle?: string
		/** The palette's glyph for a view whose parent's icon misnames it (Containers under Hosts). */
		readonly paletteIcon?: IconName
	}>
	/** The command palette's title, when the row's own reads ambiguously there. */
	readonly paletteTitle?: string
	/** Pages under another path that this row stands in for (schedules under On-call). */
	readonly alsoActive?: ReadonlyArray<string>
	/** A live count beside the title, read by the shell (the Inbox's unacknowledged incidents). */
	readonly count?: "alertsInbox"
	/** Starts a group of rows: a small gap above it, no heading. */
	readonly startsGroup?: boolean
}

export interface NavItem {
	readonly title: string
	readonly href: string
	readonly icon: IconName
	readonly subItems?: ReadonlyArray<NavSubItem>
	readonly badge?: string
	/** Routes with no row of their own that this row stands in for (`/anomalies` under Alerts). */
	readonly alsoActive?: ReadonlyArray<string>
}

export interface NavGroup {
	readonly id: string
	readonly label?: string
	readonly items: ReadonlyArray<NavItem>
}

type InfraProvider = "cloudflare" | "planetscale" | "railway" | "vercel" | "supabase" | "gcp" | "aws"

/** A provider's `/infra` page row, named and marked by the provider registry. */
const providerItem = (id: InfraProvider, iconColor?: string): NavSubItem => ({
	title: PROVIDERS[id].name,
	href: PROVIDERS[id].infraHref,
	icon: PROVIDERS[id].icon,
	iconColor,
	surfaces: [id],
})

export const NAV_PREVIEW_MAX_GLYPHS = 7

const infrastructureItem: NavItem = {
	title: "Infrastructure",
	href: "/infra",
	icon: "ComputerIcon",
	subItems: [
		{ title: "Overview", href: "/infra", icon: "GridIcon", paletteTitle: "Infrastructure overview" },
		{
			title: "Hosts",
			href: "/infra/hosts",
			icon: "ServerIcon",
			surfaces: ["hosts", "containers"],
			views: [
				{
					title: "Containers",
					href: "/infra/containers",
					paletteTitle: "Containers",
					paletteIcon: "DockerIcon",
				},
			],
		},
		{
			title: "Kubernetes",
			href: KUBERNETES_ROOT,
			icon: "KubernetesIcon",
			surfaces: ["k8sPods", "k8sNodes", "k8sWorkloads"],
			views: KUBERNETES_VIEWS,
		},
		providerItem("cloudflare"),
		providerItem("planetscale", PROVIDERS.planetscale.accent),
		providerItem("railway"),
		providerItem("vercel"),
		providerItem("supabase"),
		providerItem("gcp"),
		providerItem("aws"),
	],
}

const servicesItem: NavItem = {
	title: "Services",
	href: "/services",
	icon: "ServerIcon",
	subItems: [
		{ title: "All services", href: "/services", icon: "UnorderedListIcon", paletteTitle: "Services" },
		{ title: "Map", href: "/service-map", icon: "NetworkNodesIcon", paletteTitle: "Service map" },
	],
}

const exploreItem: NavItem = {
	title: "Explore",
	href: "/traces",
	icon: "LayersIcon",
	subItems: [
		{ title: "Traces", href: "/traces", icon: "PulseIcon" },
		{ title: "Logs", href: "/logs", icon: "FileIcon" },
		{ title: "Metrics", href: "/metrics", icon: "ChartLineIcon" },
		{ title: "Replays", href: "/replays", icon: "PlayRotateClockwiseIcon" },
		{ title: "Agent sessions", href: "/agent-sessions", icon: "SquareSparkleIcon" },
		{ title: "MCP servers", href: "/mcp-servers", icon: "PlugIcon" },
	],
}

const alertsItem: NavItem = {
	title: "Alerts",
	href: "/alerts",
	icon: "BellIcon",
	alsoActive: ["/anomalies"],
	subItems: [
		{
			title: "Inbox",
			href: "/alerts",
			icon: "BellIcon",
			paletteTitle: "Alerts",
			alsoActive: ["/anomalies"],
			count: "alertsInbox",
		},
		{
			title: "Rules",
			href: "/alerts/rules",
			icon: "ChartLineIcon",
			paletteTitle: "Alert rules",
			alsoActive: ["/alerts/create"],
			startsGroup: true,
		},
		{ title: "Uptime", href: "/alerts/uptime", icon: "GlobeIcon", paletteTitle: "Uptime checks" },
		{ title: "SLOs", href: "/alerts/slos", icon: "GaugeIcon" },
		{ title: "Silences", href: "/alerts/silences", icon: "BellSlashIcon", startsGroup: true },
		{
			title: "Maintenance",
			href: "/alerts/maintenance",
			icon: "CalendarIcon",
			paletteTitle: "Maintenance windows",
		},
		{
			title: "On-call",
			href: "/alerts/on-call",
			icon: "UsersIcon",
			alsoActive: ["/alerts/schedules"],
			startsGroup: true,
		},
		{
			title: "Routing",
			href: "/alerts/routing",
			icon: "BranchForkIcon",
			paletteTitle: "Alert routing",
			alsoActive: ["/alerts/escalation-chains"],
		},
	],
}

/** The observer's Alerts: what is wrong now and how reliable things are, without the setup pages. */
const observerIncidentsItem: NavItem = {
	title: "Incidents",
	href: "/alerts",
	icon: "BellIcon",
	alsoActive: ["/anomalies"],
	subItems: [
		{
			title: "Inbox",
			href: "/alerts",
			icon: "BellIcon",
			paletteTitle: "Incidents",
			alsoActive: ["/anomalies"],
			count: "alertsInbox",
		},
		{ title: "Uptime", href: "/alerts/uptime", icon: "GlobeIcon", paletteTitle: "Uptime checks" },
		{ title: "SLOs", href: "/alerts/slos", icon: "GaugeIcon" },
	],
}

/**
 * Who the sidebar is drawn for. An observer follows the product without operating it, so they get
 * the pages that answer "is it working and how is it doing", not the ones for digging or setup.
 */
export const NavAudience = Schema.Literals(["operator", "observer"])
export type NavAudience = typeof NavAudience.Type

/** The org rollout flags that gate a nav row each. */
export type NavFlags = Readonly<{
	cloudCost: boolean
	releases: boolean
	securityAudit: boolean
	statusPages: boolean
}>

const observerNavGroups = (flags: NavFlags): ReadonlyArray<NavGroup> => [
	{ id: "overview", items: [{ title: "Overview", href: "/", icon: "HouseIcon" }] },
	{
		id: "reliability",
		label: "Reliability",
		items: [
			observerIncidentsItem,
			{ title: "Errors", href: "/errors", icon: "CircleWarningIcon" },
			...(flags.statusPages
				? [{ title: "Status pages", href: "/status-pages", icon: "WindowChartLineIcon" } as const]
				: []),
		],
	},
	{
		id: "product",
		label: "Product",
		items: [
			{ title: "Web analytics", href: "/analytics", icon: "ChartBarHorizontalIcon" },
			{ title: "Users", href: "/users", icon: "UsersIcon" },
			{ title: "Replays", href: "/replays", icon: "PlayRotateClockwiseIcon" },
			{ title: "Dashboards", href: "/dashboards", icon: "GridSquareCirclePlusIcon" },
			...(flags.releases
				? [{ title: "Releases", href: "/releases", icon: "RocketIcon" } as const]
				: []),
			...(flags.cloudCost
				? [{ title: "Cost", href: "/cost", icon: "CircleDollarIcon", badge: "Beta" } as const]
				: []),
		],
	},
]

const operatorNavGroups = (flags: NavFlags): ReadonlyArray<NavGroup> => [
	{ id: "overview", items: [{ title: "Overview", href: "/", icon: "HouseIcon" }] },
	{
		id: "monitor",
		label: "Monitor",
		items: [
			{
				...servicesItem,
				alsoActive: [
					...(flags.releases ? [] : ["/releases"]),
					...(flags.statusPages ? [] : ["/status-pages"]),
				],
			},
			...(flags.releases
				? [{ title: "Releases", href: "/releases", icon: "RocketIcon" } as const]
				: []),
			infrastructureItem,
			...(flags.cloudCost
				? [{ title: "Cost", href: "/cost", icon: "CircleDollarIcon", badge: "Beta" } as const]
				: []),
		],
	},
	{
		id: "analyze",
		label: "Analyze",
		items: [
			exploreItem,
			{ title: "Web analytics", href: "/analytics", icon: "ChartBarHorizontalIcon" },
			{ title: "Users", href: "/users", icon: "UsersIcon" },
			{ title: "Dashboards", href: "/dashboards", icon: "GridSquareCirclePlusIcon" },
		],
	},
	{
		id: "triage",
		label: "Triage",
		items: [
			{ title: "Errors", href: "/errors", icon: "CircleWarningIcon" },
			alertsItem,
			{
				title: "Review & CI",
				href: "/code-review",
				icon: "PullRequestIcon",
				alsoActive: flags.securityAudit ? [] : ["/security"],
			},
			...(flags.securityAudit
				? [{ title: "Security", href: "/security", icon: "ShieldCheckIcon", badge: "Beta" } as const]
				: []),
			...(flags.statusPages
				? [{ title: "Status pages", href: "/status-pages", icon: "WindowChartLineIcon" } as const]
				: []),
		],
	},
]

/**
 * `navGroups(flags, audience)`; `cloudCost`, `releases`, `securityAudit` and `statusPages` gate a
 * row each, and an observer gets {@link observerNavGroups}.
 */
export const navGroups = (flags: NavFlags, audience: NavAudience = "operator"): ReadonlyArray<NavGroup> =>
	audience === "observer" ? observerNavGroups(flags) : operatorNavGroups(flags)

/** Segment-aware prefix match: `/services` must not claim `/service-map`. */
export const isPathActive = (currentPath: string, href: string): boolean =>
	href === "/"
		? currentPath === "/" || currentPath === ""
		: currentPath === href || Str.startsWith(`${href}/`)(currentPath)

export const matchSubItem = (currentPath: string, sub: NavSubItem): string | undefined =>
	Arr.reduce<string, string | undefined>(
		Arr.filter(
			[sub.href, ...Arr.map(sub.views ?? [], (view) => view.href), ...(sub.alsoActive ?? [])],
			(href) => isPathActive(currentPath, href),
		),
		undefined,
		(best, href) => (best === undefined || href.length > best.length ? href : best),
	)

export const isNavItemActive = (currentPath: string, item: NavItem): boolean =>
	isPathActive(currentPath, item.href) ||
	Arr.some(item.alsoActive ?? [], (href) => isPathActive(currentPath, href)) ||
	Arr.some(item.subItems ?? [], (sub) => matchSubItem(currentPath, sub) !== undefined)

/** The Alerts row is open here, so its Inbox count is shown (and worth reading). */
export const isAlertsOpenAt = (currentPath: string): boolean => isNavItemActive(currentPath, alertsItem)

export interface NavPreview {
	readonly glyphs: ReadonlyArray<NavSubItem>
	/** Marks past the cap, drawn as `+N`. */
	readonly overflow: number
}

/**
 * Brand marks of a closed section: what the org reports (every mark when nothing does), deduplicated,
 * the section's own page left out, capped at `NAV_PREVIEW_MAX_GLYPHS` with the rest as a count.
 */
export const navPreview = (item: NavItem, shown: ReadonlyArray<NavSubItem>): NavPreview | undefined => {
	const subItems = item.subItems
	if (subItems === undefined || !Arr.some(subItems, (sub) => sub.iconColor !== undefined)) return undefined
	const marked = (list: ReadonlyArray<NavSubItem>) =>
		Arr.filter(list, (sub) => sub.href !== item.href && sub.icon !== undefined)
	const reporting = marked(shown)
	const candidates = reporting.length > 0 ? reporting : marked(subItems)
	const unique = Arr.dedupeWith(candidates, (a, b) => a.icon === b.icon)
	if (unique.length <= NAV_PREVIEW_MAX_GLYPHS) return { glyphs: unique, overflow: 0 }
	const glyphs = unique.slice(0, NAV_PREVIEW_MAX_GLYPHS - 1)
	return { glyphs, overflow: unique.length - glyphs.length }
}

/** What the org reports shows; the rest only in the collapsed rail's menu. `null`: everything shows. */
export const partitionSubItems = (
	subItems: ReadonlyArray<NavSubItem>,
	present: ReadonlySet<NavSurface> | null,
	currentPath: string,
): { readonly shown: ReadonlyArray<NavSubItem>; readonly hidden: ReadonlyArray<NavSubItem> } => {
	if (present === null) return { shown: subItems, hidden: [] }
	const keep = (sub: NavSubItem) =>
		sub.surfaces === undefined ||
		Arr.some(sub.surfaces, (surface) => present.has(surface)) ||
		matchSubItem(currentPath, sub) !== undefined
	return { shown: Arr.filter(subItems, keep), hidden: Arr.filter(subItems, (sub) => !keep(sub)) }
}
