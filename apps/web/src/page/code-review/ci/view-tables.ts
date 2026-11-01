import type { CodeReviewCiJob, CodeReviewCiPipeline, CodeReviewCiRedStreak } from "@maple/domain/http"
import { failRate } from "../../../components/code-review/ci/ci-format"
import { formatCount, formatSpan } from "../../../components/code-review/code-review-format"
import { EMPTY_VALUE, formatDuration, formatPercent } from "@maple/ui/lib/format"
import { TONE_SOFT, TONE_TEXT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { ROW_LANE } from "@maple/ui/styles/ui/list-row"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { badge } from "../../../ui/display"
import { emptyMessage } from "../../../ui/empty"
import { panel, panelHeader } from "../../../ui/panel"
import { table, tableBody, tableCell, tableHead, tableHeader, tableRow } from "../../../ui/table"
import { truncatedId } from "../../../ui/truncated-id"
import { ciResultBadge, traceKept } from "../kit/parts"
import { relativeTime } from "../../kit/relative-time"
import { Message } from "./model"

// `WorkflowsTable`, `RedStreakLine` and `JobsTable`.

type H = HtmlBuilder<Message>
type TimeContext = Readonly<{ nowMs: number; timeZone: string }>

const rateOf = (rate: number | null) => (rate === null ? EMPTY_VALUE : formatPercent(rate))
const ciTimeOf = (ms: number) => formatSpan(ms / 1000)

/** `owner/name`, as GitHub writes it; a repository without an owner is just its name. */
const repositoryLabel = (row: { readonly owner: string; readonly repository: string }) =>
	row.owner === "" ? row.repository : `${row.owner}/${row.repository}`

const rateClass = (rate: number | null) =>
	cn("px-3 text-right tabular-nums", rate !== null && rate > 0 ? TONE_TEXT.crit : "text-muted-foreground")

const head = (h: H, cells: ReadonlyArray<readonly [string, string, string?]>) =>
	tableHeader(
		h,
		[
			tableRow(
				h,
				cells.map(([label, className, title]) =>
					tableHead(h, [label], className, title === undefined ? [] : [h.Title(title)]),
				),
			),
		],
		{ className: "bg-surface-sunken" },
	)

/** Where the streak began and the commit that last passed. */
const redStreakLine = (h: H, red: CodeReviewCiRedStreak, time: TimeContext): Html => {
	const traceHref = hrefOf(
		AppRoute.Trace({ traceId: red.firstFailedTraceId, search: { t: new Date(red.since).toISOString() } }),
	)
	return h.div(
		[h.Class("mt-1 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground")],
		[
			h.span([], ["First failed at"]),
			// The commit alone once the run's trace has expired.
			traceKept(red.since, time.nowMs)
				? h.a(
						[
							h.Class("text-foreground underline-offset-4 hover:underline active:underline"),
							h.Href(traceHref),
							h.Title("Open the first failed run's trace"),
							// `event.stopPropagation()` keeps the row's click off; the page follows the link itself.
							h.OnClick(Message.ClickedTraceLink({ url: traceHref }), {
								defaultAction: "Prevent",
								propagation: "Stop",
							}),
						],
						[truncatedId(h, { value: red.firstFailedRevision, kind: "sha" })],
					)
				: h.span(
						[h.Class("text-foreground")],
						[truncatedId(h, { value: red.firstFailedRevision, kind: "sha" })],
					),
			relativeTime(h, { tooltip: "title", value: red.since, variant: "short", ...time }),
			h.span([h.AriaHidden(true)], ["·"]),
			red.lastGreenRevision === null
				? h.span([], ["no green run in this window"])
				: h.span(
						[],
						[
							"last green",
							" ",
							truncatedId(h, {
								value: red.lastGreenRevision,
								kind: "sha",
								className: "text-foreground",
							}),
						],
					),
		],
	)
}

const workflowRow = (
	h: H,
	row: CodeReviewCiPipeline,
	selected: string | undefined,
	time: TimeContext,
): Html => {
	const isActive = selected === row.pipeline
	const rate = failRate(row.failed, row.runs)
	const select = Message.ClickedWorkflow({ pipeline: row.pipeline })
	return tableRow(
		h,
		[
			tableCell(
				h,
				[
					h.button(
						[
							h.Type("button"),
							h.AriaPressed(String(isActive)),
							h.OnClick(select, { propagation: "Stop" }),
							h.Class(
								"flex w-full min-w-0 items-center gap-2 text-left focus-visible:underline focus-visible:outline-none",
							),
						],
						[
							h.span([h.Class("truncate font-medium"), h.Title(row.pipeline)], [row.pipeline]),
							...(row.red
								? [
										badge(h, { size: "sm", className: cn("shrink-0", TONE_SOFT.crit) }, [
											"Failing · ",
											formatCount(row.red.failedRuns),
											" ",
											row.red.failedRuns === 1 ? "run" : "runs",
										]),
									]
								: []),
						],
					),
					h.div(
						[
							h.Class("mt-0.5 truncate text-xs text-muted-foreground"),
							h.Title(repositoryLabel(row)),
						],
						[repositoryLabel(row)],
					),
					...(row.red ? [redStreakLine(h, row.red, time)] : []),
				],
				cn(
					"px-4 py-2.5 leading-normal",
					ROW_LANE,
					isActive ? "before:bg-primary" : "before:bg-transparent",
				),
			),
			tableCell(h, [formatCount(row.runs)], "px-3 text-right tabular-nums"),
			tableCell(h, [rateOf(rate)], rateClass(rate)),
			tableCell(
				h,
				[formatDuration(row.p50DurationMs)],
				"hidden px-3 text-right tabular-nums lg:table-cell",
			),
			tableCell(
				h,
				[formatDuration(row.p95DurationMs)],
				"hidden px-3 text-right tabular-nums lg:table-cell",
			),
			tableCell(
				h,
				[ciTimeOf(row.totalDurationMs)],
				"hidden px-3 text-right tabular-nums md:table-cell",
			),
			tableCell(
				h,
				[
					h.span(
						[h.Class("flex items-center gap-2")],
						[
							ciResultBadge(h, row.lastResult),
							relativeTime(h, {
								tooltip: "title",
								value: row.lastStartedAt,
								variant: "short",
								className: "text-xs text-muted-foreground",
								...time,
							}),
						],
					),
				],
				"hidden px-4 sm:table-cell",
			),
		],
		cn("cursor-pointer hover:bg-surface-sunken active:bg-surface-sunken", isActive && "bg-surface-strong"),
		[h.Key(`${row.owner}/${row.repository}/${row.pipeline}`), h.OnClick(select)],
	)
}

export const workflowsTable = (
	h: H,
	pipelines: ReadonlyArray<CodeReviewCiPipeline>,
	selected: string | undefined,
	time: TimeContext,
): Html =>
	panel(h, {}, [
		panelHeader(h, { title: "Workflows" }),
		pipelines.length === 0
			? emptyMessage(h, { className: "px-4 py-6" }, ["No workflows ran in this window"])
			: table(h, { size: "sm", className: "table-fixed" }, [
					head(h, [
						["Workflow", "px-4 font-normal"],
						["Runs", "w-20 px-3 text-right font-normal"],
						["Fail rate", "w-24 px-3 text-right font-normal"],
						["p50", "hidden px-3 text-right font-normal lg:table-cell lg:w-24"],
						["p95", "hidden px-3 text-right font-normal lg:table-cell lg:w-24"],
						["CI time", "hidden px-3 text-right font-normal md:table-cell md:w-24"],
						["Last run", "hidden px-4 font-normal sm:table-cell sm:w-44"],
					]),
					tableBody(
						h,
						pipelines.map((row) => workflowRow(h, row, selected, time)),
					),
				]),
	])

const WAIT_TITLE = "How long the job waited for a runner"

const jobRow = (h: H, row: CodeReviewCiJob): Html => {
	const rate = failRate(row.failed, row.runs)
	return tableRow(
		h,
		[
			tableCell(
				h,
				[
					h.div([h.Class("truncate font-medium"), h.Title(row.job)], [row.job]),
					h.div(
						[
							h.Class("mt-0.5 truncate text-xs text-muted-foreground"),
							h.Title(`${repositoryLabel(row)} · ${row.pipeline}`),
						],
						[row.pipeline, " · ", repositoryLabel(row)],
					),
				],
				"px-4 py-2.5 leading-normal",
			),
			tableCell(h, [formatCount(row.runs)], "px-3 text-right tabular-nums"),
			tableCell(h, [rateOf(rate)], rateClass(rate)),
			tableCell(
				h,
				[formatCount(row.retried)],
				"hidden px-3 text-right tabular-nums text-muted-foreground md:table-cell",
			),
			tableCell(
				h,
				[formatDuration(row.p50DurationMs)],
				"hidden px-3 text-right tabular-nums lg:table-cell",
			),
			tableCell(
				h,
				[formatDuration(row.p95DurationMs)],
				"hidden px-3 text-right tabular-nums lg:table-cell",
			),
			tableCell(
				h,
				[formatDuration(row.p50QueueMs)],
				"hidden px-3 text-right tabular-nums text-muted-foreground xl:table-cell",
			),
			tableCell(
				h,
				[formatDuration(row.p95QueueMs)],
				"hidden px-4 text-right tabular-nums text-muted-foreground xl:table-cell",
			),
		],
		undefined,
		[h.Key(`${row.owner}/${row.repository}/${row.pipeline}/${row.job}`)],
	)
}

export const jobsTable = (h: H, jobs: ReadonlyArray<CodeReviewCiJob>): Html =>
	panel(h, {}, [
		panelHeader(h, { title: "Jobs by CI time" }),
		jobs.length === 0
			? emptyMessage(h, { className: "px-4 py-6" }, ["No jobs ran in this window"])
			: table(h, { size: "sm", className: "table-fixed" }, [
					head(h, [
						["Job", "px-4 font-normal"],
						["Runs", "w-20 px-3 text-right font-normal"],
						["Fail rate", "w-24 px-3 text-right font-normal"],
						["Retried", "hidden px-3 text-right font-normal md:table-cell md:w-20"],
						["p50", "hidden px-3 text-right font-normal lg:table-cell lg:w-24"],
						["p95", "hidden px-3 text-right font-normal lg:table-cell lg:w-24"],
						["Wait p50", "hidden px-3 text-right font-normal xl:table-cell xl:w-24", WAIT_TITLE],
						["Wait p95", "hidden px-4 text-right font-normal xl:table-cell xl:w-24", WAIT_TITLE],
					]),
					tableBody(
						h,
						jobs.map((row) => jobRow(h, row)),
					),
				]),
	])
