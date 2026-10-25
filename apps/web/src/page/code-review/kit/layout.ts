import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import type { IconName } from "../../../ui/icon"
import { dashboardPage } from "../../kit/dashboard-page"
import { linkTabStrip } from "../../kit/underline-tabs"
import type { WindowSearch } from "./frame"

// `CodeReviewLayout`, `CodeReviewTabs` and `NothingInWindow`.

export type CodeReviewTab = "analytics" | "pull-requests" | "ci" | "issues" | "settings"

export type CarriedSearch = WindowSearch & Readonly<{ repo?: string; author?: string }>

const TABS: ReadonlyArray<{ tab: CodeReviewTab; path: string; label: string; icon: IconName }> = [
	{ tab: "analytics", path: "/code-review", label: "Analytics", icon: "ChartBarIcon" },
	{
		tab: "pull-requests",
		path: "/code-review/pull-requests",
		label: "Pull requests",
		icon: "PullRequestIcon",
	},
	{ tab: "ci", path: "/code-review/ci", label: "CI", icon: "PlayRotateClockwiseIcon" },
	{ tab: "issues", path: "/code-review/issues", label: "Issues", icon: "CircleWarningIcon" },
	{ tab: "settings", path: "/code-review/settings", label: "Settings", icon: "GearIcon" },
]

export const tabLabel = (tab: CodeReviewTab): string => TABS.find((entry) => entry.tab === tab)?.label ?? ""

export const breadcrumbsOf = (tab: CodeReviewTab) => [
	{ label: "Code Review", href: "/code-review" },
	{ label: tabLabel(tab) },
]

/** Defined keys only, in the order given: TanStack drops `undefined` search values. */
const defined = (search: Readonly<Record<string, string | undefined>>): Readonly<Record<string, string>> =>
	Object.fromEntries(
		Object.entries(search).flatMap(([key, value]) =>
			value === undefined ? [] : [[key, value] as const],
		),
	)

const hrefFor = (tab: CodeReviewTab, search: Readonly<Record<string, string | undefined>>): string => {
	switch (tab) {
		case "analytics":
			return hrefOf(AppRoute.CodeReview({ search }))
		case "pull-requests":
			return hrefOf(AppRoute.CodeReviewPullRequests({ search }))
		case "ci":
			return hrefOf(AppRoute.CodeReviewCi({ search }))
		case "issues":
			return hrefOf(AppRoute.CodeReviewIssues({ search }))
		case "settings":
			return hrefOf(AppRoute.CodeReviewSettings())
	}
}

/** TanStack's default `activeOptions`: the path or a parent of it, and the link's search a subset. */
const isLinkActive = (
	path: string,
	linkSearch: Readonly<Record<string, string>>,
	currentPath: string,
	currentSearch: Readonly<Record<string, unknown>>,
): boolean =>
	(currentPath === path || currentPath.startsWith(`${path}/`)) &&
	Object.entries(linkSearch).every(([key, value]) => currentSearch[key] === value)

export type LayoutOptions<M> = Readonly<{
	active: CodeReviewTab
	search: CarriedSearch & Readonly<Record<string, unknown>>
	toolbar?: Html
	/** The page's own sheet or dialog, rendered after the content. */
	overlay?: Html
	h: HtmlBuilder<M>
}>

const tabs = <M>(options: LayoutOptions<M>): Html => {
	const { h, search, active } = options
	const carried = {
		startTime: search.startTime,
		endTime: search.endTime,
		timePreset: search.timePreset,
		repo: search.repo,
		author: search.author,
	}
	const currentPath = TABS.find((entry) => entry.tab === active)?.path ?? "/code-review"
	return linkTabStrip(
		h,
		"Code review views",
		TABS.map((entry) => {
			const linkSearch = defined(entry.tab === "settings" ? {} : carried)
			return {
				key: entry.tab,
				href: hrefFor(entry.tab, linkSearch),
				label: entry.label,
				icon: entry.icon,
				isCurrent: entry.tab === active,
				isRouteActive: isLinkActive(entry.path, linkSearch, currentPath, search),
			}
		}),
	)
}

/** The frame every Code Review tab renders in. */
export const codeReviewLayout = <M>(options: LayoutOptions<M>, children: ReadonlyArray<Html>): Html => {
	const page = dashboardPage(
		options.h,
		{
			title: "Code Review",
			actions: options.toolbar,
			tabs: tabs(options),
			scrollClassName: "gap-6 pb-8",
		},
		children,
	)
	return options.overlay === undefined
		? page
		: options.h.div([options.h.Class("contents")], [page, options.overlay])
}
