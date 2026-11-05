import { countLabel, EMPTY_VALUE, formatNumber, formatPercentColumn } from "@maple/ui/lib/format"
import type { Html, HtmlBuilder } from "foldkit/html"
import { columnClass } from "@maple/views/ui/column"
import {
	type FilterOption,
	filterSection,
	singleCheckboxFilter,
} from "@maple/views/ui/filters/filter-section"
import * as FilterSections from "@maple/views/ui/filters/filter-sections"
import {
	filterSidebarBody,
	filterSidebarFrame,
	filterSidebarHeader,
} from "@maple/views/ui/filters/filter-sidebar"
import { icon } from "@maple/views/ui/icon"
import { miniBars } from "@maple/views/ui/mini-bars"
import { searchInput } from "@maple/views/ui/search-input"
import { segmentedSelect } from "@maple/views/ui/segmented-select"
import { button } from "@maple/views/ui/button"
import { hstack, vstack } from "@maple/views/ui/stack"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { Array as Arr } from "effect"
import {
	th,
	toolTable,
	toolTableBody,
	toolTableFooter,
	toolTableHead,
	toolTableRow,
} from "../agent-sessions/tools-kit/table"
import { pinnedNamespaceNotice } from "../kit/pinned-namespace-notice"
import { listRelativeTime } from "../kit/relative-time"
import { statRail, statRailItem, statRailItemSkeleton } from "../kit/stat-rail"
import { groupLabel, type UserRow } from "./data"
import { signalLane, signalTags, userAvatar, userNameBlock } from "./view-kit"

// `/users`: every end user the SDKs identified in the window, most recently seen first.

/** The rail's state: the toggles and the facet picks (a pinned namespace overrides `namespaces`). */
export type UsersFilters = Readonly<{
	search: string
	hasErrors: boolean
	hasReplay: boolean
	namespaces: ReadonlyArray<string>
	groups: ReadonlyArray<string>
}>

/** A group in the rail: `name` is its id, `label` its name when one was sent. */
export type GroupOption = FilterOption & Readonly<{ label: string | null }>

/** The rail's facets over the window: users per namespace and per group. */
export type UsersFacets = Readonly<{
	namespaces: ReadonlyArray<FilterOption>
	groups: ReadonlyArray<GroupOption>
	withErrors: number
	withReplay: number
}>

export type UsersSummary = Readonly<{
	identified: number
	activeToday: number
	withErrors: number
	anonymousVisitors: number
}>

/** One picked group's numbers, which the strip shows in place of the org's. */
export type UsersGroupSummary = Readonly<{
	kind: "group"
	label: string
	users: number
	activeToday: number
	withErrors: number
	sessions: number
}>

/** The strip's counts, or why it has none: still loading, or the facets read failed. */
export type UsersSummaryState = UsersSummary | UsersGroupSummary | "loading" | "failed"

/** What one directory row is: a user, or a group of them. */
export type UsersGroupBy = "none" | "group"

/** One group in the group view; `groupId` `null` is the users in none. */
export type UsersGroupRow = Readonly<{
	groupId: string | null
	groupName: string | null
	users: number
	activeToday: number
	withErrors: number
	sessions: number
	errors: number
	requests: number
	lastSeenMs: number
}>

export type UsersListOptions<M> = Readonly<{
	nowMs: number
	timeZone: string
	filters: UsersFilters
	groupBy: UsersGroupBy
	onGroupBy: (groupBy: UsersGroupBy) => M
	/** The summary strip's scope: the org pin only, as the facets read it; empty is every namespace. */
	scope: ReadonlyArray<string>
	onSearch: (value: string) => M
	onClearSearch: M
	/** Where a row links; rows are plain until the user page exists. */
	userHref?: (userId: string) => string
}>

/** The rail's counts, or why it has none: still loading, or the facets read failed. */
export type UsersRailFacets = UsersFacets | "loading" | "failed"

export type UsersRailOptions<M> = Readonly<{
	filters: UsersFilters
	facets: UsersRailFacets
	/** Re-runs the reads when the facets failed. */
	onRetry: M
	/** The org-global pin: the Namespace section becomes its notice and the picks are ignored. */
	pinnedNamespace: string | null
	sections: FilterSections.Model
	toSectionsMessage: (message: FilterSections.Message) => M
	onToggleErrors: M
	onToggleReplay: M
	onToggleNamespace: (name: string) => M
	onToggleGroup: (name: string) => M
	onClearNamespacePin: M
	onClearAll: M
}>

/** Whether any rail filter is set (the pin is the org's, not the page's). */
const hasRailFilters = (filters: UsersFilters): boolean =>
	filters.hasErrors || filters.hasReplay || filters.namespaces.length > 0 || filters.groups.length > 0

/** The users filter rail: the toggles, then Namespace (or the pin's notice) and Group. */
/** While the facets are out or failed: no counts and no options, only the picks already made. */
const NO_FACETS: UsersFacets = { namespaces: [], groups: [], withErrors: 0, withReplay: 0 }

const railStatus = <M>(h: HtmlBuilder<M>, facets: UsersRailFacets, onRetry: M): ReadonlyArray<Html> =>
	facets === "loading"
		? [typography(h, { size: "xs", tone: "subtle", className: "px-1" }, ["Loading filter counts…"])]
		: facets === "failed"
			? [
					hstack(h, { gap: "2", className: "px-1" }, [
						typography(h, { size: "xs", tone: "muted" }, ["Couldn't load the filters"]),
						button(h, { size: "xs", variant: "ghost", attributes: [h.OnClick(onRetry)] }, [
							"Retry",
						]),
					]),
				]
			: []

/** The users filter rail: the toggles, then Namespace (or the pin's notice) and Group. */
export const usersFilterRail = <M>(h: HtmlBuilder<M>, options: UsersRailOptions<M>): Html => {
	const ready = typeof options.facets === "string" ? undefined : options.facets
	const facets = ready ?? NO_FACETS
	const groupNames = new Map(
		Arr.flatMap(facets.groups, (group) =>
			group.label === null ? [] : [[group.name, group.label] as const],
		),
	)
	return filterSidebarFrame(h, {}, [
		filterSidebarHeader(h, hasRailFilters(options.filters) ? { onClear: options.onClearAll } : {}),
		...filterSidebarBody(h, "users-filters", [
			...railStatus(h, options.facets, options.onRetry),
			singleCheckboxFilter(h, {
				title: "Has errors",
				isChecked: options.filters.hasErrors,
				onToggle: options.onToggleErrors,
				...(ready !== undefined && { count: ready.withErrors }),
			}),
			singleCheckboxFilter(h, {
				title: "Has replay",
				isChecked: options.filters.hasReplay,
				onToggle: options.onToggleReplay,
				...(ready !== undefined && { count: ready.withReplay }),
			}),
			options.pinnedNamespace !== null
				? pinnedNamespaceNotice(h, options.pinnedNamespace, options.onClearNamespacePin)
				: filterSection(h, {
						title: "Namespace",
						description:
							"The service.namespace of the services users' requests and sessions reached in the window.",
						options: facets.namespaces,
						selected: options.filters.namespaces,
						isSearchable: true,
						sections: options.sections,
						toSectionsMessage: options.toSectionsMessage,
						onToggle: options.onToggleNamespace,
					}),
			filterSection(h, {
				title: "Group",
				description: "The company, team or tenant identify() put the user in.",
				options: facets.groups,
				getOptionLabel: (id) => groupNames.get(id) ?? id,
				getOptionDescription: (id) => (groupNames.has(id) ? id : undefined),
				selected: options.filters.groups,
				isSearchable: true,
				sections: options.sections,
				toSectionsMessage: options.toSectionsMessage,
				onToggle: options.onToggleGroup,
			}),
		]),
	])
}

const scopeText = (scope: ReadonlyArray<string>): string =>
	scope.length === 0
		? "every namespace"
		: scope.length === 1
			? `namespace ${scope[0]}`
			: `${scope.length} namespaces`

type SummaryItem = Readonly<{ eyebrow: string; value: number; subline: string; tone?: "crit" | "neutral" }>

/** `24% of users`, or the fallback when there are none to divide by. */
const shareOf = (count: number, of: number, noun: string, fallback: string): string =>
	of === 0 ? fallback : `${formatPercentColumn(count / of)} of ${noun}`

const groupSummaryItems = (summary: UsersGroupSummary): ReadonlyArray<SummaryItem> => [
	{ eyebrow: "Users in group", value: summary.users, subline: summary.label },
	{
		eyebrow: "Active today",
		value: summary.activeToday,
		subline: shareOf(summary.activeToday, summary.users, "the group", "any signal in the last 24h"),
	},
	{
		eyebrow: "Hit an error",
		value: summary.withErrors,
		subline: shareOf(summary.withErrors, summary.users, "the group", "users with one or more errors"),
		tone: summary.withErrors > 0 ? "crit" : "neutral",
	},
	{
		eyebrow: "Sessions",
		value: summary.sessions,
		subline:
			summary.users === 0
				? "recorded sessions"
				: `${(summary.sessions / summary.users).toFixed(1)} per user`,
	},
]

const summaryItems = (
	summary: UsersSummary | UsersGroupSummary,
	scope: ReadonlyArray<string>,
): ReadonlyArray<SummaryItem> =>
	"kind" in summary ? groupSummaryItems(summary) : orgSummaryItems(summary, scope)

const orgSummaryItems = (summary: UsersSummary, scope: ReadonlyArray<string>): ReadonlyArray<SummaryItem> => [
	{ eyebrow: "Identified users", value: summary.identified, subline: `seen in ${scopeText(scope)}` },
	{
		eyebrow: "Active today",
		value: summary.activeToday,
		subline: shareOf(summary.activeToday, summary.identified, "users", "any signal in the last 24h"),
	},
	{
		eyebrow: "Hit an error",
		value: summary.withErrors,
		subline: shareOf(summary.withErrors, summary.identified, "users", "users with one or more errors"),
		tone: summary.withErrors > 0 ? "crit" : "neutral",
	},
	{
		eyebrow: "Anonymous visitors",
		value: summary.anonymousVisitors,
		subline: "visitor id only, not listed",
	},
]

const SUMMARY_EYEBROWS = ["Identified users", "Active today", "Hit an error", "Anonymous visitors"]

const summaryRail = <M>(h: HtmlBuilder<M>, summary: UsersSummaryState, scope: ReadonlyArray<string>): Html =>
	summary === "loading"
		? statRail(
				h,
				{ columns: 4, isFlush: true, isBusy: true },
				Arr.map(SUMMARY_EYEBROWS, () => statRailItemSkeleton(h)),
			)
		: summary === "failed"
			? statRail(
					h,
					{ columns: 4, isFlush: true },
					Arr.map(SUMMARY_EYEBROWS, (eyebrow) =>
						statRailItem(h, {
							eyebrow,
							value: EMPTY_VALUE,
							subline: "couldn't load the counts",
							compact: true,
						}),
					),
				)
			: statRail(
					h,
					{ columns: 4, isFlush: true },
					Arr.map(summaryItems(summary, scope), (item) =>
						statRailItem(h, {
							eyebrow: item.eyebrow,
							value: formatNumber(item.value),
							subline: item.subline,
							tone: item.tone ?? "neutral",
							compact: true,
						}),
					),
				)

const GROUP_BY_OPTIONS = [
	{ value: "none", label: "Users" },
	{ value: "group", label: "Groups" },
] as const

/** The directory's search box and its row kind; they stay above the empty state a search with no matches shows. */
export const usersToolbar = <M>(
	h: HtmlBuilder<M>,
	options: Pick<UsersListOptions<M>, "filters" | "onSearch" | "onClearSearch" | "groupBy" | "onGroupBy">,
): Html =>
	hstack(h, { gap: "2", wrap: true, justify: "between", className: "px-6 py-3" }, [
		searchInput(h, {
			id: "users-search",
			value: options.filters.search,
			placeholder: "Search by id, name or email",
			ariaLabel: "Search users",
			onInput: options.onSearch,
			onClear: options.onClearSearch,
			className: "w-full max-w-sm",
		}),
		segmentedSelect(h, {
			size: "sm",
			ariaLabel: "Group by",
			value: options.groupBy,
			onChange: options.onGroupBy,
			options: GROUP_BY_OPTIONS,
		}),
	])

const numberCell = <M>(
	h: HtmlBuilder<M>,
	value: string,
	className: string,
	tone?: "error" | "subtle",
): Html =>
	typography(
		h,
		{
			size: "xs",
			mono: true,
			numeric: true,
			tone: tone ?? "foreground",
			as: "span",
			className: `shrink-0 text-right ${className}`,
		},
		[value],
	)

/** The user's busiest namespace, then how many more they reached. */
const namespaceCell = <M>(h: HtmlBuilder<M>, namespaces: ReadonlyArray<string>): Html => {
	const [first, ...rest] = namespaces
	return hstack(h, { gap: "1.5", as: "span", className: "hidden w-32 shrink-0 @min-[680px]/panel:flex" }, [
		first === undefined
			? typography(h, { size: "xs", tone: "subtle", as: "span" }, ["none"])
			: hstack(h, { gap: "1", as: "span", shrink: true, className: "min-w-0" }, [
					icon(h, "LayersIcon", { size: 12, className: "shrink-0 text-foreground-subtle" }),
					typography(h, { size: "xs", mono: true, truncate: true, as: "span" }, [first]),
				]),
		...(rest.length === 0
			? []
			: [
					typography(
						h,
						{
							size: "2xs",
							mono: true,
							tone: "muted",
							as: "span",
							attributes: [h.Title(Arr.join(rest, ", "))],
						},
						[`+${rest.length}`],
					),
				]),
	])
}

/** The user's group by name, its id on hover; the id itself when no name was sent. */
const groupCell = <M>(h: HtmlBuilder<M>, row: UserRow): Html => {
	const label = groupLabel(row)
	return typography(
		h,
		{
			size: "xs",
			mono: row.groupName === null,
			tone: label === null ? "subtle" : "soft",
			truncate: true,
			as: "span",
			className: "hidden w-36 shrink-0 @min-[880px]/panel:block",
			...(row.groupId !== null && row.groupName !== null && { attributes: [h.Title(row.groupId)] }),
		},
		[label ?? EMPTY_VALUE],
	)
}

/** The first signal tags, then `+N` naming the rest on hover, so five signals fit the lane. */
const signalCell = <M>(
	h: HtmlBuilder<M>,
	signals: ReadonlyArray<UserRow["signals"][number]>,
): ReadonlyArray<Html> => {
	const lane = signalLane(signals)
	return [
		...signalTags(h, lane.shown),
		...(lane.hidden.length === 0
			? []
			: [
					typography(
						h,
						{
							size: "2xs",
							mono: true,
							tone: "muted",
							as: "span",
							attributes: [h.Title(Arr.join(lane.hidden, ", "))],
						},
						[`+${lane.hidden.length}`],
					),
				]),
	]
}

const userRow = <M>(h: HtmlBuilder<M>, row: UserRow, options: UsersListOptions<M>): Html =>
	toolTableRow(
		h,
		options.userHref === undefined
			? { className: "h-12" }
			: { href: options.userHref(row.userId), className: "h-12" },
		[
			hstack(
				h,
				{ gap: "2.5", shrink: true, grow: true, as: "span", className: columnClass({ min: "48" }) },
				[userAvatar(h, row), userNameBlock(h, row)],
			),
			groupCell(h, row),
			namespaceCell(h, row.namespaces),
			h.span(
				[h.Class("w-24 shrink-0 text-right")],
				[
					listRelativeTime(h, {
						value: row.lastSeenMs,
						nowMs: options.nowMs,
						timeZone: options.timeZone,
						variant: "short",
						mono: true,
						className: typographyClass({ size: "xs", tone: "soft" }),
					}),
				],
			),
			numberCell(
				h,
				row.sessions === 0 ? "0" : formatNumber(row.sessions),
				"w-16",
				row.sessions === 0 ? "subtle" : undefined,
			),
			numberCell(h, formatNumber(row.errors), "w-14", row.errors > 0 ? "error" : "subtle"),
			h.span(
				[h.Class("hidden w-28 shrink-0 items-center justify-end gap-2 @min-[760px]/panel:flex")],
				[
					...(row.activity.length === 0
						? []
						: [
								miniBars(h, {
									values: row.activity,
									color: "var(--primary)",
									className: "h-5 w-14",
								}),
							]),
					typography(h, { size: "xs", mono: true, numeric: true, as: "span" }, [
						formatNumber(row.requests),
					]),
				],
			),
			typography(
				h,
				{
					size: "xs",
					mono: true,
					tone: row.topRoute === null ? "subtle" : "soft",
					truncate: true,
					as: "span",
					className: "hidden w-40 shrink-0 pl-4 @min-[960px]/panel:block",
				},
				[row.topRoute ?? EMPTY_VALUE],
			),
			hstack(
				h,
				{ gap: "1", as: "span", className: "hidden w-36 shrink-0 @min-[1000px]/panel:flex" },
				signalCell(h, row.signals),
			),
			h.span(
				[h.Class("hidden w-20 shrink-0 text-right @min-[1100px]/panel:block")],
				[
					listRelativeTime(h, {
						value: row.firstSeenMs,
						nowMs: options.nowMs,
						timeZone: options.timeZone,
						variant: "short",
						mono: true,
						className: typographyClass({ size: "xs", tone: "muted" }),
					}),
				],
			),
			hstack(
				h,
				{
					justify: "end",
					as: "span",
					className: typographyClass({ tone: "subtle", className: "w-3.5 shrink-0" }),
				},
				// The chevron says the row opens; a row with no page keeps the column, empty.
				options.userHref === undefined ? [] : [icon(h, "ChevronRightIcon", { size: 14 })],
			),
		],
	)

/** The directory: the summary strip, the search, then one row per user (already filtered). */
export const usersListBody = <M>(
	h: HtmlBuilder<M>,
	shown: ReadonlyArray<UserRow>,
	summary: UsersSummaryState,
	options: UsersListOptions<M>,
): Html => {
	return h.div(
		[h.Class("@container/panel flex min-w-0 flex-col")],
		[
			summaryRail(h, summary, options.scope),
			usersToolbar(h, options),
			h.section(
				[h.AriaLabel("Users"), h.Class("min-w-0 px-6 pb-6")],
				[
					toolTable(h, [
						toolTableHead(h, [
							th(h, { label: "User", width: columnClass({ min: "48" }) }),
							th(h, {
								label: "Group",
								width: "w-36 shrink-0",
								hidden: "hidden @min-[880px]/panel:flex",
							}),
							th(h, {
								label: "Namespace",
								width: "w-32 shrink-0",
								hidden: "hidden @min-[680px]/panel:flex",
							}),
							th(h, { label: "Last seen", width: "w-24 shrink-0", align: "right" }),
							th(h, { label: "Sessions", width: "w-16 shrink-0", align: "right" }),
							th(h, { label: "Errors", width: "w-14 shrink-0", align: "right" }),
							th(h, {
								label: "Requests",
								width: "w-28 shrink-0",
								align: "right",
								hidden: "hidden @min-[760px]/panel:flex",
							}),
							th(h, {
								label: "Top route",
								width: "w-40 shrink-0 pl-4",
								hidden: "hidden @min-[960px]/panel:flex",
							}),
							th(h, {
								label: "Signals",
								width: "w-36 shrink-0",
								hidden: "hidden @min-[1000px]/panel:flex",
							}),
							th(h, {
								label: "First seen",
								width: "w-20 shrink-0",
								align: "right",
								hidden: "hidden @min-[1100px]/panel:flex",
							}),
							h.span([h.AriaHidden(true), h.Class("w-3.5 shrink-0")], []),
						]),
						toolTableBody(
							h,
							Arr.map(shown, (row) => userRow(h, row, options)),
						),
					]),
					toolTableFooter(
						h,
						typeof summary === "string"
							? countLabel(shown.length, "user")
							: `${shown.length} of ${countLabel("kind" in summary ? summary.users : summary.identified, "user")}`,
						"· sorted by last seen",
					),
				],
			),
		],
	)
}

/** A group's name over its id; the users in no group get their own label. */
const groupNameBlock = <M>(h: HtmlBuilder<M>, row: UsersGroupRow): Html =>
	vstack(h, { gap: "0", shrink: true, className: "min-w-0" }, [
		typography(h, { size: "xs", tone: row.groupId === null ? "muted" : "foreground", truncate: true }, [
			row.groupId === null ? "No group" : (row.groupName ?? row.groupId),
		]),
		typography(h, { size: "2xs", tone: "muted", mono: true, truncate: true }, [
			row.groupId === null
				? "identify() sent no groupId"
				: row.groupName === null
					? "no name sent"
					: row.groupId,
		]),
	])

/** `12 · 25%`: how many of the group's users, and their share. */
const shareCell = <M>(
	h: HtmlBuilder<M>,
	count: number,
	of: number,
	className: string,
	tone?: "error",
): Html =>
	numberCell(
		h,
		count === 0 ? "0" : `${formatNumber(count)} · ${formatPercentColumn(count / Math.max(1, of))}`,
		className,
		count === 0 ? "subtle" : tone,
	)

const groupRow = <M>(h: HtmlBuilder<M>, row: UsersGroupRow, options: UsersGroupsOptions<M>): Html =>
	toolTableRow(
		h,
		row.groupId === null
			? { className: "h-12" }
			: { href: options.groupHref(row.groupId), className: "h-12" },
		[
			hstack(
				h,
				{ gap: "2.5", shrink: true, grow: true, as: "span", className: columnClass({ min: "48" }) },
				[
					icon(h, row.groupId === null ? "UserIcon" : "UsersIcon", {
						size: 14,
						className: "shrink-0 text-foreground-subtle",
					}),
					groupNameBlock(h, row),
				],
			),
			numberCell(h, formatNumber(row.users), "w-16"),
			shareCell(h, row.activeToday, row.users, "hidden w-24 @min-[680px]/panel:block"),
			shareCell(h, row.withErrors, row.users, "w-24", "error"),
			numberCell(
				h,
				formatNumber(row.sessions),
				"hidden w-16 @min-[760px]/panel:block",
				row.sessions === 0 ? "subtle" : undefined,
			),
			numberCell(
				h,
				formatNumber(row.errors),
				"hidden w-14 @min-[760px]/panel:block",
				row.errors > 0 ? "error" : "subtle",
			),
			numberCell(
				h,
				formatNumber(row.requests),
				"hidden w-20 @min-[880px]/panel:block",
				row.requests === 0 ? "subtle" : undefined,
			),
			h.span(
				[h.Class("w-24 shrink-0 text-right")],
				[
					listRelativeTime(h, {
						value: row.lastSeenMs,
						nowMs: options.nowMs,
						timeZone: options.timeZone,
						variant: "short",
						mono: true,
						className: typographyClass({ size: "xs", tone: "soft" }),
					}),
				],
			),
			hstack(
				h,
				{
					justify: "end",
					as: "span",
					className: typographyClass({ tone: "subtle", className: "w-3.5 shrink-0" }),
				},
				row.groupId === null ? [] : [icon(h, "ChevronRightIcon", { size: 14 })],
			),
		],
	)

export type UsersGroupsOptions<M> = UsersListOptions<M> &
	Readonly<{
		/** The directory filtered to one group. */
		groupHref: (groupId: string) => string
		/** More groups exist than the page lists. */
		truncated: boolean
	}>

/** The directory grouped: the summary strip, the search, then one row per group (already filtered). */
export const usersGroupsBody = <M>(
	h: HtmlBuilder<M>,
	shown: ReadonlyArray<UsersGroupRow>,
	summary: UsersSummaryState,
	options: UsersGroupsOptions<M>,
): Html => {
	const named = Arr.filter(shown, (row) => row.groupId !== null).length
	return h.div(
		[h.Class("@container/panel flex min-w-0 flex-col")],
		[
			summaryRail(h, summary, options.scope),
			usersToolbar(h, options),
			h.section(
				[h.AriaLabel("Groups"), h.Class("min-w-0 px-6 pb-6")],
				[
					toolTable(h, [
						toolTableHead(h, [
							th(h, { label: "Group", width: columnClass({ min: "48" }) }),
							th(h, { label: "Users", width: "w-16 shrink-0", align: "right" }),
							th(h, {
								label: "Active 24h",
								width: "w-24 shrink-0",
								align: "right",
								hidden: "hidden @min-[680px]/panel:flex",
							}),
							th(h, { label: "Hit an error", width: "w-24 shrink-0", align: "right" }),
							th(h, {
								label: "Sessions",
								width: "w-16 shrink-0",
								align: "right",
								hidden: "hidden @min-[760px]/panel:flex",
							}),
							th(h, {
								label: "Errors",
								width: "w-14 shrink-0",
								align: "right",
								hidden: "hidden @min-[760px]/panel:flex",
							}),
							th(h, {
								label: "Requests",
								width: "w-20 shrink-0",
								align: "right",
								hidden: "hidden @min-[880px]/panel:flex",
							}),
							th(h, { label: "Last seen", width: "w-24 shrink-0", align: "right" }),
							h.span([h.AriaHidden(true), h.Class("w-3.5 shrink-0")], []),
						]),
						toolTableBody(
							h,
							Arr.map(shown, (row) => groupRow(h, row, options)),
						),
					]),
					toolTableFooter(
						h,
						options.truncated
							? `First ${countLabel(named, "group")}`
							: countLabel(named, "group"),
						"· sorted by users · a user in two groups counts in both",
					),
				],
			),
		],
	)
}
