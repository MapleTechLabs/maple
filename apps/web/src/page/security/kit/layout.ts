import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import type { BreadcrumbEntry } from "../../../shell"
import type { IconName } from "../../../ui/icon"
import { pageTitle } from "../../../ui/page-layout"
import { dashboardPage } from "../../kit/dashboard-page"
import { linkTabStrip } from "../../kit/underline-tabs"
// The frame of the Security tabs: title block, the tab strip, content. Overview, Findings and Runs
// are the code audits' page; Exposure and Runtimes read the org's telemetry; Dependencies reads
// the connected repositories' lockfiles.

export type SecurityTab = "overview" | "findings" | "runs" | "exposure" | "runtimes" | "dependencies"

const TABS: ReadonlyArray<{ tab: SecurityTab; label: string; icon: IconName; href: string }> = [
	{ tab: "overview", label: "Overview", icon: "ShieldCheckIcon", href: hrefOf(AppRoute.Security()) },
	{
		tab: "findings",
		label: "Findings",
		icon: "CircleWarningIcon",
		href: hrefOf(AppRoute.SecurityFindings({ search: {} })),
	},
	{
		tab: "runs",
		label: "Runs",
		icon: "PlayRotateClockwiseIcon",
		href: hrefOf(AppRoute.SecurityRuns({ search: {} })),
	},
	{ tab: "exposure", label: "Exposure", icon: "GlobeIcon", href: hrefOf(AppRoute.SecurityExposure()) },
	{ tab: "runtimes", label: "Runtimes", icon: "MicrochipIcon", href: hrefOf(AppRoute.SecurityRuntimes()) },
	{
		tab: "dependencies",
		label: "Dependencies",
		icon: "CubeIcon",
		href: hrefOf(AppRoute.SecurityDependencies()),
	},
]

export const breadcrumbsOf = (tab: SecurityTab): ReadonlyArray<BreadcrumbEntry> => {
	const label = TABS.find((entry) => entry.tab === tab)?.label ?? ""
	return tab === "overview"
		? [{ label: "Security", isPageHeading: true }]
		: [{ label: "Security", href: hrefOf(AppRoute.Security()) }, { label }]
}

const tabs = <M>(h: HtmlBuilder<M>, active: SecurityTab): Html =>
	linkTabStrip(
		h,
		"Security views",
		TABS.map((entry) => ({
			key: entry.tab,
			href: entry.href,
			label: entry.label,
			icon: entry.icon,
			isCurrent: entry.tab === active,
			isRouteActive: entry.tab === active,
		})),
	)

const CODE_AUDITS =
	"Deep code audits of your connected repositories. Findings are visible to org admins only."

const DESCRIPTION = {
	overview: CODE_AUDITS,
	findings: CODE_AUDITS,
	runs: CODE_AUDITS,
	exposure: "Scanners probing your HTTP services over the last 7 days, read from server spans.",
	runtimes:
		"The language runtime each service reports, checked for known vulnerabilities and end-of-life dates.",
	dependencies:
		"Known vulnerable packages in your connected repositories' lockfiles, rescanned on every push.",
} satisfies Record<SecurityTab, string>

/** The title block: the page `<h1>` and its one line of context, like every other page header. */
const securityTitle = <M>(h: HtmlBuilder<M>, tab: SecurityTab): Html =>
	h.div(
		[h.Class("min-w-0 space-y-0.5")],
		[
			pageTitle(h, { className: "leading-8 text-foreground" }, ["Security"]),
			h.p([h.Class("max-w-2xl font-prose text-sm text-muted-foreground")], [DESCRIPTION[tab]]),
		],
	)

/** The page's blocks at their own height: the scroll area scrolls them, never squeezes them. */
export const stack = <M>(h: HtmlBuilder<M>, children: ReadonlyArray<Html>): Html =>
	h.div([h.Class("flex shrink-0 flex-col gap-6")], children)

type SecurityLayoutOptions = Readonly<{
	active: SecurityTab
	actions?: Html
	/** Dialogs the tab owns, rendered after the content. */
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
			titleContent: securityTitle(h, options.active),
			actions: options.actions,
			tabs: tabs(h, options.active),
			scrollClassName: "pb-8",
		},
		[stack(h, children), ...(options.overlay ?? [])],
	)

/** A four-tile stat rail keeps two columns until the page is wide enough for four. */
export const NARROW_TWO_COLUMNS = "md:grid-cols-2 xl:grid-cols-4 md:divide-y xl:divide-y-0"
