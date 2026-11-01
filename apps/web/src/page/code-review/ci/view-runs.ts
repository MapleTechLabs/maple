import type { CodeReviewCiRun } from "@maple/domain/http"
import { externalUrl, pullRequestUrl } from "../../../components/code-review/ci/ci-format"
import { formatDuration } from "@maple/ui/lib/format"
import { TONE_TEXT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { linkButton } from "../../../ui/button"
import { textLink } from "../../../ui/text-link"
import { errorState } from "../../../ui/error-state"
import { icon } from "../../../ui/icon"
import { listFooter, loadingMoreRow } from "../../../ui/list-footer"
import { panel } from "../../../ui/panel"
import { runsTableSkeleton } from "../kit/skeletons"
import { table, tableBody, tableCell, tableHead, tableHeader, tableRow } from "../../../ui/table"
import { truncatedId } from "../../../ui/truncated-id"
import { nothingInWindow } from "../../kit/nothing-in-window"
import { ciResultBadge, traceLink } from "../kit/parts"
import { listRelativeTime } from "../../kit/relative-time"
import { Message, type Model } from "./model"

// `CiRunsList`, `RunRows` and the paging footers.

type H = HtmlBuilder<Message>
type TimeContext = Readonly<{ nowMs: number; timeZone: string }>

/** Failed jobs listed under a run before the rest fold into "+N more". */
const FAILED_JOBS_SHOWN = 3

const dot = (h: H) => h.span([h.AriaHidden(true)], ["·"])

const runMeta = (h: H, run: CodeReviewCiRun, prUrl: string | null): Html =>
	h.div(
		[h.Class("mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground")],
		[
			h.span([h.Class("max-w-full truncate"), h.Title(run.repository)], [run.repository]),
			...(run.branch
				? [
						dot(h),
						textLink(
							h,
							{
								tone: "muted",
								isMono: true,
								className: "block max-w-48 truncate",
								onClick: Message.ClickedBranch({ branch: run.branch }),
								attributes: [h.Title(`Show runs on ${run.branch}`)],
							},
							[run.branch],
						),
					]
				: []),
			...(run.revision ? [dot(h), truncatedId(h, { value: run.revision, kind: "sha" })] : []),
			...(run.pullRequest === null
				? []
				: [
						dot(h),
						prUrl === null
							? h.span([], ["#", String(run.pullRequest)])
							: textLink(
									h,
									{
										tone: "muted",
										href: prUrl,
										attributes: [
											h.Attribute("target", "_blank"),
											h.Attribute("rel", "noreferrer"),
										],
									},
									["#", String(run.pullRequest)],
								),
					]),
			...(run.actor ? [dot(h), h.span([h.Class("truncate")], [run.actor])] : []),
			h.span([h.Class("sm:hidden")], ["· ", formatDuration(run.durationMs)]),
		],
	)

const failedJobs = (h: H, run: CodeReviewCiRun): ReadonlyArray<Html> => {
	const failed = run.failedJobs.slice(0, FAILED_JOBS_SHOWN)
	const hidden = run.failedJobs.length - failed.length
	if (failed.length === 0) return []
	return [
		h.ul(
			[h.Class("mt-1 flex flex-col gap-0.5 text-xs")],
			[
				...failed.map((job) => {
					const jobUrl = externalUrl(job.url)
					return h.li(
						[h.Key(job.job), h.Class("flex min-w-0 gap-1.5")],
						[
							jobUrl === null
								? h.span([h.Class(cn("shrink-0 font-medium", TONE_TEXT.crit))], [job.job])
								: h.a(
										[
											h.Href(jobUrl),
											h.Attribute("target", "_blank"),
											h.Attribute("rel", "noreferrer"),
											h.Class(
												cn(
													"shrink-0 font-medium hover:underline active:underline",
													TONE_TEXT.crit,
												),
											),
										],
										[job.job],
									),
							...(job.reason
								? [
										h.span(
											[h.Class("truncate text-muted-foreground"), h.Title(job.reason)],
											[job.reason],
										),
									]
								: []),
						],
					)
				}),
				...(hidden > 0
					? [h.li([h.Class("text-muted-foreground")], ["+", String(hidden), " more failed"])]
					: []),
			],
		),
	]
}

const runRow = (h: H, run: CodeReviewCiRun, time: TimeContext): Html => {
	const runUrl = externalUrl(run.url)
	const prUrl = run.pullRequest === null || runUrl === null ? null : pullRequestUrl(runUrl, run.pullRequest)
	return tableRow(
		h,
		[
			tableCell(
				h,
				[ciResultBadge(h, run.result, run.attempt, "flex-wrap")],
				"px-3 py-2.5 align-top leading-normal sm:px-4",
			),
			tableCell(
				h,
				[
					h.div([h.Class("truncate font-medium"), h.Title(run.pipeline)], [run.pipeline]),
					runMeta(h, run, prUrl),
					...failedJobs(h, run),
					...traceLink(h, run, time.nowMs, "mt-1 -ml-2 sm:hidden"),
				],
				"px-3 py-2.5 leading-normal",
			),
			tableCell(
				h,
				[h.span([h.Class("leading-normal")], [formatDuration(run.durationMs)])],
				"hidden px-3 text-right align-top tabular-nums sm:table-cell",
			),
			tableCell(
				h,
				[listRelativeTime(h, { value: run.startedAt, ...time })],
				"hidden px-3 text-right align-top text-muted-foreground tabular-nums md:table-cell",
			),
			tableCell(
				h,
				[
					h.span(
						[h.Class("inline-flex items-center justify-end gap-1")],
						[
							...traceLink(h, run, time.nowMs),
							...(runUrl === null
								? []
								: [
										linkButton(
											h,
											{
												variant: "ghost",
												size: "xs",
												href: runUrl,
												attributes: [
													h.Attribute("target", "_blank"),
													h.Attribute("rel", "noreferrer"),
													h.AriaLabel("Open the run on GitHub"),
												],
											},
											["GitHub", icon(h, "ExternalLinkIcon")],
										),
									]),
						],
					),
				],
				"hidden px-4 text-right align-top sm:table-cell",
			),
		],
		undefined,
		[h.Key(run.traceId)],
	)
}

const runsOf = (model: Model, cursor: string): ReadonlyArray<CodeReviewCiRun> =>
	Option.match(
		Option.flatMap(Option.fromNullishOr(model.pages[cursor]), (slot) => AsyncData.getData(slot.data)),
		{
			onNone: () => [],
			onSome: (response) => response.runs,
		},
	)

/** The newest page's state: loading, failed with a retry, or a way to the next one. */
const footer = (h: H, model: Model, firstNext: string | null): Html | null => {
	const last = model.cursors.at(-1)
	const more = (next: string | null) =>
		next === null
			? null
			: listFooter(h, { hasMore: true, onLoadMore: Message.ClickedMoreRuns({ cursor: next }) })
	if (last === undefined) return more(firstNext)
	const slot = model.pages[last]
	if (slot === undefined) return loadingMoreRow(h)
	return AsyncData.matchData(slot.data, {
		onEmpty: () => loadingMoreRow(h),
		onFailure: () =>
			listFooter(h, { isFailed: true, onLoadMore: Message.ClickedRetryPage({ cursor: last }) }),
		onData: (response) => more(response.nextCursor),
	})
}

export const runsList = (h: H, model: Model, time: TimeContext, canClear: boolean): Html =>
	AsyncData.matchData(model.runs.data, {
		onEmpty: () => runsTableSkeleton(h),
		onFailure: (failure) =>
			errorState(h, {
				failure,
				title: "Couldn't load CI runs",
				onRetry: Message.ClickedRetryRuns(),
			}),
		onData: (response) => {
			if (response.runs.length === 0)
				return nothingInWindow(h, {
					title: "No runs match",
					description: "No run in this window has this result or branch.",
					onClear: canClear ? Message.ClickedClearRunFilters() : undefined,
				})
			const rows = [...response.runs, ...model.cursors.flatMap((cursor) => runsOf(model, cursor))]
			const more = footer(h, model, response.nextCursor)
			return panel(h, {}, [
				table(h, { size: "sm", className: "table-fixed" }, [
					tableHeader(
						h,
						[
							tableRow(h, [
								tableHead(h, ["Result"], "w-24 px-3 font-normal sm:w-36 sm:px-4"),
								tableHead(h, ["Run"], "px-3 font-normal"),
								tableHead(
									h,
									["Duration"],
									"hidden px-3 text-right font-normal sm:table-cell sm:w-24",
								),
								tableHead(
									h,
									["Started"],
									"hidden px-3 text-right font-normal md:table-cell md:w-24",
								),
								tableHead(
									h,
									[h.span([h.Class("sr-only")], ["Links"])],
									"hidden px-4 text-right font-normal sm:table-cell sm:w-48",
								),
							]),
						],
						{ className: "bg-surface-sunken" },
					),
					tableBody(
						h,
						rows.map((run) => runRow(h, run, time)),
					),
				]),
				...(more === null ? [] : [more]),
			])
		},
	})
