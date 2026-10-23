import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import type { BreadcrumbEntry } from "../../../shell"
import { icon, type IconName } from "../../../ui/icon"
import { pageDescription } from "../../../ui/page-layout"
import { dashboardPage } from "../../kit/dashboard-page"
import { detailTitle } from "../../kit/detail-header"
import { underlineTabClass, underlineTabStrip } from "../../kit/underline-tabs"
import { iconTile } from "./parts"

// The frame of the three Security tabs: title block, Overview / Findings / Runs, content.

export type SecurityTab = "overview" | "findings" | "runs"

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
]

export const tabLabel = (tab: SecurityTab): string => TABS.find((entry) => entry.tab === tab)?.label ?? ""

export const breadcrumbsOf = (tab: SecurityTab): ReadonlyArray<BreadcrumbEntry> =>
	tab === "overview"
		? [{ label: "Security" }]
		: [{ label: "Security", href: hrefOf(AppRoute.Security()) }, { label: tabLabel(tab) }]

const tabs = <M>(h: HtmlBuilder<M>, active: SecurityTab): Html =>
	underlineTabStrip(
		h,
		{
			navigation: true,
			label: "Security views",
			bleed: false,
			divided: false,
			className: "gap-0 border-b border-border",
		},
		TABS.map((entry) => {
			const isCurrent = entry.tab === active
			return h.a(
				[
					h.Key(entry.tab),
					...(isCurrent ? [h.AriaCurrent("page")] : []),
					h.Class(
						cn(
							underlineTabClass(isCurrent),
							"h-9 gap-[7px] px-3 first:pl-0.5",
							isCurrent ? "[&_svg]:text-primary" : "[&_svg]:text-muted-foreground",
						),
					),
					h.Href(entry.href),
				],
				[icon(h, entry.icon, { size: 14 }), entry.label],
			)
		}),
	)

const DESCRIPTION =
	"Deep code audits of your connected repositories. Findings are visible to org admins only."

/** The title block: Triage overline, the shield tile, the page's one line of context. */
export const securityTitle = <M>(h: HtmlBuilder<M>, description: string = DESCRIPTION): Html =>
	h.div(
		[h.Class("min-w-0 space-y-1.5")],
		[
			detailTitle(h, {
				kind: ["Triage"],
				title: [
					h.span(
						[h.Class("flex items-center gap-2.5")],
						[iconTile(h, "ShieldCheckIcon"), "Security Center"],
					),
				],
				titleText: "Security Center",
			}),
			pageDescription(h, [description]),
		],
	)

/** The page's blocks at their own height: the scroll area scrolls them, never squeezes them. */
export const stack = <M>(h: HtmlBuilder<M>, children: ReadonlyArray<Html>): Html =>
	h.div([h.Class("flex shrink-0 flex-col gap-6")], children)

export type SecurityLayoutOptions = Readonly<{
	active: SecurityTab
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
