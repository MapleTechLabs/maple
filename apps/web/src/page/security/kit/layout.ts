import { cn } from "@maple/ui/lib/utils"
import { pageTitleStyles } from "@maple/ui/styles/ui/page-layout"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import type { BreadcrumbEntry } from "../../../shell"
import type { IconName } from "../../../ui/icon"
import { dashboardPage } from "../../kit/dashboard-page"
import { linkTabStrip } from "../../kit/underline-tabs"
import type { Tab } from "../tabs/model"

// The frame of the three Security tabs: title block, Overview / Findings / Runs, content.

const TABS: ReadonlyArray<{ tab: Tab; label: string; icon: IconName; href: string }> = [
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
]

export const breadcrumbsOf = (tab: Tab): ReadonlyArray<BreadcrumbEntry> => {
	const label = TABS.find((entry) => entry.tab === tab)?.label ?? ""
	return tab === "overview"
		? [{ label: "Security", isPageHeading: true }]
		: [{ label: "Security", href: hrefOf(AppRoute.Security()) }, { label }]
}

const tabs = <M>(h: HtmlBuilder<M>, active: Tab): Html =>
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

const DESCRIPTION =
	"Deep code audits of your connected repositories. Findings are visible to org admins only."

/** The title block: the page `<h1>` and its one line of context, like every other page header. */
const securityTitle = <M>(h: HtmlBuilder<M>, description: string = DESCRIPTION): Html =>
	h.div(
		[h.Class("min-w-0 space-y-0.5")],
		[
			h.h1([h.Class(cn(pageTitleStyles, "leading-8 text-foreground"))], ["Security"]),
			h.p([h.Class("max-w-2xl font-prose text-sm text-muted-foreground")], [description]),
		],
	)

/** The page's blocks at their own height: the scroll area scrolls them, never squeezes them. */
export const stack = <M>(h: HtmlBuilder<M>, children: ReadonlyArray<Html>): Html =>
	h.div([h.Class("flex shrink-0 flex-col gap-6")], children)

type SecurityLayoutOptions = Readonly<{
	active: Tab
	actions?: Html
	description?: string
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
			titleContent: securityTitle(h, options.description),
			actions: options.actions,
			tabs: tabs(h, options.active),
			scrollClassName: "pb-8",
		},
		[stack(h, children), ...(options.overlay ?? [])],
	)

/** A four-tile stat rail keeps two columns until the page is wide enough for four. */
export const NARROW_TWO_COLUMNS = "md:grid-cols-2 xl:grid-cols-4 md:divide-y xl:divide-y-0"
