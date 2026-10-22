import { resolveRelativeRangeToWarehouse } from "@maple/query-engine"
import { toEpochMs } from "@maple/ui/lib/time-format"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { button } from "../../../ui/button"
import { empty, emptyDescription, emptyHeader, emptyTitle } from "../../../ui/empty"
import { icon, type IconName } from "../../../ui/icon"
import { dashboardPage } from "../../kit/dashboard-page"
import { underlineTabClass, underlineTabStrip } from "../../kit/underline-tabs"
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

/** `CODE_REVIEW_CI_MAX_RANGE_SECONDS`: two weeks plus an hour for a DST change. */
export const CI_MAX_RANGE_MS = (14 * 24 * 60 * 60 + 60 * 60) * 1000

/** `fitsCi`: whether the window is short enough to carry to the CI tab. */
const fitsCi = (search: WindowSearch, nowMs: number, timeZone: string): boolean => {
	const range =
		search.timePreset !== undefined
			? resolveRelativeRangeToWarehouse(search.timePreset, nowMs, timeZone)
			: search
	if (range === null || range.startTime === undefined || range.endTime === undefined) return true
	return toEpochMs(range.endTime) - toEpochMs(range.startTime) <= CI_MAX_RANGE_MS
}

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
	nowMs: number
	timeZone: string
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
	const toCi = fitsCi(search, options.nowMs, options.timeZone)
		? carried
		: { repo: search.repo, author: search.author }
	const currentPath = TABS.find((entry) => entry.tab === active)?.path ?? "/code-review"
	return underlineTabStrip(
		h,
		{
			navigation: true,
			label: "Code review views",
			bleed: false,
			divided: false,
			className: "gap-0 overflow-visible border-b border-border",
		},
		TABS.map((entry) => {
			const linkSearch = defined(entry.tab === "settings" ? {} : entry.tab === "ci" ? toCi : carried)
			const isCurrent = entry.tab === active
			const isRouteActive = isLinkActive(entry.path, linkSearch, currentPath, search)
			return h.a(
				[
					h.Key(entry.tab),
					...(isRouteActive ? [h.AriaCurrent("page")] : []),
					h.Class(
						cn(
							cn(
								underlineTabClass(isCurrent),
								"h-9 gap-[7px] px-3 first:pl-0.5",
								isCurrent ? "[&_svg]:text-primary" : "[&_svg]:text-muted-foreground",
							),
							isRouteActive && "active",
						),
					),
					...(isRouteActive ? [h.DataAttribute("status", "active")] : []),
					h.Href(hrefFor(entry.tab, linkSearch)),
				],
				[icon(h, entry.icon, { size: 14 }), entry.label],
			)
		}),
	)
}

/** The frame every Code Review tab renders in. */
export const codeReviewLayout = <M>(options: LayoutOptions<M>, children: ReadonlyArray<Html>): Html => {
	const page = dashboardPage(
		options.h,
		{
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

/** The empty state of a tab whose filters left nothing: one way back to everything. */
export const nothingInWindow = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ title: string; description: string; onClear?: M | undefined }>,
): Html =>
	empty(
		h,
		[
			emptyHeader(h, [emptyTitle(h, [options.title]), emptyDescription(h, [options.description])]),
			...(options.onClear === undefined
				? []
				: [
						button(
							h,
							{ variant: "outline", size: "sm", attributes: [h.OnClick(options.onClear)] },
							["Clear filters"],
						),
					]),
		],
		"rounded-md border border-dashed md:py-14",
	)
