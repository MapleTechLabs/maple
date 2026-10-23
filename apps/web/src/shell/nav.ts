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
			views: [{ title: "Containers", href: "/infra/containers", paletteTitle: "Containers" }],
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

/** `navGroups(flags)`; only `releases` gates a row today. */
export const navGroups = (flags: Readonly<{ releases: boolean }>): ReadonlyArray<NavGroup> => [
	{ id: "overview", items: [{ title: "Overview", href: "/", icon: "HouseIcon" }] },
	{
		id: "monitor",
		label: "Monitor",
		items: [
			{ title: "Services", href: "/services", icon: "ServerIcon" },
			...(flags.releases
				? [{ title: "Releases", href: "/releases", icon: "RocketIcon" } as const]
				: []),
			{ title: "Service Map", href: "/service-map", icon: "NetworkNodesIcon" },
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
			{ title: "Alerts", href: "/alerts", icon: "BellIcon" },
			{ title: "Code Review", href: "/code-review", icon: "CodeIcon", badge: "Beta" },
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
	(item.subItems?.some((sub) => matchSubItem(currentPath, sub) !== undefined) ?? false)

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
