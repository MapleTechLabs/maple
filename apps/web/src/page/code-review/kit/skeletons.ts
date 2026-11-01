import { cn } from "@maple/ui/lib/utils"
import { skeletonStyles } from "@maple/ui/styles/ui/skeleton"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as DialogView from "../../../ui/dialog-view"
import { listRow } from "../../../ui/list-row"
import { panel, panelHeader } from "../../../ui/panel"
import { skeletonSlowNote } from "../../../ui/skeleton"
import { table, tableBody, tableCell, tableHead, tableHeader, tableRow } from "../../../ui/table"
import { chartSkeleton } from "../../../ui/chart-skeleton"
import { sectionHeading } from "../../kit/section-heading"
import { statRail, statRailItem, type StatRailColumns } from "../../kit/stat-rail"
import { settingsSection, settingsSections } from "../../settings/kit/section"
import { analyticsPanel } from "./analytics-panel"
import { section } from "./parts"

// Loading states for code review, drawn in the real panels, headers and row geometry: labels and
// titles that don't depend on the data render for real, so only the values swap in.

const ROWS = 8

/** Per-row widths, cycled so the placeholder reads as varied text rather than a grid of bars. */
const TITLE_WIDTHS = ["w-[62%]", "w-[48%]", "w-[71%]", "w-[40%]", "w-[56%]", "w-[66%]"]
const META_WIDTHS = ["w-[34%]", "w-[42%]", "w-[28%]", "w-[38%]", "w-[24%]", "w-[44%]"]

const pick = (widths: ReadonlyArray<string>, index: number) => widths[index % widths.length]

const rows = <T>(count: number, row: (index: number) => T): ReadonlyArray<T> =>
	Array.from({ length: count }, (_, index) => row(index))

const bar = <M>(h: HtmlBuilder<M>, className: string): Html =>
	h.span([h.Class(cn(skeletonStyles, "block", className)), h.DataAttribute("slot", "skeleton")])

/** A bar centred in a line box as tall as the text it stands in for (`leading-normal` rows are 21px and 18px). */
const line = <M>(h: HtmlBuilder<M>, lineClass: string, barClass: string, className?: string): Html =>
	h.span([h.Class(cn("flex items-center", lineClass, className))], [bar(h, barClass)])

/** A bar that sits inline in a text slot (a stat value, a subline). */
const inlineBar = <M>(h: HtmlBuilder<M>, className: string): Html =>
	bar(h, cn("inline-block align-middle", className))

const slowNote = <M>(h: HtmlBuilder<M>): Html => skeletonSlowNote(h, "absolute inset-x-0 top-full mt-1")

/** Busy region with the slow-load note in the gap under it, so it takes no space until it shows. */
const busy = <M>(h: HtmlBuilder<M>, label: string, body: Html): Html =>
	h.div([h.Class("relative"), h.AriaBusy(true), h.AriaLabel(label)], [body, slowNote(h)])

/** A busy page: the slow-load note sits under its first block, where a reader is looking. */
export const busyPage = <M>(h: HtmlBuilder<M>, label: string, [first, ...rest]: ReadonlyArray<Html>): Html =>
	h.div(
		[h.Class("flex flex-col gap-6"), h.AriaBusy(true), h.AriaLabel(label)],
		[h.div([h.Class("relative")], [first, slowNote(h)]), ...rest],
	)

/** One table column: its header, and the bar its cells show (`"title"` for the two-line lead cell). */
export type SkeletonColumn = Readonly<{ label: string; head: string; cell: string; bar: string | "title" }>

const twoLines = <M>(h: HtmlBuilder<M>, index: number): ReadonlyArray<Html> => [
	line(h, "h-[21px]", cn("h-3", pick(TITLE_WIDTHS, index))),
	line(h, "h-[18px]", cn("h-2.5", pick(META_WIDTHS, index)), "mt-0.5"),
]

export const tableSkeleton = <M>(
	h: HtmlBuilder<M>,
	columns: ReadonlyArray<SkeletonColumn>,
	count = ROWS,
): Html =>
	table(h, { size: "sm", className: "table-fixed" }, [
		tableHeader(
			h,
			[
				tableRow(
					h,
					columns.map((column) => tableHead(h, [column.label], cn(column.head, "font-normal"))),
				),
			],
			{ className: "bg-surface-sunken" },
		),
		tableBody(
			h,
			rows(count, (index) =>
				tableRow(
					h,
					columns.map((column) =>
						tableCell(
							h,
							column.bar === "title"
								? twoLines(h, index)
								: [
										line(
											h,
											cn("h-5", column.cell.includes("text-right") && "justify-end"),
											column.bar,
										),
									],
							column.cell,
						),
					),
				),
			),
		),
	])

const REVIEW_COLUMNS: ReadonlyArray<SkeletonColumn> = [
	{ label: "Pull request", head: "px-4", cell: "px-4 py-2.5", bar: "title" },
	{
		label: "Outcome",
		head: "hidden w-40 px-3 md:table-cell",
		cell: "hidden px-3 py-2.5 md:table-cell",
		bar: "h-3 w-20",
	},
	{
		label: "Confidence",
		head: "hidden w-28 px-3 text-right lg:table-cell",
		cell: "hidden px-3 text-right lg:table-cell",
		bar: "h-3 w-9",
	},
	{
		label: "Quality",
		head: "hidden w-24 px-3 text-right lg:table-cell",
		cell: "hidden px-3 text-right lg:table-cell",
		bar: "h-3 w-11",
	},
	{ label: "Issues", head: "w-24 px-3 text-right", cell: "px-3 text-right", bar: "h-3 w-6" },
	{
		label: "Reviewed",
		head: "hidden w-28 px-4 text-right sm:table-cell",
		cell: "hidden px-4 text-right sm:table-cell",
		bar: "h-3 w-14",
	},
]

const RUN_COLUMNS: ReadonlyArray<SkeletonColumn> = [
	{
		label: "Result",
		head: "w-24 px-3 sm:w-36 sm:px-4",
		cell: "px-3 py-2.5 align-top sm:px-4",
		bar: "h-5 w-16 rounded-md",
	},
	{ label: "Run", head: "px-3", cell: "px-3 py-2.5", bar: "title" },
	{
		label: "Duration",
		head: "hidden px-3 text-right sm:table-cell sm:w-24",
		cell: "hidden px-3 py-2.5 text-right align-top sm:table-cell",
		bar: "h-3 w-12",
	},
	{
		label: "Started",
		head: "hidden px-3 text-right md:table-cell md:w-24",
		cell: "hidden px-3 py-2.5 text-right align-top md:table-cell",
		bar: "h-3 w-10",
	},
	{
		label: "",
		head: "hidden px-4 sm:table-cell sm:w-48",
		cell: "hidden px-4 py-2.5 text-right align-top sm:table-cell",
		bar: "h-4 w-20 rounded-md",
	},
]

/** Workflow and job names are one line, unlike the two-line pull request and run cells. */
const NAME = "h-3 w-[55%]"
const NUMBER = "h-3 w-10"

const WORKFLOW_COLUMNS: ReadonlyArray<SkeletonColumn> = [
	{ label: "Workflow", head: "px-4", cell: "px-4 py-2.5", bar: NAME },
	{ label: "Runs", head: "w-20 px-3 text-right", cell: "px-3 text-right", bar: "h-3 w-8" },
	{ label: "Fail rate", head: "w-24 px-3 text-right", cell: "px-3 text-right", bar: NUMBER },
	{
		label: "p50",
		head: "hidden px-3 text-right lg:table-cell lg:w-24",
		cell: "hidden px-3 text-right lg:table-cell",
		bar: NUMBER,
	},
	{
		label: "p95",
		head: "hidden px-3 text-right lg:table-cell lg:w-24",
		cell: "hidden px-3 text-right lg:table-cell",
		bar: NUMBER,
	},
	{
		label: "CI time",
		head: "hidden px-3 text-right md:table-cell md:w-24",
		cell: "hidden px-3 text-right md:table-cell",
		bar: NUMBER,
	},
	{
		label: "Last run",
		head: "hidden px-4 sm:table-cell sm:w-44",
		cell: "hidden px-4 sm:table-cell",
		bar: "h-3 w-24",
	},
]

const JOB_COLUMNS: ReadonlyArray<SkeletonColumn> = [
	{ label: "Job", head: "px-4", cell: "px-4 py-2.5", bar: NAME },
	{ label: "Runs", head: "w-20 px-3 text-right", cell: "px-3 text-right", bar: "h-3 w-8" },
	{ label: "Fail rate", head: "w-24 px-3 text-right", cell: "px-3 text-right", bar: NUMBER },
	{
		label: "Retried",
		head: "hidden px-3 text-right md:table-cell md:w-20",
		cell: "hidden px-3 text-right md:table-cell",
		bar: "h-3 w-6",
	},
	{
		label: "p50",
		head: "hidden px-3 text-right lg:table-cell lg:w-24",
		cell: "hidden px-3 text-right lg:table-cell",
		bar: NUMBER,
	},
	{
		label: "p95",
		head: "hidden px-3 text-right lg:table-cell lg:w-24",
		cell: "hidden px-3 text-right lg:table-cell",
		bar: NUMBER,
	},
	{
		label: "Wait p50",
		head: "hidden px-3 text-right xl:table-cell xl:w-24",
		cell: "hidden px-3 text-right xl:table-cell",
		bar: NUMBER,
	},
	{
		label: "Wait p95",
		head: "hidden px-4 text-right xl:table-cell xl:w-24",
		cell: "hidden px-4 text-right xl:table-cell",
		bar: NUMBER,
	},
]

/** `reviewTable` while the first page loads. */
export const reviewTableSkeleton = <M>(h: HtmlBuilder<M>): Html =>
	busy(h, "Loading pull requests", panel(h, {}, [tableSkeleton(h, REVIEW_COLUMNS)]))

/** `runsList` while the first page loads. */
export const runsTableSkeleton = <M>(h: HtmlBuilder<M>): Html =>
	busy(h, "Loading CI runs", panel(h, {}, [tableSkeleton(h, RUN_COLUMNS)]))

/** `findingsList` while the first page loads. */
export const findingsListSkeleton = <M>(h: HtmlBuilder<M>): Html =>
	busy(
		h,
		"Loading issues",
		panel(h, {}, [
			h.ul(
				[h.Class("divide-y")],
				rows(ROWS, (index) =>
					listRow(h, {
						as: "li",
						className: "hover:bg-transparent active:bg-transparent",
						leading: h.span([h.Class("w-16")], [line(h, "h-4", "h-2.5 w-10")]),
						title: line(h, "h-5", cn("h-3", pick(TITLE_WIDTHS, index))),
						meta: line(h, "h-4", cn("h-2.5", pick(META_WIDTHS, index))),
						trailing: [
							line(h, "h-4", "h-2.5 w-16", "hidden sm:flex"),
							bar(h, "h-5 w-16 rounded-md"),
							line(h, "h-4 w-20 justify-end", "h-2.5 w-12", "hidden md:flex"),
						],
					}),
				),
			),
		]),
	)

/** A headline `StatRail` with its real labels and a bar for each value. */
export const headlineSkeleton = <M>(
	h: HtmlBuilder<M>,
	labels: ReadonlyArray<string>,
	options: Readonly<{ columns?: StatRailColumns; className?: string }> = {},
): Html =>
	statRail(
		h,
		options,
		labels.map((label) =>
			statRailItem(h, {
				compact: true,
				eyebrow: label,
				value: inlineBar(h, "h-6 w-16"),
				subline: inlineBar(h, "h-2.5 w-24"),
			}),
		),
	)

export const panelControl = <M>(h: HtmlBuilder<M>): Html => bar(h, "h-7 w-32 rounded-md")

const chartCard = <M>(
	h: HtmlBuilder<M>,
	title: string,
	variant: "bar" | "line",
	options: Readonly<{ control?: boolean; footer?: Html }> = {},
): Html =>
	analyticsPanel(
		h,
		{
			title,
			control: options.control === true ? panelControl(h) : undefined,
			footer: options.footer,
		},
		[h.div([h.Class("h-56 w-full")], [chartSkeleton(h, variant)])],
	)

/** `repositoryList` under a chart: its real caption and three repository rows. */
const repositoryRows = <M>(h: HtmlBuilder<M>, title: string): Html =>
	h.div(
		[h.Class("flex flex-col gap-2")],
		[
			h.span([h.Class("text-xs text-muted-foreground")], [title]),
			h.ul(
				[h.Class("flex flex-col")],
				rows(3, (index) =>
					h.li(
						[h.Class("flex h-8 items-center gap-2.5 py-1.5")],
						[
							bar(h, "size-4 shrink-0 rounded-full"),
							h.span(
								[h.Class("min-w-0 flex-1")],
								[bar(h, cn("h-3", pick(TITLE_WIDTHS, index + 1)))],
							),
							bar(h, "h-3 w-6"),
						],
					),
				),
			),
		],
	)

/** `barList`: a label and count over a meter, per row. */
const barListCard = <M>(h: HtmlBuilder<M>, title: string): Html =>
	analyticsPanel(h, { title }, [
		h.ul(
			[h.Class("flex flex-col gap-2.5")],
			rows(4, (index) =>
				h.li(
					[h.Class("flex flex-col gap-1")],
					[
						h.span(
							[h.Class("flex h-5 items-center justify-between gap-2")],
							[bar(h, cn("h-3", pick(META_WIDTHS, index))), bar(h, "h-3 w-6")],
						),
						bar(h, "h-1.5 w-full rounded-full"),
					],
				),
			),
		),
	])

const authorsCardSkeleton = <M>(h: HtmlBuilder<M>): Html =>
	analyticsPanel(h, { title: "Top authors" }, [
		table(h, { size: "sm", variant: "bare" }, [
			tableHeader(h, [
				tableRow(h, [
					tableHead(h, ["Author"], "pl-0 font-normal"),
					tableHead(h, ["PRs"], "text-right font-normal"),
					tableHead(h, ["Issues"], "pr-0 text-right font-normal"),
				]),
			]),
			tableBody(
				h,
				rows(4, (index) =>
					tableRow(h, [
						tableCell(h, [line(h, "h-5", cn("h-3", pick(TITLE_WIDTHS, index)))], "pl-0"),
						tableCell(h, [line(h, "h-5 justify-end", "h-3 w-6")]),
						tableCell(h, [line(h, "h-5 justify-end", "h-3 w-6")], "pr-0"),
					]),
				),
			),
		]),
	])

/** The analytics tab before its first answer and while the charts load. */
export const analyticsSkeleton = <M>(h: HtmlBuilder<M>): Html =>
	busyPage(h, "Loading review analytics", [
		headlineSkeleton(h, [
			"Pull requests reviewed",
			"Total reviews",
			"Avg time to merge",
			"Issues caught",
		]),
		h.div(
			[h.Class("grid gap-6 lg:grid-cols-2")],
			[
				chartCard(h, "Pull requests reviewed", "bar", {
					control: true,
					footer: repositoryRows(h, "Top repositories by reviews"),
				}),
				chartCard(h, "Issues caught", "bar", {
					control: true,
					footer: repositoryRows(h, "Repositories with the most issues"),
				}),
			],
		),
		h.div(
			[h.Class("grid gap-6 lg:grid-cols-3")],
			[barListCard(h, "Issues by category"), barListCard(h, "Review outcomes"), authorsCardSkeleton(h)],
		),
	])

const tablePanel = <M>(h: HtmlBuilder<M>, title: string, columns: ReadonlyArray<SkeletonColumn>): Html =>
	panel(h, {}, [panelHeader(h, { title }), tableSkeleton(h, columns, 4)])

/** The CI tab before its first answer and while the charts load. */
export const ciSkeleton = <M>(h: HtmlBuilder<M>): Html =>
	busyPage(h, "Loading CI analytics", [
		headlineSkeleton(
			h,
			["Runs", "Success rate", "p50 run time", "p95 run time", "Runner wait", "CI time"],
			{ columns: 3, className: "xl:grid-cols-6" },
		),
		h.div(
			[h.Class("grid gap-6 lg:grid-cols-2")],
			[chartCard(h, "Runs by result", "bar"), chartCard(h, "Run time", "line")],
		),
		tablePanel(h, "Workflows", WORKFLOW_COLUMNS),
		tablePanel(h, "Jobs by CI time", JOB_COLUMNS),
		h.section(
			[h.Class("flex flex-col gap-3")],
			[sectionHeading(h, { title: "Runs" }), panel(h, {}, [tableSkeleton(h, RUN_COLUMNS, 4)])],
		),
	])

/** Rules-form rows: a label and hint beside a control. */
export const rulesFormSkeleton = <M>(h: HtmlBuilder<M>, count = 4): Html =>
	h.div(
		[h.Class("flex flex-col divide-y")],
		rows(count, (index) =>
			h.div(
				[h.Class("flex items-center justify-between gap-6 py-3.5 first:pt-0 last:pb-0")],
				[
					h.div(
						[h.Class("flex min-w-0 flex-1 flex-col gap-1.5")],
						[bar(h, "h-3 w-36"), bar(h, cn("h-2.5", pick(TITLE_WIDTHS, index)))],
					),
					bar(h, "h-7 w-36 shrink-0 rounded-md"),
				],
			),
		),
	)

/** `repositoryList`: the access line, then one row per repository with its switch. */
export const repositoryListSkeleton = <M>(h: HtmlBuilder<M>): Html =>
	busy(
		h,
		"Loading repositories",
		panel(h, {}, [
			panelHeader(h, { className: "px-5 py-3", title: bar(h, "h-3 w-48") }),
			h.ul(
				[h.Class("divide-y")],
				rows(5, (index) =>
					h.li(
						[h.Class("flex items-center gap-3 px-5 py-3")],
						[
							bar(h, "size-4 shrink-0 rounded-full"),
							h.span(
								[h.Class("min-w-0 flex-1")],
								[bar(h, cn("h-3", pick(META_WIDTHS, index)))],
							),
							bar(h, "h-5 w-9 shrink-0 rounded-full"),
						],
					),
				),
			),
		]),
	)

/** The settings tab before its first answer: the real sections, with bodies still loading. */
export const settingsSkeleton = <M>(h: HtmlBuilder<M>): Html =>
	h.div(
		[h.Class("max-w-4xl"), h.AriaBusy(true), h.AriaLabel("Loading review settings")],
		[
			settingsSections(h, [
				settingsSection(
					h,
					{
						id: "code-review-settings-reviewer",
						title: "Reviewer",
						description: ["The model every review and reply in this organization runs on."],
						framed: false,
					},
					[
						h.div(
							[
								h.Class(
									"relative flex items-center justify-between gap-6 rounded-md border bg-card px-5 py-4",
								),
							],
							[
								h.div(
									[h.Class("flex flex-col gap-1.5")],
									[bar(h, "h-3 w-24"), bar(h, "h-2.5 w-56")],
								),
								bar(h, "h-8 w-56 rounded-md"),
								slowNote(h),
							],
						),
					],
				),
				settingsSection(
					h,
					{
						id: "code-review-settings-defaults",
						title: "Default review rules",
						description: [
							"Every repository starts from these. A repository can override any of them.",
						],
						framed: true,
					},
					[rulesFormSkeleton(h, 5)],
				),
				settingsSection(
					h,
					{
						id: "code-review-settings-repositories",
						title: "Repositories",
						description: [
							"Pick which repositories get reviews, and tune any of them on its own.",
						],
						framed: false,
					},
					[repositoryListSkeleton(h)],
				),
			]),
		],
	)

const SHEET_STATS = ["Outcome", "Confidence", "Quality", "Issues", "Duration", "Model", "Tokens", "Reviewed"]

/** `ReviewDetailBody` before the first answer: the header, stat tiles and summary in their places. */
export const reviewSheetSkeleton = <M>(h: HtmlBuilder<M>, id: string): ReadonlyArray<Html> => [
	DialogView.dialogHeader(
		h,
		"sheet",
		[
			bar(h, "h-3 w-24"),
			DialogView.dialogTitle(
				h,
				"sheet",
				id,
				[bar(h, "h-6 w-72 max-w-full")],
				"text-title leading-tight",
			),
			bar(h, "mt-1 h-3.5 w-80 max-w-full"),
			h.div(
				[h.Class("flex gap-2 pt-1")],
				[bar(h, "h-6 w-28 rounded-md"), bar(h, "h-6 w-36 rounded-md")],
			),
		],
		"gap-1.5 pr-14",
	),
	DialogView.dialogPanel(
		h,
		"sheet",
		id,
		[
			statRail(
				h,
				{},
				SHEET_STATS.map((label) =>
					statRailItem(h, {
						compact: true,
						eyebrow: label,
						value: inlineBar(h, "h-3.5 w-14"),
						className: "min-w-0 px-3 py-2.5",
						valueClassName: "text-sm",
					}),
				),
			),
			section(h, "Summary", [
				h.div(
					[h.Class("flex flex-col gap-2")],
					rows(4, (index) => bar(h, cn("h-3", index === 3 ? "w-[45%]" : "w-full"))),
				),
			]),
			section(h, "CI runs", [ciRunsSkeleton(h)]),
		],
		"flex flex-col gap-6",
	),
]

/** `PullRequestCiRuns`' rows: result badge, workflow, commit and duration. */
export const ciRunsSkeleton = <M>(h: HtmlBuilder<M>): Html =>
	h.ul(
		[h.Class("-mx-2 flex flex-col"), h.AriaBusy(true), h.AriaLabel("Loading CI runs")],
		rows(3, (index) =>
			h.li(
				[h.Class("flex h-8 items-center gap-3 px-2 py-1")],
				[
					h.span([h.Class("w-32 shrink-0")], [bar(h, "h-5 w-16 rounded-md")]),
					h.span([h.Class("min-w-0 flex-1")], [bar(h, cn("h-3", pick(TITLE_WIDTHS, index)))]),
					bar(h, "h-2.5 w-14"),
					bar(h, "h-2.5 w-10"),
				],
			),
		),
	)
