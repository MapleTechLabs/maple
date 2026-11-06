import type { CodeReviewTeam, CodeReviewTeamMember, CodeReviewTeamTotals } from "@maple/domain/http"
import { formatSpan } from "../../../components/code-review/code-review-format"
import { EMPTY_VALUE, countLabel, formatNumber, formatPercent } from "@maple/ui/lib/format"
import { formatExactCount } from "@maple/views/lib/locale"
import { cn } from "@maple/ui/lib/utils"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { linkButton } from "@maple/views/ui/button"
import {
	empty,
	emptyDescription,
	emptyFrameClass,
	emptyHeader,
	emptyMessage,
	emptyTitle,
} from "@maple/views/ui/empty"
import { errorState } from "@maple/views/ui/error-state"
import { panel, panelHeader } from "@maple/views/ui/panel"
import { segmentedSelect } from "@maple/views/ui/segmented-select"
import {
	sortButton,
	table,
	tableBody,
	tableCell,
	tableHead,
	tableHeader,
	tableRow,
} from "@maple/views/ui/table"
import type { PageViewInputs } from "../../contract"
import { filteredEmpty } from "@maple/views/ui/signal-empty-state"
import { statRail, statRailItem } from "../../kit/stat-rail"
import * as TimeRangePicker from "../../kit/time-range-picker"
import { authorLabel } from "../kit/author"
import { filtersView } from "../kit/filters-view"
import { codeReviewLayout } from "../kit/layout"
import {
	busyPage,
	headlineSkeleton,
	line,
	panelControl,
	type SkeletonColumn,
	tableSkeleton,
} from "../kit/skeletons"
import {
	ASCENDING,
	highlightsOf,
	isRanked,
	type Metric,
	metricOf,
	RANK_MIN_PULL_REQUESTS,
	RANKABLE,
	rankedMetric,
	scorecardRows,
	sortOf,
	teamMedian,
	type TeamScores,
} from "./derive"
import { teamScores } from "./score"
import { Message, type Model } from "./model"
import { DEFAULT_PRESET } from "./update"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { hstack, vstack } from "@maple/views/ui/stack"
import * as HoverCard from "@maple/views/ui/hover-card"
import { contributionCalendar, contributionLevel } from "@maple/views/ui/contribution-calendar"
import { type ActivityCount, type ActivityDay, activityByDay, daysOf, totalOf } from "./activity"
import { ACTIVITY_CARD_ID } from "./update"
import { Array as Arr, Record as Rec, String as Str, Order } from "effect"

// `CodeReviewTeamPage`: team KPIs, a few highlights, and the per-person scorecard against the team
// median, ranked only on request.

type H = HtmlBuilder<Message>

const rateOf = (rate: number | null) => (rate === null ? EMPTY_VALUE : formatPercent(rate))
const spanOf = (seconds: number | null) => (seconds === null ? EMPTY_VALUE : formatSpan(seconds))
/** Runner time in hours past the first: days of CI read as a calendar span, not as work. */
const runnerTimeOf = (ms: number) =>
	ms < 3_600_000 ? formatSpan(ms / 1000) : `${formatExactCount(Math.round(ms / 3_600_000))}h`

type Column = Readonly<{
	metric: Metric
	label: string
	hint: string
	/** Width and the breakpoint it shows from. */
	className: string
	format: (value: number | null) => string
	/** The counts behind a member's value. */
	detail: (member: CodeReviewTeamMember, scores: TeamScores) => string
}>

const COLUMNS: ReadonlyArray<Column> = [
	{
		metric: "score",
		label: "Score",
		hint: "Quality and merged volume in one 0-100 score, the team at about 50: 80% quality (findings merged unfixed, critical findings, first-try CI failures, each against the team), 20% merged pull requests against the team median. Few pull requests read close to the team until there is more to judge",
		className: "w-20",
		format: (value) => (value === null ? EMPTY_VALUE : formatNumber(Math.round(value))),
		detail: (member, scores) => {
			const score = scores.get(member.login)
			return score === undefined
				? "No merged pull request to score"
				: `Quality ${Math.round(score.quality * 100)} of 100, volume ${Math.round(score.volume * 100)} of 100 over ${member.mergedPullRequests} merged pull requests`
		},
	},
	{
		metric: "merged",
		label: "Merged",
		hint: "Pull requests merged, of the ones first reviewed in this window",
		className: "hidden w-24 sm:table-cell",
		format: (value) => (value === null ? EMPTY_VALUE : formatNumber(value)),
		detail: (member) =>
			`${member.mergedPullRequests} of ${member.pullRequests} reviewed pull requests merged`,
	},
	{
		metric: "mergeTime",
		label: "To merge",
		hint: "Median time from a pull request's first review to its merge",
		className: "hidden w-24 md:table-cell",
		format: spanOf,
		detail: (member) => `Median over ${member.mergedPullRequests} merged pull requests`,
	},
	{
		metric: "fixRate",
		label: "Fixed",
		hint: "Findings fixed in a later push, over those fixed plus those still open when the pull request merged",
		className: "w-24",
		format: rateOf,
		detail: (member) =>
			`${member.resolvedFindings} fixed, ${member.openAtMergeFindings} still open at merge`,
	},
	{
		metric: "criticalPerPr",
		label: "Critical / PR",
		hint: "Critical findings per reviewed pull request",
		className: "hidden w-28 lg:table-cell",
		format: (value) => (value === null ? EMPTY_VALUE : value.toFixed(2)),
		detail: (member) => `${member.criticalFindings} critical over ${member.pullRequests} pull requests`,
	},
	{
		metric: "firstTryGreen",
		label: "First-try green",
		hint: "CI runs that passed on their first attempt, over first attempts that passed or failed",
		className: "w-32",
		format: rateOf,
		detail: (member) => `${member.firstTryGreen} of ${member.firstTryRuns} first attempts passed`,
	},
	{
		metric: "rerunRate",
		label: "Reruns",
		hint: "Runs that were a rerun of a workflow, over every run the person started",
		className: "hidden w-24 xl:table-cell",
		format: rateOf,
		detail: (member) => `${countLabel(member.reruns, "rerun")} over ${countLabel(member.ciRuns, "run")}`,
	},
	{
		metric: "shippedClean",
		label: "Shipped clean",
		hint: "Merged pull requests the post-merge look found clean, over those it judged",
		className: "hidden w-28 lg:table-cell",
		format: rateOf,
		detail: (member) =>
			`${member.shippedClean} clean, ${member.shippedRegressed} regressed after the deploy`,
	},
	{
		metric: "ciTime",
		label: "CI time",
		hint: "Time the person's jobs spent on a runner, queue left out",
		className: "hidden w-24 md:table-cell",
		format: (value) => (value === null ? EMPTY_VALUE : runnerTimeOf(value)),
		detail: (member) => `${countLabel(member.ciRuns, "run")}, ${member.cancelledRuns} cancelled`,
	},
]

/** How the panel title names the column a ranked view orders by. */
const RANKED_BY = {
	score: "score",
	merged: "pull requests merged",
	mergeTime: "time to merge",
	fixRate: "fix rate",
	criticalPerPr: "critical findings per pull request",
	firstTryGreen: "first-try green",
	rerunRate: "rerun rate",
	shippedClean: "shipped clean",
	ciTime: "CI time",
} satisfies Readonly<Record<Metric, string>>

/** The headline tiles' labels, in order; the loading skeleton shows them too. */
const HEADLINE_LABELS = {
	merged: "Merged",
	mergeTime: "Review to merge",
	firstReview: "First review",
	defaultRed: "Default branch red",
	ciPerMerge: "CI time per merge",
	runnerWait: "Runner wait",
} as const

const headlineStrip = (h: H, totals: CodeReviewTeamTotals): Html => {
	const failRate =
		totals.defaultBranchRuns === 0 ? null : totals.defaultBranchFailed / totals.defaultBranchRuns
	const stats: ReadonlyArray<{ label: string; value: string; subline?: string; hint: string }> = [
		{
			label: HEADLINE_LABELS.merged,
			value: formatNumber(totals.mergedPullRequests),
			subline: `of ${formatNumber(totals.pullRequests)} reviewed`,
			hint: "Pull requests by people, first reviewed in this window, that merged",
		},
		{
			label: HEADLINE_LABELS.mergeTime,
			value: spanOf(totals.medianMergeSeconds),
			subline: "median",
			hint: "Median time from a pull request's first review to its merge",
		},
		{
			label: HEADLINE_LABELS.firstReview,
			value: spanOf(totals.medianFirstReviewSeconds),
			subline: "median",
			hint: "Median time from a pull request's first review being queued to it being posted",
		},
		{
			label: HEADLINE_LABELS.defaultRed,
			value: rateOf(failRate),
			subline: `of ${formatNumber(totals.defaultBranchRuns)} pushes`,
			hint: "CI runs on pushes to a repository's default branch that failed",
		},
		{
			label: HEADLINE_LABELS.ciPerMerge,
			value:
				totals.mergedPullRequests === 0
					? EMPTY_VALUE
					: formatSpan(totals.runnerMs / 1000 / totals.mergedPullRequests),
			subline: `${runnerTimeOf(totals.runnerMs)} in total`,
			hint: "Runner time of every CI run, bots included, per merged pull request",
		},
		{
			label: HEADLINE_LABELS.runnerWait,
			value: totals.p95QueueMs === null ? EMPTY_VALUE : formatSpan(totals.p95QueueMs / 1000),
			subline: "p95",
			hint: "How long the slowest 5% of jobs waited for a runner",
		},
	]
	return statRail(
		h,
		{ columns: 3, className: "xl:grid-cols-6" },
		Arr.map(stats, (stat) =>
			h.div(
				[h.Key(stat.label), h.Title(stat.hint)],
				[
					statRailItem(h, {
						compact: true,
						eyebrow: stat.label,
						value: stat.value,
						subline: stat.subline,
					}),
				],
			),
		),
	)
}

const highlightLine = (key: "fixed" | "steady" | "fast", value: number) => {
	switch (key) {
		case "fixed":
			return `${formatNumber(value)} findings fixed before merge`
		case "steady":
			return `${formatPercent(value)} green on the first try`
		case "fast":
			return `${formatSpan(value)} median to merge`
	}
}

const highlights = (h: H, members: ReadonlyArray<CodeReviewTeamMember>): Html | null => {
	const items = highlightsOf(members)
	if (items.length === 0) return null
	return h.section(
		[h.AriaLabel("Highlights")],
		[
			statRail(
				h,
				// One per row on a phone: a login and its line need the width.
				{ columns: 3, className: "grid-cols-1" },
				Arr.map(items, (item) =>
					h.div(
						[h.Key(item.key)],
						[
							statRailItem(h, {
								compact: true,
								eyebrow: item.title,
								value: authorLabel(h, item.login, "max-w-full text-base"),
								subline: highlightLine(item.key, item.value),
							}),
						],
					),
				),
			),
		],
	)
}

/** People and repositories a day card lists before folding the rest into a count. */
const CARD_PEOPLE = 6
const CARD_REPOSITORIES = 4

/** A `YYYY-MM-DD` as "Tue, Oct 14": the day is already in the viewer's zone. */
const dayLabelOf = (
	day: string,
	options: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric" },
) => new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", { ...options, timeZone: "UTC" })

const countLine = (count: { readonly opened: number; readonly merged: number }) =>
	Arr.join(
		Arr.filter(
			[
				count.opened > 0 ? `${formatNumber(count.opened)} opened` : null,
				count.merged > 0 ? `${formatNumber(count.merged)} merged` : null,
			],
			(part) => part !== null,
		),
		", ",
	)

const pullRequestCount = (count: number) => `${formatNumber(count)} pull request${count === 1 ? "" : "s"}`

const cardSection = (h: H, title: string, rows: ReadonlyArray<Html>, more: number): Html =>
	vstack(h, { gap: "1.5", className: "border-t px-3 py-2.5" }, [
		typography(h, { size: "2xs", tone: "muted", weight: "medium" }, [title]),
		...rows,
		...(more > 0
			? [typography(h, { size: "2xs", tone: "muted" }, [`and ${formatNumber(more)} more`])]
			: []),
	])

const countCell = (h: H, count: ActivityCount): Html =>
	typography(h, { size: "xs", tone: "muted", numeric: true, className: "shrink-0" }, [countLine(count)])

/**
 * `wrap` for the day card: the pointer passes through it, so a truncated name has no title to hover.
 * It breaks after the owner's slash first.
 */
const repositoryLabel = (h: H, repository: string, wrap = false): Html =>
	typography(
		h,
		{
			size: "xs",
			mono: true,
			truncate: !wrap,
			className: wrap ? "min-w-0 wrap-anywhere" : "min-w-0",
			attributes: [h.Title(repository)],
		},
		wrap
			? Arr.flatMap(Str.split("/")(repository), (part, index) =>
					index === 0 ? [part] : ["/", h.wbr([]), part],
				)
			: [repository],
	)

/** What a calendar day's card says: the totals, then who and where. */
const dayCard = (h: H, day: string, activity: ActivityDay | undefined): ReadonlyArray<Html> => [
	vstack(h, { gap: "0.5", className: "px-3 py-2.5" }, [
		typography(h, { size: "xs", weight: "medium" }, [
			dayLabelOf(day, { weekday: "long", month: "long", day: "numeric", year: "numeric" }),
		]),
		typography(h, { size: "xs", tone: "muted" }, [
			activity === undefined
				? "No pull requests"
				: `${pullRequestCount(totalOf(activity))}: ${countLine(activity)}`,
		]),
	]),
	...(activity === undefined
		? []
		: [
				cardSection(
					h,
					"People",
					Arr.map(activity.people.slice(0, CARD_PEOPLE), (person) =>
						hstack(h, { gap: "3", justify: "between", attributes: [h.Key(person.key)] }, [
							authorLabel(h, person.key, "text-xs", true),
							countCell(h, person),
						]),
					),
					activity.people.length - CARD_PEOPLE,
				),
				cardSection(
					h,
					"Repositories",
					Arr.map(activity.repositories.slice(0, CARD_REPOSITORIES), (repository) =>
						hstack(h, { gap: "3", justify: "between", attributes: [h.Key(repository.key)] }, [
							repositoryLabel(h, repository.key, true),
							countCell(h, repository),
						]),
					),
					activity.repositories.length - CARD_REPOSITORIES,
				),
			]),
]

const dayTriggerId = (day: string) => `${ACTIVITY_CARD_ID}-day-${day}`
const dayOfTrigger = (triggerId: string) => Str.slice(-10)(triggerId)

/** The window's busiest people or repositories with a bar each, beside the calendar. */
const topList = (
	h: H,
	title: string,
	byDay: ReadonlyMap<string, ActivityDay>,
	countsOf: (day: ActivityDay) => ReadonlyArray<ActivityCount>,
	label: (key: string) => Html,
): Html | null => {
	const totals = new Map<string, number>()
	for (const day of byDay.values())
		for (const count of countsOf(day))
			totals.set(count.key, (totals.get(count.key) ?? 0) + totalOf(count))
	const ranked = Arr.sort([...totals.entries()], (a: [string, number], b: [string, number]) =>
		a[1] === b[1] ? Str.localeCompare(b[0])(a[0]) : Order.Number(b[1], a[1]),
	).slice(0, 5)
	const max = ranked[0]?.[1] ?? 0
	if (ranked.length === 0) return null
	return vstack(h, { gap: "2.5", className: "min-w-0" }, [
		typography(h, { size: "2xs", tone: "muted", weight: "medium" }, [title]),
		...Arr.map(ranked, ([key, total]) =>
			vstack(h, { gap: "1", attributes: [h.Key(key)] }, [
				hstack(h, { gap: "3", justify: "between" }, [
					label(key),
					typography(h, { size: "xs", tone: "muted", numeric: true, className: "shrink-0" }, [
						formatNumber(total),
					]),
				]),
				h.div(
					[h.Class("h-1 w-full rounded-full bg-muted")],
					[
						h.div([
							h.Class("h-full rounded-full"),
							h.Style({
								width: `${(total / max) * 100}%`,
								"background-color": "var(--heatmap-amber-3)",
							}),
						]),
					],
				),
			]),
		),
	])
}

/** A GitHub-style calendar of the team's pull requests, a card per day naming who and where. */
const activityPanel = (h: H, model: Model, team: CodeReviewTeam, timeZone: string): Html => {
	const byDay = activityByDay(team.activity)
	const days = daysOf(team.activityStartTime, team.endTime, timeZone)
	const max = Math.max(0, ...Arr.map([...byDay.values()], totalOf))
	const opened = Arr.reduce(team.activity, 0, (sum, row) => sum + row.opened)
	const merged = Arr.reduce(team.activity, 0, (sum, row) => sum + row.merged)
	const ids = Arr.map(days, dayTriggerId)
	const sides = Arr.filter(
		[
			topList(
				h,
				"Most active people",
				byDay,
				(day) => day.people,
				(login) => authorLabel(h, login, "text-xs"),
			),
			topList(
				h,
				"Most active repositories",
				byDay,
				(day) => day.repositories,
				(repository) => repositoryLabel(h, repository),
			),
		],
		(side): side is Html => side !== null,
	)
	return h.submodel({
		slotId: ACTIVITY_CARD_ID,
		model: model.activityCard,
		view: HoverCard.view,
		toParentMessage: (message) => Message.GotActivityCardMessage({ message }),
		viewInputs: {
			triggerIds: ids,
			className: "w-72 p-0",
			toContent: (triggerId) => {
				const day = dayOfTrigger(triggerId)
				return dayCard(h, day, byDay.get(day))
			},
			toView: ({ triggerFor, portal }) =>
				panel(h, {}, [
					panelHeader(h, {
						title: "Activity",
						action: typography(h, { size: "xs", tone: "muted" }, ["Last 12 months"]),
					}),
					vstack(h, { gap: "0" }, [
						contributionCalendar(h, {
							ariaLabel: "Pull requests opened and merged per day",
							className: "px-5 pt-5 pb-4",
							summary:
								opened + merged === 0
									? "No pull requests in the last 12 months"
									: `${formatNumber(opened)} opened and ${formatNumber(merged)} merged in the last 12 months`,
							days: Arr.map(days, (day) => {
								const activity = byDay.get(day)
								const total = activity === undefined ? 0 : totalOf(activity)
								return {
									day,
									level: contributionLevel(total, max),
									label: `${dayLabelOf(day)}: ${activity === undefined ? "no pull requests" : countLine(activity)}`,
									attributes: triggerFor(dayTriggerId(day)),
								}
							}),
						}),
						...(sides.length === 0
							? []
							: [h.div([h.Class("grid gap-8 border-t px-5 py-4 md:grid-cols-2")], sides)]),
						...(portal === null ? [] : [portal]),
					]),
				]),
		},
	})
}

const sortHead = (h: H, column: Column, model: Model, ranked: boolean): Html => {
	const sort = sortOf(model.search)
	const isActive = ranked ? rankedMetric(sort) === column.metric : sort === column.metric
	const isAscending = ASCENDING.has(column.metric)
	const className = cn("px-3 text-right font-normal", column.className)
	// Ranked orders by rates alone: a count column is a plain header there.
	if (ranked && !RANKABLE.has(column.metric))
		return tableHead(h, [h.span([h.Title(column.hint)], [column.label])], className)
	return tableHead(
		h,
		[
			sortButton(
				h,
				{
					isActive,
					direction: isAscending ? "asc" : "desc",
					onClick: Message.ClickedSort({ sort: column.metric }),
					align: "right",
					attributes: [h.Title(column.hint)],
				},
				[column.label],
			),
		],
		className,
		[h.Attribute("aria-sort", isActive ? (isAscending ? "ascending" : "descending") : "none")],
	)
}

const personHead = (h: H, model: Model): Html => {
	const isActive = sortOf(model.search) === "person" && !isRanked(model.search)
	return tableHead(
		h,
		[
			sortButton(h, { isActive, direction: "asc", onClick: Message.ClickedSort({ sort: "person" }) }, [
				"Person",
			]),
		],
		"px-4 font-normal",
		[h.Attribute("aria-sort", isActive ? "ascending" : "none")],
	)
}

const medianRow = (
	h: H,
	members: ReadonlyArray<CodeReviewTeamMember>,
	scores: TeamScores,
	ranked: boolean,
): Html =>
	tableRow(
		h,
		[
			...(ranked ? [tableCell(h, [], "w-10 px-3")] : []),
			tableCell(h, ["Team median"], "px-4 py-2 text-xs font-medium text-muted-foreground"),
			...Arr.map(COLUMNS, (column) =>
				tableCell(
					h,
					[column.format(teamMedian(members, column.metric, scores))],
					cn("px-3 text-right text-xs tabular-nums text-muted-foreground", column.className),
				),
			),
		],
		"bg-surface-sunken",
		[h.Key("median")],
	)

const memberRow = (
	h: H,
	member: CodeReviewTeamMember,
	scores: TeamScores,
	rank: number | null,
	ranked: boolean,
): Html =>
	tableRow(
		h,
		[
			...(ranked
				? [
						tableCell(
							h,
							[rank === null ? EMPTY_VALUE : String(rank)],
							"w-10 px-3 tabular-nums text-muted-foreground",
						),
					]
				: []),
			tableCell(h, [authorLabel(h, member.login, "max-w-full")], "px-4 py-2.5"),
			...Arr.map(COLUMNS, (column) =>
				tableCell(
					h,
					[column.format(metricOf(member, column.metric, scores))],
					cn(typographyClass({ numeric: true, className: "px-3 text-right" }), column.className),
					[h.Title(column.detail(member, scores))],
				),
			),
		],
		undefined,
		[h.Key(member.login)],
	)

const scorecardTitle = (model: Model) =>
	isRanked(model.search) ? `Ranked by ${RANKED_BY[rankedMetric(sortOf(model.search))]}` : "Scorecard"

const scorecardFooter = (h: H, ranked: boolean): Html =>
	h.footer(
		[h.Class("border-t px-4 py-3 text-xs text-muted-foreground")],
		[
			ranked
				? `Ranked on rates, medians and the score, people with at least ${RANK_MIN_PULL_REQUESTS} reviewed pull requests. Bots and CI runs that only waited for approval are left out.`
				: "Each person's numbers next to the team median. Bots, and CI runs that only waited for approval, are left out. Hover a value for the counts behind it.",
		],
	)

const scorecard = (h: H, model: Model, members: ReadonlyArray<CodeReviewTeamMember>): Html => {
	const ranked = isRanked(model.search)
	const scores = teamScores(members)
	const rows = scorecardRows(members, sortOf(model.search), ranked, scores)
	return panel(h, {}, [
		panelHeader(h, {
			title: scorecardTitle(model),
			action: segmentedSelect(h, {
				size: "sm",
				ariaLabel: "Scorecard view",
				value: ranked ? "ranked" : "scorecard",
				onChange: (view) => Message.SelectedView({ view }),
				options: [
					{ value: "scorecard", label: "Everyone" },
					{ value: "ranked", label: "Ranked" },
				],
			}),
		}),
		rows.length === 0
			? emptyMessage(h, { className: "px-4 py-6" }, [
					ranked
						? `Nobody has ${RANK_MIN_PULL_REQUESTS} reviewed pull requests in this window yet`
						: "Nobody in this window",
				])
			: table(h, { size: "sm", className: "table-fixed" }, [
					tableHeader(
						h,
						[
							tableRow(h, [
								...(ranked ? [tableHead(h, ["#"], "w-10 px-3 font-normal")] : []),
								personHead(h, model),
								...Arr.map(COLUMNS, (column) => sortHead(h, column, model, ranked)),
							]),
						],
						{ className: "bg-surface-sunken" },
					),
					tableBody(h, [
						medianRow(h, members, scores, ranked),
						...Arr.map(rows, (row) => memberRow(h, row.member, scores, row.rank, ranked)),
					]),
				]),
		scorecardFooter(h, ranked),
	])
}

/** The headline and scorecard with their real labels, columns and footer, values still loading. */
const teamSkeleton = (h: H, model: Model): Html => {
	const ranked = isRanked(model.search)
	const columns: ReadonlyArray<SkeletonColumn> = [
		...(ranked ? [{ label: "#", head: "w-10 px-3", cell: "px-3", bar: "h-3 w-4" }] : []),
		{ label: "Person", head: "px-4", cell: "px-4 py-2.5", bar: "h-3 w-28" },
		...Arr.map(COLUMNS, (column): SkeletonColumn => ({
			label: column.label,
			head: cn("px-3", column.className),
			cell: cn("px-3", column.className),
			align: "right",
		})),
	]
	const median = tableRow(
		h,
		[
			...(ranked ? [tableCell(h, [], "w-10 px-3")] : []),
			tableCell(h, ["Team median"], "px-4 py-2 text-xs font-medium text-muted-foreground"),
			...Arr.map(COLUMNS, (column) =>
				tableCell(h, [line(h, "h-4 justify-end", "h-2.5 w-8")], cn("px-3", column.className)),
			),
		],
		"bg-surface-sunken",
	)
	return busyPage(h, "Loading the team", [
		headlineSkeleton(h, Rec.values(HEADLINE_LABELS), { columns: 3, className: "xl:grid-cols-6" }),
		panel(h, {}, [
			panelHeader(h, { title: scorecardTitle(model), action: panelControl(h) }),
			tableSkeleton(h, columns, { first: median }),
			scorecardFooter(h, ranked),
		]),
	])
}

/** The on-ramp for an org with neither reviews nor CI runs. */
const noTeamData = (h: H): Html =>
	empty(
		h,
		[
			emptyHeader(h, [
				emptyTitle(h, ["No team activity yet"]),
				emptyDescription(h, [
					"The team view reads pull request reviews and CI runs from the GitHub integration: turn on reviews for a repository, or CI traces, and everyone who opens pull requests or pushes shows up here.",
				]),
			]),
			linkButton(
				h,
				{
					variant: "outline",
					size: "sm",
					href: hrefOf(AppRoute.SourcesNew({ search: { integration: "github" } })),
				},
				["Open the GitHub integration"],
			),
		],
		emptyFrameClass("dashed"),
	)

const teamView = (h: H, model: Model, team: CodeReviewTeam, timeZone: string): Html => {
	const highlighted = highlights(h, team.members)
	return vstack(h, { gap: "6" }, [
		headlineStrip(h, team.totals),
		...(highlighted === null ? [] : [highlighted]),
		activityPanel(h, model, team, timeZone),
		scorecard(h, model, team.members),
	])
}

const content = (h: H, model: Model, timeZone: string): Html =>
	AsyncData.matchData(model.team.data, {
		onEmpty: () => teamSkeleton(h, model),
		onFailure: (failure) =>
			errorState(h, { failure, title: "Couldn't load the team", onRetry: Message.ClickedRetry() }),
		onData: (team) => {
			if (team.members.length > 0) return teamView(h, model, team, timeZone)
			if (model.search.repo === undefined && team.totals.runnerMs === 0) return noTeamData(h)
			const filtered = model.search.repo !== undefined
			if (filtered)
				return filteredEmpty(h, {
					noun: "team members",
					description: "Widen the window or clear the filter.",
					onClear: Message.ClickedClearFilters(),
					className: emptyFrameClass("dashed"),
				})
			return empty(
				h,
				[
					emptyHeader(h, [
						emptyTitle(h, ["Nobody in this window"]),
						emptyDescription(h, [
							"No pull request was reviewed and no CI run finished in this window. Widen the window.",
						]),
					]),
				],
				emptyFrameClass("dashed"),
			)
		},
	})

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const filters = filtersView(h, {
		frame: model.frame,
		search: model.search,
		reviewedOnly: false,
		kind: "author",
		options: [],
		selected: undefined,
		defaultPreset: DEFAULT_PRESET,
		presets: TimeRangePicker.LONG_RANGE_PRESET_VALUES,
		toMessage: (message) => Message.GotFrameMessage({ message }),
		isFailed: AsyncData.isFailure(model.team.data),
	})
	return codeReviewLayout(
		{
			h,
			active: "team",
			search: model.search,
			toolbar: filters.actions,
			// The repository alone: the team is everyone, never one author.
			filters: filters.filters.slice(0, 1),
		},
		[content(h, model, inputs.context.timeZone)],
	)
})
