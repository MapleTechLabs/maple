import type { CodeReviewListItem, CodeReviewSortDir, CodeReviewSortKey } from "@maple/domain/http"
import { outcomeOf, SKIP_LABELS } from "../../../components/code-review/code-review-format"
import { EMPTY_VALUE, formatNumber } from "@maple/ui/lib/format"
import { TONE_SOFT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { badge } from "@maple/views/ui/display"
import { icon, type IconName } from "@maple/views/ui/icon"
import { panel } from "@maple/views/ui/panel"
import { pressable } from "@maple/views/ui/pressable"
import { spinner } from "@maple/views/ui/spinner"
import {
	ariaSort,
	clickableRowClass,
	laneTableCell,
	sortButton,
	table,
	tableBody,
	tableCell,
	tableHead,
	tableHeader,
	tableRow,
} from "@maple/views/ui/table"
import { emptyValue } from "@maple/views/ui/values"
import { authorLabel } from "../kit/author"
import { listRelativeTime } from "../../kit/relative-time"
import { Message } from "./model"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { hstack, hstackClass } from "@maple/views/ui/stack"
import { Array as Arr } from "effect"

// `ReviewTable`: the pull requests and their reviews.

type H = HtmlBuilder<Message>

const OUTCOME_ICONS = {
	queued: "ClockIcon",
	running: "LoaderIcon",
	failed: "CircleWarningIcon",
	skipped: "ClockIcon",
	issues: "CircleWarningIcon",
	clean: "CircleCheckIcon",
	neutral: "CircleCheckIcon",
} as const satisfies Record<string, IconName>

const scoreCell = (h: H, value: number | null, out: string): ReadonlyArray<Html | string> =>
	value === null ? [emptyValue(h)] : [String(value), h.span([h.Class("text-muted-foreground")], [out])]

export type RowContext = Readonly<{ selected: string | undefined; nowMs: number; timeZone: string }>

const reviewRow = (h: H, review: CodeReviewListItem, context: RowContext): Html => {
	const outcome = outcomeOf(review)
	const isSelected = context.selected === review.id
	const open = Message.ClickedReview({ reviewId: review.id })
	return tableRow(
		h,
		[
			laneTableCell(
				h,
				isSelected,
				[
					pressable(
						h,
						{
							className:
								"flex w-full min-w-0 items-center gap-1.5 text-left focus-visible:ring-0 focus-visible:underline",
							attributes: [h.OnClick(open, { propagation: "Stop" })],
						},
						[
							h.span([h.Class("shrink-0 text-muted-foreground")], ["#", String(review.number)]),
							typography(
								h,
								{
									weight: "medium",
									truncate: true,
									attributes: [h.Title(review.title ?? "Untitled pull request")],
								},
								[review.title ?? "Untitled pull request"],
							),
						],
					),
					h.div(
						[h.Class("mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground")],
						[
							h.span(
								[h.Class("min-w-0 truncate"), h.Title(review.repositoryFullName)],
								[review.repositoryFullName],
							),
							...(review.authorLogin
								? [
										h.span([h.Class("shrink-0")], ["·"]),
										authorLabel(h, review.authorLogin, "max-w-[40%] min-w-0"),
									]
								: []),
							h.span([h.Class(cn("shrink-0 md:hidden", outcome.tone))], ["· ", outcome.label]),
						],
					),
				],
				"px-4 py-2.5 leading-normal",
			),
			tableCell(
				h,
				[
					h.span(
						[h.Class(cn(hstackClass({ gap: "1.5", inline: true }), outcome.tone))],
						[
							outcome.kind === "running"
								? spinner(h, undefined, 14)
								: icon(h, OUTCOME_ICONS[outcome.kind], { size: 14 }),
							outcome.label,
						],
					),
					...(review.status === "skipped" && review.skipReason !== null
						? [
								typography(h, { size: "xs", tone: "muted", as: "div" }, [
									SKIP_LABELS[review.skipReason],
								]),
							]
						: []),
				],
				"hidden px-3 py-2.5 leading-normal md:table-cell",
			),
			tableCell(
				h,
				scoreCell(h, review.confidence, "/10"),
				"hidden px-3 text-right tabular-nums lg:table-cell",
			),
			tableCell(
				h,
				scoreCell(h, review.score, "/100"),
				"hidden px-3 text-right tabular-nums lg:table-cell",
			),
			tableCell(
				h,
				[
					review.status !== "completed"
						? h.span([h.Class("text-muted-foreground")], [EMPTY_VALUE])
						: hstack(h, { gap: "1.5", inline: true, as: "span" }, [
								...(review.criticalFindings > 0
									? [
											badge(
												h,
												{
													size: "xs",
													mono: true,
													className: TONE_SOFT.crit,
													attributes: [h.Title("Critical")],
												},
												[String(review.criticalFindings)],
											),
										]
									: []),
								formatNumber(review.findings),
							]),
				],
				typographyClass({ numeric: true, className: "px-3 text-right" }),
			),
			tableCell(
				h,
				[
					listRelativeTime(h, {
						value: review.createdAt,
						nowMs: context.nowMs,
						timeZone: context.timeZone,
					}),
				],
				"hidden px-4 text-right text-muted-foreground tabular-nums sm:table-cell",
			),
		],
		clickableRowClass(isSelected),
		[h.Key(review.id), h.OnClick(open)],
	)
}

export type Sort = Readonly<{ sortBy: CodeReviewSortKey; sortDir: CodeReviewSortDir }>

/** A header that sorts the list. */
const sortableHead = (h: H, label: string, key: CodeReviewSortKey, sort: Sort, className: string): Html => {
	const isActive = sort.sortBy === key
	return tableHead(
		h,
		[
			sortButton(
				h,
				{ isActive, direction: sort.sortDir, onClick: Message.ClickedSort({ key }), align: "right" },
				[label],
			),
		],
		className,
		ariaSort(h, isActive, sort.sortDir),
	)
}

export const reviewTable = (
	h: H,
	reviews: ReadonlyArray<CodeReviewListItem>,
	sort: Sort,
	context: RowContext,
): Html =>
	panel(h, {}, [
		table(h, { size: "sm", className: "table-fixed" }, [
			tableHeader(
				h,
				[
					tableRow(h, [
						tableHead(h, ["Pull request"], "px-4 font-normal"),
						tableHead(h, ["Outcome"], "hidden w-40 px-3 font-normal md:table-cell"),
						sortableHead(
							h,
							"Confidence",
							"confidence",
							sort,
							"hidden w-28 px-3 text-right font-normal lg:table-cell",
						),
						sortableHead(
							h,
							"Quality",
							"quality",
							sort,
							"hidden w-24 px-3 text-right font-normal lg:table-cell",
						),
						sortableHead(h, "Issues", "issues", sort, "w-24 px-3 text-right font-normal"),
						sortableHead(
							h,
							"Reviewed",
							"reviewed",
							sort,
							"hidden w-28 px-4 text-right font-normal sm:table-cell",
						),
					]),
				],
				{ className: "bg-surface-sunken" },
			),
			tableBody(
				h,
				Arr.map(reviews, (review) => reviewRow(h, review, context)),
			),
		]),
	])
