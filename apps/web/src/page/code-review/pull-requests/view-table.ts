import type { CodeReviewListItem } from "@maple/domain/http"
import { formatCount, outcomeOf, SKIP_LABELS } from "../../../components/code-review/code-review-format"
import { EMPTY_VALUE } from "@maple/ui/lib/format"
import { TONE_SOFT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { ROW_LANE } from "@maple/ui/styles/ui/list-row"
import { spinnerStyles } from "@maple/ui/styles/ui/spinner"
import type { Html, HtmlBuilder } from "foldkit/html"
import { badge } from "../../../ui/display"
import { icon, type IconName } from "../../../ui/icon"
import { panel } from "../../../ui/panel"
import { table, tableBody, tableCell, tableHead, tableHeader, tableRow } from "../../../ui/table"
import { authorLabel } from "../kit/author"
import { relativeTime } from "../../kit/relative-time"
import { Message } from "./model"

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
	value === null
		? [h.span([h.Class("text-muted-foreground")], [EMPTY_VALUE])]
		: [String(value), h.span([h.Class("text-muted-foreground")], [out])]

export type RowContext = Readonly<{ selected: string | undefined; nowMs: number; timeZone: string }>

const reviewRow = (h: H, review: CodeReviewListItem, context: RowContext): Html => {
	const outcome = outcomeOf(review)
	const isSelected = context.selected === review.id
	const open = Message.ClickedReview({ reviewId: review.id })
	return tableRow(
		h,
		[
			tableCell(
				h,
				[
					h.button(
						[
							h.Type("button"),
							h.OnClick(open, { propagation: "Stop" }),
							h.Class(
								"flex w-full min-w-0 items-center gap-1.5 text-left focus-visible:outline-none focus-visible:underline",
							),
						],
						[
							h.span([h.Class("shrink-0 text-muted-foreground")], ["#", String(review.number)]),
							h.span(
								[
									h.Class("truncate font-medium"),
									h.Title(review.title ?? "Untitled pull request"),
								],
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
				cn(
					"px-4 py-2.5 leading-normal",
					ROW_LANE,
					isSelected ? "before:bg-primary" : "before:bg-transparent",
				),
			),
			tableCell(
				h,
				[
					h.span(
						[h.Class(cn("inline-flex items-center gap-1.5", outcome.tone))],
						[
							outcome.kind === "running"
								? icon(h, "LoaderIcon", {
										size: 14,
										className: spinnerStyles,
										attributes: [h.AriaLabel("Loading"), h.Role("status")],
									})
								: icon(h, OUTCOME_ICONS[outcome.kind], { size: 14 }),
							outcome.label,
						],
					),
					...(review.status === "skipped" && review.skipReason !== null
						? [
								h.div(
									[h.Class("text-xs text-muted-foreground")],
									[SKIP_LABELS[review.skipReason]],
								),
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
						: h.span(
								[h.Class("inline-flex items-center gap-1.5")],
								[
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
									formatCount(review.findings),
								],
							),
				],
				"px-3 text-right tabular-nums",
			),
			tableCell(
				h,
				[
					relativeTime(h, {
						tooltip: "title",
						value: review.createdAt,
						nowMs: context.nowMs,
						timeZone: context.timeZone,
					}),
				],
				"hidden px-4 text-right text-muted-foreground tabular-nums sm:table-cell",
			),
		],
		cn("cursor-pointer transition-colors hover:bg-muted/50", isSelected && "bg-muted/60"),
		[h.Key(review.id), h.OnClick(open)],
	)
}

export const reviewTable = (h: H, reviews: ReadonlyArray<CodeReviewListItem>, context: RowContext): Html =>
	panel(h, {}, [
		table(h, { size: "sm", className: "table-fixed" }, [
			tableHeader(
				h,
				[
					tableRow(h, [
						tableHead(h, ["Pull request"], "px-4 font-normal"),
						tableHead(h, ["Outcome"], "hidden w-40 px-3 font-normal md:table-cell"),
						tableHead(h, ["Confidence"], "hidden w-28 px-3 text-right font-normal lg:table-cell"),
						tableHead(h, ["Quality"], "hidden w-24 px-3 text-right font-normal lg:table-cell"),
						tableHead(h, ["Issues"], "w-24 px-3 text-right font-normal"),
						tableHead(h, ["Reviewed"], "hidden w-28 px-4 text-right font-normal sm:table-cell"),
					]),
				],
				{ className: "bg-muted/30" },
			),
			tableBody(
				h,
				reviews.map((review) => reviewRow(h, review, context)),
			),
		]),
	])
