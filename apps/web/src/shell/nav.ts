import { KUBERNETES_ROOT, KUBERNETES_VIEWS } from "../components/infra/kubernetes/views"
import { Schema } from "effect"
import type { IconName } from "../ui/icon"

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

/** `PLANETSCALE_COLOR` (packages/ui/src/components/service-map/service-map-db.tsx). */
const PLANETSCALE_COLOR = "oklch(0.62 0.02 270)"

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
		{
			title: "Cloudflare",
			href: "/infra/cloudflare",
			icon: "CloudflareBrandIcon",
			surfaces: ["cloudflare"],
		},
		{
			title: "PlanetScale",
			href: "/infra/planetscale",
			icon: "PlanetScaleIcon",
			iconColor: PLANETSCALE_COLOR,
			surfaces: ["planetscale"],
		},
		{ title: "Railway", href: "/infra/railway", icon: "RailwayIcon", surfaces: ["railway"] },
		{ title: "Supabase", href: "/infra/supabase", icon: "SupabaseIcon", surfaces: ["supabase"] },
		{ title: "Google Cloud", href: "/infra/gcp", icon: "GoogleCloudIcon", surfaces: ["gcp"] },
		{ title: "AWS", href: "/infra/aws", icon: "AwsIcon", surfaces: ["aws"] },
	],
}
// GROUPS

const servicesItem: NavItem = {
	title: "Services",
	href: "/services",
	icon: "ServerIcon",
	subItems: [
		{ title: "All services", href: "/services", icon: "UnorderedListIcon", paletteTitle: "Services" },
		{ title: "Map", href: "/service-map", icon: "NetworkNodesIcon", paletteTitle: "Service Map" },
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
		{ title: "Agent Sessions", href: "/agent-sessions", icon: "SquareSparkleIcon" },
	],
}

/** `navGroups(flags)`; `releases` and `securityAudit` gate a row each. */
export const navGroups = (
	flags: Readonly<{ releases: boolean; securityAudit: boolean }>,
): ReadonlyArray<NavGroup> => [
	{ id: "overview", items: [{ title: "Overview", href: "/", icon: "HouseIcon" }] },
	{
		id: "monitor",
		label: "Monitor",
		items: [
			{ ...servicesItem, alsoActive: flags.releases ? [] : ["/releases"] },
			...(flags.releases
				? [{ title: "Releases", href: "/releases", icon: "RocketIcon" } as const]
				: []),
			infrastructureItem,
		],
	},
	{
		id: "analyze",
		label: "Analyze",
		items: [
			exploreItem,
			{ title: "Web Analytics", href: "/analytics", icon: "ChartBarHorizontalIcon" },
			{ title: "Dashboards", href: "/dashboards", icon: "GridSquareCirclePlusIcon" },
		],
	},
	{
		id: "triage",
		label: "Triage",
		items: [
			{ title: "Errors", href: "/errors", icon: "CircleWarningIcon" },
			{ title: "Alerts", href: "/alerts", icon: "BellIcon", alsoActive: ["/anomalies"] },
			{
				title: "Code Review",
				href: "/code-review",
				icon: "CodeIcon",
				badge: "Beta",
				alsoActive: flags.securityAudit ? [] : ["/security"],
			},
			...(flags.securityAudit
				? [{ title: "Security", href: "/security", icon: "ShieldCheckIcon", badge: "Beta" } as const]
				: []),
		],
	},
]

/** Segment-aware prefix match: `/services` must not claim `/service-map`. */
export const isPathActive = (currentPath: string, href: string): boolean =>
	href === "/"
		? currentPath === "/" || currentPath === ""
		: currentPath === href || currentPath.startsWith(`${href}/`)

export const matchSubItem = (currentPath: string, sub: NavSubItem): string | undefined =>
	[sub.href, ...(sub.views ?? []).map((view) => view.href)]
		.filter((href) => isPathActive(currentPath, href))
		.reduce<string | undefined>(
			(best, href) => (best === undefined || href.length > best.length ? href : best),
			undefined,
		)

export const isNavItemActive = (currentPath: string, item: NavItem): boolean =>
	isPathActive(currentPath, item.href) ||
	(item.alsoActive?.some((href) => isPathActive(currentPath, href)) ?? false) ||
	(item.subItems?.some((sub) => matchSubItem(currentPath, sub) !== undefined) ?? false)

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
	if (subItems === undefined || !subItems.some((sub) => sub.iconColor !== undefined)) return undefined
	const marked = (list: ReadonlyArray<NavSubItem>) =>
		list.filter((sub) => sub.href !== item.href && sub.icon !== undefined)
	const reporting = marked(shown)
	const candidates = reporting.length > 0 ? reporting : marked(subItems)
	const unique = candidates.filter(
		(sub, index) => candidates.findIndex((other) => other.icon === sub.icon) === index,
	)
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
		sub.surfaces.some((surface) => present.has(surface)) ||
		matchSubItem(currentPath, sub) !== undefined
	return { shown: subItems.filter(keep), hidden: subItems.filter((sub) => !keep(sub)) }
}
