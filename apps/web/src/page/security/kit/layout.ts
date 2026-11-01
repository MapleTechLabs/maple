import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import type { BreadcrumbEntry } from "../../../shell"
import type { IconName } from "../../../ui/icon"
import { pageTitle } from "../../../ui/page-layout"
import { dashboardPage, type DashboardPageOptions } from "../../kit/dashboard-page"
import { linkTabStrip } from "../../kit/underline-tabs"
import { navShell, type NavShellSection } from "../../settings/kit/nav-shell"
// The frame of each Security source's page: the rail of sources, the source's title block, content.
// The code security audit is the one source with tabs of its own (Overview, Findings, Runs).

export type SecuritySource = "code" | "dependencies" | "runtimes" | "exposure"
export type CodeTab = "overview" | "findings" | "runs"

const SOURCE_LABEL = {
	code: "Code security audit",
	dependencies: "Dependencies",
	runtimes: "Runtimes",
	exposure: "Exposure",
} satisfies Record<SecuritySource, string>

const SECTIONS: ReadonlyArray<NavShellSection<never>> = [
	{
		id: "sources",
		title: "Sources",
		items: [
			{
				kind: "link",
				id: "code",
				label: SOURCE_LABEL.code,
				icon: "CodeIcon",
				href: hrefOf(AppRoute.SecurityCode()),
			},
			{
				kind: "link",
				id: "dependencies",
				label: SOURCE_LABEL.dependencies,
				icon: "CubeIcon",
				href: hrefOf(AppRoute.SecurityDependencies({ search: {} })),
			},
			{
				kind: "link",
				id: "runtimes",
				label: SOURCE_LABEL.runtimes,
				icon: "MicrochipIcon",
				href: hrefOf(AppRoute.SecurityRuntimes()),
			},
			{
				kind: "link",
				id: "exposure",
				label: SOURCE_LABEL.exposure,
				icon: "GlobeIcon",
				href: hrefOf(AppRoute.SecurityExposure()),
			},
		],
	},
]

/** The rail's rows are all links, so no row sends a message. */
const securityRail = <M>(h: HtmlBuilder<M>, active: SecuritySource): Html =>
	navShell<M, never>(h, SECTIONS, active, (tab) => tab, "Security sources")

/** The rail in `dashboardPage`'s side slot, which folds into a sheet below `lg`. */
const securityRailOptions = <M>(
	h: HtmlBuilder<M>,
	active: SecuritySource,
): Pick<DashboardPageOptions, "filters" | "filtersLabel" | "filtersWidth"> => ({
	filters: securityRail(h, active),
	filtersLabel: "Security",
	filtersWidth: "w-56",
})

const CODE_TABS: ReadonlyArray<{ tab: CodeTab; label: string; icon: IconName; href: string }> = [
	{ tab: "overview", label: "Overview", icon: "ShieldCheckIcon", href: hrefOf(AppRoute.SecurityCode()) },
	{
		tab: "findings",
		label: "Findings",
		icon: "CircleWarningIcon",
		href: hrefOf(AppRoute.SecurityCodeFindings({ search: {} })),
	},
	{
		tab: "runs",
		label: "Runs",
		icon: "PlayRotateClockwiseIcon",
		href: hrefOf(AppRoute.SecurityCodeRuns({ search: {} })),
	},
]

/** `Security › <source>`, then the code audit's tab when it is not its overview. */
export const breadcrumbsOf = (
	source: SecuritySource,
	tab: CodeTab = "overview",
): ReadonlyArray<BreadcrumbEntry> => {
	const label = CODE_TABS.find((entry) => entry.tab === tab)?.label ?? ""
	return source === "code" && tab !== "overview"
		? [
				{ label: "Security" },
				{ label: SOURCE_LABEL.code, href: hrefOf(AppRoute.SecurityCode()) },
				{ label },
			]
		: [{ label: "Security" }, { label: SOURCE_LABEL[source] }]
}

/** The code audit's crumbs above a run or finding, then the list it leads back to. */
export const codeCrumbs = (back: BreadcrumbEntry): ReadonlyArray<BreadcrumbEntry> => [
	{ label: "Security" },
	{ label: SOURCE_LABEL.code, href: hrefOf(AppRoute.SecurityCode()) },
	back,
]

const codeTabs = <M>(h: HtmlBuilder<M>, active: CodeTab): Html =>
	linkTabStrip(
		h,
		"Code security audit views",
		CODE_TABS.map((entry) => ({
			key: entry.tab,
			href: entry.href,
			label: entry.label,
			icon: entry.icon,
			isCurrent: entry.tab === active,
			isRouteActive: entry.tab === active,
		})),
	)

const DESCRIPTION = {
	code: "Deep code audits of your connected repositories. Findings are visible to org admins only.",
	exposure: "Scanners probing your HTTP services over the last 7 days, read from server spans.",
	runtimes:
		"The language runtime each service reports, checked for known vulnerabilities and end-of-life dates.",
	dependencies:
		"Known vulnerable packages in your connected repositories' lockfiles, rescanned on every push.",
} satisfies Record<SecuritySource, string>

/** The title block: the page `<h1>` and its one line of context, like every other page header. */
const securityTitle = <M>(h: HtmlBuilder<M>, source: SecuritySource): Html =>
	h.div(
		[h.Class("min-w-0 space-y-0.5")],
		[
			pageTitle(h, { className: "leading-8 text-foreground" }, [SOURCE_LABEL[source]]),
			h.p([h.Class("max-w-2xl font-prose text-sm text-muted-foreground")], [DESCRIPTION[source]]),
		],
	)

/** The page's blocks at their own height: the scroll area scrolls them, never squeezes them. */
export const stack = <M>(h: HtmlBuilder<M>, children: ReadonlyArray<Html>): Html =>
	h.div([h.Class("flex shrink-0 flex-col gap-6")], children)

type SecurityLayoutOptions = Readonly<{
	source: SecuritySource
	/** The code audit's tab; its tab strip shows only on `code`. */
	codeTab?: CodeTab
	actions?: Html
	/** Dialogs the page owns, rendered after the content. */
	overlay?: ReadonlyArray<Html>
}>

export const securityLayout = <M>(
	h: HtmlBuilder<M>,
	options: SecurityLayoutOptions,
	children: ReadonlyArray<Html>,
): Html =>
	dashboardPage(
		h,
		{
			...securityRailOptions(h, options.source),
			titleContent: securityTitle(h, options.source),
			actions: options.actions,
			tabs: options.source === "code" ? codeTabs(h, options.codeTab ?? "overview") : undefined,
			scrollClassName: "pb-8",
		},
		[stack(h, children), ...(options.overlay ?? [])],
	)

/** A four-tile stat rail keeps two columns until the page is wide enough for four. */
export const NARROW_TWO_COLUMNS = "md:grid-cols-2 xl:grid-cols-4 md:divide-y xl:divide-y-0"

/** The same beside the rail, which takes the width between `xl` and `2xl`. */
export const BESIDE_RAIL_TWO_COLUMNS = "md:grid-cols-2 2xl:grid-cols-4 md:divide-y 2xl:divide-y-0"
