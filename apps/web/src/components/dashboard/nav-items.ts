import {
	BellIcon,
	ChartBarHorizontalIcon,
	ChartLineIcon,
	CircleWarningIcon,
	CloudflareIcon,
	CodeIcon,
	ComputerIcon,
	FileIcon,
	GridIcon,
	GridSquareCirclePlusIcon,
	HouseIcon,
	KubernetesIcon,
	LayersIcon,
	NetworkNodesIcon,
	PlanetScaleIcon,
	PlayRotateClockwiseIcon,
	PulseIcon,
	RailwayIcon,
	RocketIcon,
	ServerIcon,
	SquareSparkleIcon,
} from "@/components/icons"
import { KUBERNETES_ROOT, KUBERNETES_VIEWS } from "@/components/infra/kubernetes/views"
import { PLANETSCALE_COLOR } from "@/components/infra/planetscale/metrics"
import type { OrganizationFeatureFlags } from "@/lib/organization-feature-flags"

/**
 * What a nav child needs from the org before it's worth a row. The five OTel
 * surfaces come from the warehouse presence probe; Cloudflare, PlanetScale and
 * Railway are integration pages, so their gate is whether the integration is connected.
 */
export type NavSurface =
	| "hosts"
	| "containers"
	| "k8sPods"
	| "k8sNodes"
	| "k8sWorkloads"
	| "cloudflare"
	| "planetscale"
	| "railway"

export interface NavSubItem {
	title: string
	href: string
	icon?: typeof PulseIcon
	/**
	 * CSS color for marks drawn in `currentColor`. Brand marks that hardcode
	 * their own `fill` (Kubernetes, Cloudflare) already arrive in brand color and
	 * ignore this — PlanetScale ships its mark monochrome, so it needs the tint
	 * to sit beside them rather than reading as a disabled sibling.
	 */
	iconColor?: string
	/**
	 * Gate for this row: it shows when the org reports ANY of these. A child
	 * with no `surfaces` is unconditional. See `partitionInfraSubItems` for what
	 * happens when the gate says no.
	 */
	surfaces?: ReadonlyArray<NavSurface>
	/**
	 * Pages folded behind this row. They get no sidebar row of their own — that
	 * is the point of folding — but each stays typeable in ⌘K, prefixed with the
	 * row's title so "pods" still finds Kubernetes Pods.
	 */
	views?: ReadonlyArray<{ title: string; href: string; paletteTitle?: string }>
	/** The ⌘K title when the row's own title only makes sense inside its section. */
	paletteTitle?: string
}

export interface NavItem {
	title: string
	href: string
	icon: typeof PulseIcon
	/**
	 * Children revealed underneath the row while the section is active. A
	 * section counts as active when the path matches its own href *or* any
	 * child's, so a parent whose href follows its first child still lights up
	 * on the siblings.
	 */
	subItems?: NavSubItem[]
	badge?: string
}

export interface NavGroup {
	/** Stable key — labels are optional, so never key off them. */
	id: string
	/** Rendered uppercase. Omitted for the lead group so Overview reads as the root. */
	label?: string
	items: NavItem[]
}

const overviewItem: NavItem = {
	title: "Overview",
	href: "/",
	icon: HouseIcon,
}

/**
 * Overview is the section's front door: what needs a look across every source,
 * then one row per source. The rest are the sources an org reports or has
 * connected; the ones it doesn't have are offered on the Overview instead of
 * padded into the nav. Containers folds into Hosts as a view, the way Pods,
 * Nodes and Workloads fold into Kubernetes, and stays typeable in the palette
 * through `views`. Six children with six unique marks fits `NavRow`'s preview cap.
 */
const infrastructureItem: NavItem = {
	title: "Infrastructure",
	href: "/infra",
	icon: ComputerIcon,
	subItems: [
		{ title: "Overview", href: "/infra", icon: GridIcon, paletteTitle: "Infrastructure overview" },
		{
			title: "Hosts",
			href: "/infra/hosts",
			icon: ServerIcon,
			surfaces: ["hosts", "containers"],
			views: [{ title: "Containers", href: "/infra/containers", paletteTitle: "Containers" }],
		},
		{
			title: "Kubernetes",
			href: KUBERNETES_ROOT,
			icon: KubernetesIcon,
			// Any of the three: a cluster that only ships node metrics is still a
			// cluster, and the section's tabs handle the views that are empty.
			surfaces: ["k8sPods", "k8sNodes", "k8sWorkloads"],
			views: KUBERNETES_VIEWS,
		},
		{ title: "Cloudflare", href: "/infra/cloudflare", icon: CloudflareIcon, surfaces: ["cloudflare"] },
		{
			title: "PlanetScale",
			href: "/infra/planetscale",
			icon: PlanetScaleIcon,
			iconColor: PLANETSCALE_COLOR,
			surfaces: ["planetscale"],
		},
		{ title: "Railway", href: "/infra/railway", icon: RailwayIcon, surfaces: ["railway"] },
	],
}

/** Most brand glyphs a closed section previews; past this the preview is dropped. */
export const NAV_PREVIEW_MAX_GLYPHS = 6

export interface InfraSubItemSplit {
	/** What the org has, rendered directly under the section. */
	readonly shown: NavSubItem[]
	/** Sources the org doesn't report. Only the collapsed rail's menu lists them. */
	readonly hidden: NavSubItem[]
}

/**
 * The most specific of `sub`'s pages (its own href or a folded view) that the
 * path sits under, or undefined. Callers compare lengths, so Overview
 * (`/infra`, which prefixes every sibling) only wins on its own page.
 */
export function matchSubItem(currentPath: string, sub: NavSubItem): string | undefined {
	let best: string | undefined
	for (const href of [sub.href, ...(sub.views ?? []).map((view) => view.href)]) {
		if (!isPathActive(currentPath, href)) continue
		if (best === undefined || href.length > best.length) best = href
	}
	return best
}

/**
 * Splits Infrastructure's children into what an org has and what it doesn't.
 *
 * Two rules keep that from ever costing someone a page:
 *
 *  - `present: null` means the probe hasn't answered or has failed. Everything
 *    shows. A nav that hides rows because a query 500'd is worse than one
 *    listing a page you don't use.
 *  - The route you're on always shows, gate or no gate.
 */
export function partitionInfraSubItems(
	subItems: ReadonlyArray<NavSubItem>,
	present: ReadonlySet<NavSurface> | null,
	currentPath: string,
): InfraSubItemSplit {
	if (present === null) return { shown: [...subItems], hidden: [] }

	const reports = (sub: NavSubItem) => sub.surfaces?.some((surface) => present.has(surface)) ?? false
	const keep = (sub: NavSubItem): boolean =>
		!sub.surfaces || reports(sub) || matchSubItem(currentPath, sub) !== undefined

	const shown: NavSubItem[] = []
	const hidden: NavSubItem[] = []
	for (const sub of subItems) (keep(sub) ? shown : hidden).push(sub)
	return { shown, hidden }
}

/**
 * Traces, Logs, Metrics and Replays are one interaction — pick a time range,
 * filter, scan a list, open one — sharing a toolbar and a filter column. They
 * read as one section with four children rather than four top-level rows, using
 * the same reveal-when-active pattern Infrastructure already uses. The parent
 * href follows its first child; the underlying routes are unchanged.
 *
 * Every child carries an icon so the closed row can preview what's inside it
 * (see `NavRow`) — a section named "Explore" says nothing about the four
 * signals it hides.
 */
const exploreItem: NavItem = {
	title: "Explore",
	href: "/traces",
	icon: LayersIcon,
	subItems: [
		{ title: "Traces", href: "/traces", icon: PulseIcon },
		{ title: "Logs", href: "/logs", icon: FileIcon },
		{ title: "Metrics", href: "/metrics", icon: ChartLineIcon },
		{ title: "Replays", href: "/replays", icon: PlayRotateClockwiseIcon },
		{ title: "Agent Sessions", href: "/agent-sessions", icon: SquareSparkleIcon },
	],
}

/**
 * The sidebar's information architecture, and the single source the command
 * palette flattens. Anomalies is reachable at /anomalies but stays out of both
 * until the detector has been validated against production baselines.
 *
 * `flags` is *optional*, so a caller with no organization context yet hides a
 * flagged row rather than flashing it — a row that appears and then vanishes is
 * worse than one that arrives a beat late. Releases (`releases`) and Code
 * Review (`prReview`) are the rows behind staged rollouts right now.
 */
export function navGroups(flags?: OrganizationFeatureFlags): NavGroup[] {
	const analyzeItems: NavItem[] = [
		exploreItem,
		{ title: "Web Analytics", href: "/analytics", icon: ChartBarHorizontalIcon },
		{ title: "Dashboards", href: "/dashboards", icon: GridSquareCirclePlusIcon },
	]

	return [
		{ id: "overview", items: [overviewItem] },
		{
			id: "monitor",
			label: "Monitor",
			items: [
				{ title: "Services", href: "/services", icon: ServerIcon },
				// Behind the `releases` rollout flag while the page settles; the
				// route itself is open, this only decides who sees the row.
				...(flags?.releases ? [{ title: "Releases", href: "/releases", icon: RocketIcon }] : []),
				{ title: "Service Map", href: "/service-map", icon: NetworkNodesIcon },
				infrastructureItem,
			],
		},
		{
			id: "analyze",
			label: "Analyze",
			items: analyzeItems,
		},
		{
			id: "triage",
			label: "Triage",
			items: [
				// Investigations is not ready for users yet — the row stays out of the sidebar
				// (and out of the palette, which derives from these groups) until it ships.
				// { title: "Investigations", href: "/investigations", icon: MagnifierCheckIcon },
				{ title: "Errors", href: "/errors", icon: CircleWarningIcon },
				{ title: "Alerts", href: "/alerts", icon: BellIcon },
				// Behind the `prReview` rollout, like the reviewer itself.
				...(flags?.prReview ? [{ title: "Code Review", href: "/code-review", icon: CodeIcon }] : []),
			],
		},
	]
}

/**
 * Segment-aware prefix match. A bare `startsWith` lets /services claim
 * /service-map the moment two top-level routes share a prefix.
 */
export function isPathActive(currentPath: string, href: string): boolean {
	if (href === "/") return currentPath === "/" || currentPath === ""
	return currentPath === href || currentPath.startsWith(`${href}/`)
}

/** A section is active on its own href or on any of its children's. */
export function isNavItemActive(currentPath: string, item: NavItem): boolean {
	if (isPathActive(currentPath, item.href)) return true
	return item.subItems?.some((sub) => matchSubItem(currentPath, sub) !== undefined) ?? false
}

export interface PaletteNavEntry {
	id: string
	title: string
	href: string
	icon?: typeof PulseIcon
}

/**
 * Flattened nav for ⌘K: every section, every child, and every view a child
 * folds. Collapsing four rows into Explore must not cost a user the ability to
 * type "logs", and collapsing four Kubernetes rows into one must not cost them
 * "pods" — the entries here are what keep muscle memory working.
 */
export function paletteNavItems(flags?: OrganizationFeatureFlags): PaletteNavEntry[] {
	const entries: PaletteNavEntry[] = []
	const seen = new Set<string>()
	const push = (entry: PaletteNavEntry) => {
		const key = `${entry.title}:${entry.href}`
		if (seen.has(key)) return
		seen.add(key)
		entries.push(entry)
	}

	for (const group of navGroups(flags)) {
		for (const item of group.items) {
			push({ id: `nav:${item.title}`, title: item.title, href: item.href, icon: item.icon })
			for (const sub of item.subItems ?? []) {
				push({
					id: `nav:${item.title}:${sub.title}`,
					title: sub.paletteTitle ?? sub.title,
					href: sub.href,
					icon: sub.icon ?? item.icon,
				})
				for (const view of sub.views ?? []) {
					push({
						id: `nav:${item.title}:${sub.title}:${view.title}`,
						title: view.paletteTitle ?? `${sub.title} ${view.title}`,
						href: view.href,
						icon: sub.icon ?? item.icon,
					})
				}
			}
		}
	}

	return entries
}
