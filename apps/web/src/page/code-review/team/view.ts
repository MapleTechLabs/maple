import type { CodeReviewTeam, CodeReviewTeamMember, CodeReviewTeamTotals } from "@maple/domain/http"
import { formatSpan } from "../../../components/code-review/code-review-format"
import { EMPTY_VALUE, formatNumber, formatPercent } from "@maple/ui/lib/format"
import { formatExactCount } from "../../kit/locale"
import { cn } from "@maple/ui/lib/utils"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { linkButton } from "../../../ui/button"
import { empty, emptyDescription, emptyHeader, emptyMessage, emptyTitle } from "../../../ui/empty"
import { errorState } from "../../../ui/error-state"
import { icon } from "../../../ui/icon"
import { panel, panelHeader } from "../../../ui/panel"
import { segmentedSelect } from "../../../ui/segmented-select"
import { table, tableBody, tableCell, tableHead, tableHeader, tableRow } from "../../../ui/table"
import type { PageViewInputs } from "../../contract"
import { nothingInWindow } from "../../kit/nothing-in-window"
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
	type Metric,
	metricOf,
	RANK_MIN_PULL_REQUESTS,
	RANKABLE,
	rankedMetric,
	scorecardRows,
	teamMedian,
} from "./derive"
import { Message, type Model } from "./model"
import { DEFAULT_PRESET } from "./update"

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
	detail: (member: CodeReviewTeamMember) => string
}>

const COLUMNS: ReadonlyArray<Column> = [
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
		detail: (member) => `${member.reruns} reruns over ${member.ciRuns} runs`,
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
		detail: (member) => `${member.ciRuns} runs, ${member.cancelledRuns} cancelled`,
	},
]

/** How the panel title names the column a ranked view orders by. */
const RANKED_BY = {
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
		stats.map((stat) =>
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
				items.map((item) =>
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

const sortHead = (h: H, column: Column, model: Model, ranked: boolean): Html => {
	const sort = model.search.sort ?? "person"
	const isActive = ranked ? rankedMetric(sort) === column.metric : sort === column.metric
	const isAscending = ASCENDING.has(column.metric)
	const className = cn("px-3 text-right font-normal", column.className)
	// Ranked orders by rates alone: a count column is a plain header there.
	if (ranked && !RANKABLE.has(column.metric))
		return tableHead(h, [h.span([h.Title(column.hint)], [column.label])], className)
	return tableHead(
		h,
		[
			h.button(
				[
					h.Type("button"),
					h.Title(column.hint),
					h.OnClick(Message.ClickedSort({ sort: column.metric })),
					h.Class(
						cn(
							"inline-flex items-center gap-1 hover:text-foreground active:text-foreground focus-visible:underline focus-visible:outline-none",
							isActive && "text-foreground",
						),
					),
				],
				[
					column.label,
					...(isActive
						? [icon(h, isAscending ? "ArrowUpIcon" : "ArrowDownIcon", { className: "size-3" })]
						: []),
				],
			),
		],
		className,
		[h.Attribute("aria-sort", isActive ? (isAscending ? "ascending" : "descending") : "none")],
	)
}

const personHead = (h: H, model: Model): Html => {
	const isActive = (model.search.sort ?? "person") === "person" && model.search.ranked !== true
	return tableHead(
		h,
		[
			h.button(
				[
					h.Type("button"),
					h.OnClick(Message.ClickedSort({ sort: "person" })),
					h.Class(
						cn(
							"inline-flex items-center gap-1 hover:text-foreground active:text-foreground focus-visible:underline focus-visible:outline-none",
							isActive && "text-foreground",
						),
					),
				],
				["Person"],
			),
		],
		"px-4 font-normal",
		[h.Attribute("aria-sort", isActive ? "ascending" : "none")],
	)
}

const medianRow = (h: H, members: ReadonlyArray<CodeReviewTeamMember>, ranked: boolean): Html =>
	tableRow(
		h,
		[
			...(ranked ? [tableCell(h, [], "w-10 px-3")] : []),
			tableCell(h, ["Team median"], "px-4 py-2 text-xs font-medium text-muted-foreground"),
			...COLUMNS.map((column) =>
				tableCell(
					h,
					[column.format(teamMedian(members, column.metric))],
					cn("px-3 text-right text-xs tabular-nums text-muted-foreground", column.className),
				),
			),
		],
		"bg-surface-sunken",
		[h.Key("median")],
	)

const memberRow = (h: H, member: CodeReviewTeamMember, rank: number | null, ranked: boolean): Html =>
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
			...COLUMNS.map((column) =>
				tableCell(
					h,
					[column.format(metricOf(member, column.metric))],
					cn("px-3 text-right tabular-nums", column.className),
					[h.Title(column.detail(member))],
				),
			),
		],
		undefined,
		[h.Key(member.login)],
	)

const scorecardTitle = (model: Model) =>
	model.search.ranked === true
		? `Ranked by ${RANKED_BY[rankedMetric(model.search.sort ?? "person")]}`
		: "Scorecard"

const scorecardFooter = (h: H, ranked: boolean): Html =>
	h.footer(
		[h.Class("border-t px-4 py-3 text-xs text-muted-foreground")],
		[
			ranked
				? `Ranked on rates and medians only, people with at least ${RANK_MIN_PULL_REQUESTS} reviewed pull requests. Bots and CI runs that only waited for approval are left out.`
				: "Each person's numbers next to the team median. Bots, and CI runs that only waited for approval, are left out. Hover a value for the counts behind it.",
		],
	)

const scorecard = (h: H, model: Model, members: ReadonlyArray<CodeReviewTeamMember>): Html => {
	const ranked = model.search.ranked === true
	const rows = scorecardRows(members, model.search.sort ?? "person", ranked)
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
								...COLUMNS.map((column) => sortHead(h, column, model, ranked)),
							]),
						],
						{ className: "bg-surface-sunken" },
					),
					tableBody(h, [
						medianRow(h, members, ranked),
						...rows.map((row) => memberRow(h, row.member, row.rank, ranked)),
					]),
				]),
		scorecardFooter(h, ranked),
	])
}

/** The headline and scorecard with their real labels, columns and footer, values still loading. */
const teamSkeleton = (h: H, model: Model): Html => {
	const ranked = model.search.ranked === true
	const columns: ReadonlyArray<SkeletonColumn> = [
		...(ranked ? [{ label: "#", head: "w-10 px-3", cell: "px-3", bar: "h-3 w-4" }] : []),
		{ label: "Person", head: "px-4", cell: "px-4 py-2.5", bar: "h-3 w-28" },
		...COLUMNS.map((column): SkeletonColumn => ({
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
			...COLUMNS.map((column) =>
				tableCell(h, [line(h, "h-4 justify-end", "h-2.5 w-8")], cn("px-3", column.className)),
			),
		],
		"bg-surface-sunken",
	)
	return busyPage(h, "Loading the team", [
		headlineSkeleton(h, Object.values(HEADLINE_LABELS), { columns: 3, className: "xl:grid-cols-6" }),
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
		"rounded-md border border-dashed md:py-14",
	)

const teamView = (h: H, model: Model, team: CodeReviewTeam): Html => {
	const highlighted = highlights(h, team.members)
	return h.div(
		[h.Class("flex flex-col gap-6")],
		[
			headlineStrip(h, team.totals),
			...(highlighted === null ? [] : [highlighted]),
			scorecard(h, model, team.members),
		],
	)
}

const content = (h: H, model: Model): Html =>
	AsyncData.matchData(model.team.data, {
		onEmpty: () => teamSkeleton(h, model),
		onFailure: (failure) =>
			errorState(h, { failure, title: "Couldn't load the team", onRetry: Message.ClickedRetry() }),
		onData: (team) => {
			if (team.members.length > 0) return teamView(h, model, team)
			if (model.search.repo === undefined && team.totals.runnerMs === 0) return noTeamData(h)
			return nothingInWindow(h, {
				title: "Nobody in this window",
				description:
					model.search.repo === undefined
						? "No pull request was reviewed and no CI run finished in this window. Widen the window."
						: "Nothing matches this repository. Widen the window or clear the filter.",
				onClear: model.search.repo === undefined ? undefined : Message.ClickedClearFilters(),
			})
		},
	})

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, _inputs, h) => {
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
		[content(h, model)],
	)
})
