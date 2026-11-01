import type { CodeReviewDetail, PrReviewPostMerge, PrReviewTelemetry } from "@maple/domain/http"
import { formatCount, outcomeOf } from "../../../components/code-review/code-review-format"
import { countLabel, formatDuration, formatErrorRate } from "@maple/ui/lib/format"
import { formatRelativeFrom } from "@maple/ui/lib/time-format"
import { TONE_TEXT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { DateTime } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { skeleton } from "../../../ui/skeleton"
import { truncatedId } from "../../../ui/truncated-id"
import { relativeTime } from "../../kit/relative-time"
import { bulletList, ciResultBadge, section, traceLink } from "./parts"
import { type ReviewSheet, SheetMessage } from "./review-sheet"
import { CI_RUNS_SHOWN } from "./review-sheet-update"
import { emptyMessage } from "../../../ui/empty"

// `ProductionSection`, `PostMergeSection`, `PullRequestCiRuns` and the review history.

type H = HtmlBuilder<SheetMessage>

/** What production said about the change when it was reviewed. */
export const productionSection = (h: H, telemetry: PrReviewTelemetry): ReadonlyArray<Html> => {
	const breaks = telemetry.contractBreaks
	if (breaks.length === 0 && telemetry.linkedIssues.length === 0 && telemetry.hotFiles.length === 0)
		return []
	return [
		section(h, "Production impact", [
			...(breaks.length === 0
				? []
				: [
						h.ul(
							[h.Class("flex flex-col gap-1.5 text-sm")],
							breaks.map((item) =>
								h.li(
									[...(item.dismissed ? [h.Class("text-muted-foreground")] : [])],
									[
										h.span(
											[
												h.Class(
													cn(
														"font-medium",
														item.dismissed ? undefined : TONE_TEXT.crit,
													),
												),
											],
											[item.dismissed ? "Still emitted elsewhere" : "Stops arriving"],
										),
										" ",
										h.code([h.Class("font-mono text-xs")], [item.name]),
										" · ",
										item.references.map((ref) => `${ref.kind} “${ref.name}”`).join(", "),
									],
								),
							),
						),
					]),
			...(telemetry.linkedIssues.length === 0
				? []
				: [
						bulletList(
							h,
							telemetry.linkedIssues.map(
								(issue) =>
									`Open error in ${issue.path}: ${issue.title} (${formatCount(issue.occurrences)} occurrences)`,
							),
						),
					]),
			...(telemetry.hotFiles.length === 0
				? []
				: [
						bulletList(
							h,
							telemetry.hotFiles
								.slice(0, 5)
								.map(
									(file) =>
										`${file.path}: ${formatCount(file.perDay)} calls/day (${file.operations[0]?.spanName ?? ""})`,
								),
						),
					]),
		]),
	]
}

/** How the operations the change touched behaved the hour before and after it deployed. */
export const postMergeSection = (h: H, postMerge: PrReviewPostMerge, nowMs: number): Html => {
	const regressed = postMerge.verdict === "regressed"
	return section(h, "After it shipped", [
		h.p(
			[h.Class(cn("text-sm", regressed ? TONE_TEXT.warn : "text-muted-foreground"))],
			[
				regressed ? "Something changed after this deployed" : "Shipped clean",
				" · ",
				postMerge.deploy.service,
				" ",
				truncatedId(h, { value: postMerge.deploy.commitSha, kind: "sha", className: "text-xs" }),
				" ",
				formatRelativeFrom(DateTime.toEpochMillis(postMerge.deploy.firstSeen), nowMs),
			],
		),
		bulletList(h, [
			...postMerge.missing.map((name) => `${name} stopped arriving`),
			...postMerge.newIssues.map((issue) => `New error: ${issue.title} (${issue.afterPerHour}/h)`),
			...postMerge.linkedIssues.map(
				(issue) => `${issue.title}: ${issue.beforePerHour}/h → ${issue.afterPerHour}/h`,
			),
			...postMerge.operations
				.filter((operation) => operation.regressed)
				.map(
					(operation) =>
						`${operation.spanName}: errors ${formatErrorRate(operation.before.errorRate)} → ${formatErrorRate(operation.after.errorRate)}, p95 ${operation.before.p95Ms} → ${operation.after.p95Ms} ms`,
				),
		]),
	])
}

const ciSection = (h: H, children: ReadonlyArray<Html>): Html => section(h, "CI runs", children)

/** `PullRequestCiRuns`: the pull request's runs over the last 90 days. */
export const ciRunsSection = (h: H, sheet: ReviewSheet): Html =>
	AsyncData.matchData(sheet.ciRuns.data, {
		onEmpty: () => ciSection(h, [skeleton(h, "h-16 w-full")]),
		onFailure: () =>
			ciSection(h, [h.p([h.Class("text-sm text-muted-foreground")], ["Couldn't load cI runs"])]),
		onData: (response) =>
			response.runs.length === 0
				? ciSection(h, [emptyMessage(h, {}, ["No CI runs in the last 90 days"])])
				: ciSection(h, [
						h.ul(
							[h.Class("-mx-2 flex flex-col")],
							response.runs.map((run) =>
								h.li(
									[
										h.Key(run.traceId),
										h.Class(
											"flex items-center gap-3 rounded-md px-2 py-1 text-sm hover:bg-surface-sunken active:bg-surface-sunken",
										),
									],
									[
										ciResultBadge(h, run.result, run.attempt, "w-32 shrink-0"),
										h.span(
											[h.Class("min-w-0 flex-1 truncate"), h.Title(run.pipeline)],
											[run.pipeline],
										),
										truncatedId(h, {
											value: run.revision,
											kind: "sha",
											className: "text-xs text-muted-foreground",
										}),
										h.span(
											[
												h.Class(
													"w-16 text-right text-xs tabular-nums text-muted-foreground",
												),
											],
											[formatDuration(run.durationMs)],
										),
										...traceLink(h, run, sheet.nowMs, "shrink-0"),
									],
								),
							),
						),
						...(response.nextCursor === null
							? []
							: [
									h.p(
										[h.Class("text-xs text-muted-foreground")],
										[`Latest ${CI_RUNS_SHOWN} runs`],
									),
								]),
					]),
	})

export const historySection = (h: H, sheet: ReviewSheet, detail: CodeReviewDetail, timeZone: string): Html =>
	section(h, "Reviews of this pull request", [
		h.ul(
			[h.Class("-mx-2 flex flex-col")],
			detail.history.map((entry) => {
				const outcome = outcomeOf(entry)
				const isCurrent = entry.id === detail.review.id
				return h.li(
					[h.Key(entry.id)],
					[
						h.button(
							[
								h.Class(
									cn(
										"flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
										isCurrent
											? "bg-muted"
											: "hover:bg-surface-sunken active:bg-surface-sunken",
									),
								),
								...(isCurrent ? [h.Disabled(true)] : []),
								h.Type("button"),
								h.OnClick(SheetMessage.ClickedHistoryEntry({ reviewId: entry.id })),
							],
							[
								truncatedId(h, {
									value: entry.headSha,
									kind: "sha",
									className: "text-xs text-muted-foreground",
								}),
								h.span([h.Class(cn("flex-1", outcome.tone))], [outcome.label]),
								h.span(
									[h.Class("tabular-nums text-muted-foreground")],
									[countLabel(entry.findings, "issue")],
								),
								relativeTime(h, {
									tooltip: "title",
									value: entry.createdAt,
									nowMs: sheet.nowMs,
									timeZone,
									className: "w-20 text-right text-xs text-muted-foreground",
								}),
							],
						),
					],
				)
			}),
		),
	])
