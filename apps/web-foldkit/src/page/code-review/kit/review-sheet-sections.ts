import {
	type CodeReviewDetail,
	type CodeReviewFinding,
	PR_REVIEW_MODELS,
	type PrReviewFinding,
	type PrReviewMergeStep,
} from "@maple/domain/http"
import {
	CATEGORY_LABELS,
	FINDING_STATUS_LABELS,
	formatCount,
	formatSpan,
	outcomeOf,
	SEVERITY_LABELS,
	SEVERITY_TONE,
	SKIP_LABELS,
} from "../../../components/code-review/code-review-format"
import { EMPTY_VALUE } from "@maple/ui/lib/format"
import { formatRelativeFrom } from "@maple/ui/lib/time-format"
import { TONE_TEXT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { alert, alertDescription } from "../../../ui/alert"
import { badge } from "../../../ui/display"
import { icon } from "../../../ui/icon"
import { panel } from "../../../ui/panel"
import { statRail, statRailItem } from "../../kit/stat-rail"
import { messageResponse } from "./markdown"
import { bulletList, section } from "./parts"
import type { ReviewSheet, SheetMessage } from "./review-sheet"
import { ciRunsSection, historySection, postMergeSection, productionSection } from "./review-sheet-more"

// `ReviewDetailContent`'s body.

type H = HtmlBuilder<SheetMessage>

const modelLabel = (model: string | null) =>
	model === null ? EMPTY_VALUE : (PR_REVIEW_MODELS.find((entry) => entry.id === model)?.label ?? model)

/** A dense StatRail tile: sheet-sized value that truncates instead of overflowing. */
const stat = (h: H, label: string, value: string, tone?: string): Html =>
	statRailItem(h, {
		compact: true,
		eyebrow: label,
		value,
		className: "min-w-0 px-3 py-2.5",
		valueClassName: cn("min-w-0 shrink truncate text-sm font-medium", tone),
	})

const stats = (h: H, detail: CodeReviewDetail, nowMs: number): Html => {
	const { review } = detail
	const outcome = outcomeOf(review)
	const durationSeconds =
		review.finishedAt === null
			? null
			: (review.finishedAt - (detail.startedAt ?? review.createdAt)) / 1000
	return statRail(h, {}, [
		stat(h, "Outcome", outcome.label, outcome.tone),
		stat(h, "Confidence", review.confidence === null ? EMPTY_VALUE : `${review.confidence}/10`),
		stat(h, "Quality", review.score === null ? EMPTY_VALUE : `${review.score}/100`),
		stat(h, "Issues", formatCount(review.findings)),
		stat(h, "Duration", formatSpan(durationSeconds)),
		stat(h, "Model", modelLabel(review.model)),
		stat(h, "Tokens", formatCount((detail.inputTokens ?? 0) + (detail.outputTokens ?? 0))),
		stat(h, "Reviewed", formatRelativeFrom(review.createdAt, nowMs)),
	])
}

const findingCard = (h: H, finding: PrReviewFinding, tracked: CodeReviewFinding | undefined): Html =>
	h.li(
		[],
		[
			panel(h, { padded: "sm", className: "gap-2" }, [
				h.div(
					[h.Class("flex flex-wrap items-center gap-x-2 gap-y-1 text-xs")],
					[
						h.span(
							[h.Class(cn("font-medium", TONE_TEXT[SEVERITY_TONE[finding.severity]]))],
							[SEVERITY_LABELS[finding.severity]],
						),
						h.span([h.Class("text-muted-foreground")], [CATEGORY_LABELS[finding.category]]),
						...(finding.handle
							? [h.span([h.Class("font-mono text-muted-foreground")], [finding.handle])]
							: []),
						...(tracked === undefined
							? []
							: [
									badge(h, { variant: "outline", size: "sm", className: "ml-auto" }, [
										FINDING_STATUS_LABELS[tracked.status],
									]),
								]),
					],
				),
				h.p([h.Class("text-sm font-medium")], [finding.title]),
				h.p(
					[h.Class("font-mono text-xs break-all text-muted-foreground")],
					[
						finding.path,
						":",
						String(finding.line),
						...(finding.endLine && finding.endLine !== finding.line
							? [`-${finding.endLine}`]
							: []),
					],
				),
				messageResponse(h, finding.body, "text-sm text-muted-foreground"),
			]),
		],
	)

/** The "Before merge" steps, ticked ones struck through with who ticked them. */
const mergeSteps = (h: H, steps: ReadonlyArray<PrReviewMergeStep>): Html =>
	h.ul(
		[h.Class("flex flex-col gap-1.5 text-sm")],
		steps.map((step) => {
			const isDone = step.done === true
			return h.li(
				[h.Class("flex items-start gap-2")],
				[
					h.span(
						[
							h.AriaLabel(isDone ? "Done" : "Open"),
							h.Class(
								isDone
									? "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-sm bg-primary text-primary-foreground"
									: "mt-0.5 size-4 shrink-0 rounded-sm border border-border",
							),
						],
						isDone ? [icon(h, "CheckIcon", { size: 12 })] : [],
					),
					h.span(
						[h.Class(isDone ? "text-muted-foreground line-through" : "text-foreground")],
						[
							step.path === undefined || step.subject !== step.path
								? step.title
								: `${step.title} (${step.path})`,
							...(isDone && step.doneBy !== undefined
								? [h.span([h.Class("ml-1.5 text-xs no-underline")], [`@${step.doneBy}`])]
								: []),
						],
					),
				],
			)
		}),
	)

const reportSections = (h: H, detail: CodeReviewDetail, nowMs: number): ReadonlyArray<Html> => {
	const report = detail.report
	if (report === null) return []
	const lifecycle = new Map(detail.findings.map((finding) => [finding.handle, finding]))
	return [
		section(h, "Summary", [
			messageResponse(h, report.summary, "text-sm"),
			...(report.confidenceReason
				? [h.p([h.Class("text-xs text-muted-foreground")], [report.confidenceReason])]
				: []),
		]),
		...(report.keyChanges && report.keyChanges.length > 0
			? [section(h, "Key changes", [bulletList(h, report.keyChanges)])]
			: []),
		...(report.beforeMerge && report.beforeMerge.length > 0
			? [section(h, "Before merge", [mergeSteps(h, report.beforeMerge)])]
			: []),
		section(h, `Issues (${report.findings.length})`, [
			report.findings.length === 0
				? h.p([h.Class("text-sm text-muted-foreground")], ["No issues filed on this head."])
				: h.ul(
						[h.Class("flex flex-col gap-3")],
						report.findings.map((finding) =>
							findingCard(
								h,
								finding,
								finding.handle ? lifecycle.get(finding.handle) : undefined,
							),
						),
					),
		]),
		...(report.telemetry === undefined ? [] : productionSection(h, report.telemetry)),
		...(detail.postMerge ? [postMergeSection(h, detail.postMerge, nowMs)] : []),
		...(report.checked && report.checked.length > 0
			? [section(h, "Checked and ruled out", [bulletList(h, report.checked)])]
			: []),
		...(report.unreviewed && report.unreviewed.length > 0
			? [
					section(h, "Files not reviewed", [
						h.ul(
							[
								h.Class(
									"flex flex-col gap-1 font-mono text-xs break-all text-muted-foreground",
								),
							],
							report.unreviewed.map((path) => h.li([], [path])),
						),
					]),
				]
			: []),
	]
}

export const reviewSections = (
	h: H,
	sheet: ReviewSheet,
	detail: CodeReviewDetail,
	timeZone: string,
): ReadonlyArray<Html> => {
	const { review } = detail
	const problem =
		review.error ?? (review.publishError === null ? null : `Not posted to GitHub: ${review.publishError}`)
	return [
		stats(h, detail, sheet.nowMs),
		...(review.status === "skipped" && review.skipReason !== null
			? [
					h.p(
						[h.Class("text-sm text-muted-foreground")],
						["Skipped: ", SKIP_LABELS[review.skipReason], "."],
					),
				]
			: []),
		...(problem === null
			? []
			: [
					alert(h, { variant: "crit", size: "sm" }, [
						alertDescription(h, [problem], "text-foreground"),
					]),
				]),
		...reportSections(h, detail, sheet.nowMs),
		ciRunsSection(h, sheet),
		...(detail.history.length > 1 ? [historySection(h, sheet, detail, timeZone)] : []),
	]
}
