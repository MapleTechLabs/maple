import type { ErrorIssueVerificationDocument, WorkflowState } from "@maple/domain/http"
import { formatRatePerHour } from "@maple/ui/lib/format"
import { formatRelativeShort } from "@maple/ui/lib/time-format"
import { TONE_SOFT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { DateTime, Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { badge } from "../../../ui/display"
import { icon } from "../../../ui/icon"
import { panel } from "../../../ui/panel"
import { sectionHeading } from "../../kit/section-heading"

// The issue verification card: the post-merge fix check.

type Status = ErrorIssueVerificationDocument["status"]
const IN_FLIGHT_SOFT = "bg-severity-debug/12 text-severity-debug"

const STATUS_TONE = {
	waiting: IN_FLIGHT_SOFT,
	running: IN_FLIGHT_SOFT,
	verified: TONE_SOFT.ok,
	not_fixed: TONE_SOFT.crit,
	inconclusive: TONE_SOFT.warn,
	abandoned: TONE_SOFT.neutral,
} satisfies Record<Status, string>

const STATUS_LABEL = {
	waiting: "Watching",
	running: "Checking",
	verified: "Fix holds",
	not_fixed: "Still broken",
	inconclusive: "Inconclusive",
	abandoned: "Stopped",
} satisfies Record<Status, string>

const isoMs = (iso: string): number =>
	Option.getOrElse(Option.map(DateTime.make(iso), DateTime.toEpochMillis), () => Number.NaN)

const headline = (verification: ErrorIssueVerificationDocument, nowMs: number): string => {
	switch (verification.status) {
		case "waiting": {
			const rate =
				verification.baselineRatePerHour > 0
					? ` It was firing about ${formatRatePerHour(verification.baselineRatePerHour)} before the merge.`
					: " It fires too rarely to judge quickly, so this takes a while."
			if (isoMs(verification.verifyAfter) <= nowMs)
				return `The verification window has closed; the next check records the result.${rate}`
			return `Watching for another ${formatRelativeShort(verification.verifyAfter, nowMs)} to see whether this error comes back.${rate}`
		}
		case "running":
			return "An agent is checking whether the merged fix actually resolved this."
		case "verified":
			return "No occurrences from builds that postdate the merge. The fix holds."
		case "not_fixed":
			return `This error fired ${verification.postMergeOccurrenceCount} more time(s) from builds that postdate the merge, so the fix did not resolve it.`
		case "inconclusive":
			return "There was not enough traffic after the merge to say either way."
		case "abandoned":
			return "This check stopped before reaching an answer."
	}
}

const note = <M>(h: HtmlBuilder<M>, className: string, text: string): Html =>
	h.p([h.Class(className)], [text])

export const verificationCard = <M>(
	h: HtmlBuilder<M>,
	verification: ErrorIssueVerificationDocument,
	workflowState: WorkflowState,
	nowMs: number,
): Html => {
	const isAwaitingClose =
		verification.status === "verified" && workflowState !== "done" && workflowState !== "cancelled"
	const isSettled =
		verification.status === "verified" ||
		verification.status === "not_fixed" ||
		verification.status === "inconclusive"
	return panel(h, { className: "px-4 py-3" }, [
		h.div(
			[h.Class("flex items-center justify-between gap-2")],
			[
				h.div(
					[h.Class("flex items-center gap-2")],
					[
						icon(h, "MagnifierCheckIcon", { className: "size-4 text-muted-foreground" }),
						sectionHeading(h, { title: "Fix verification" }),
					],
				),
				badge(
					h,
					{ variant: "outline", className: cn("shrink-0", STATUS_TONE[verification.status]) },
					[STATUS_LABEL[verification.status]],
				),
			],
		),
		note(h, "mt-2 text-xs leading-relaxed text-muted-foreground", headline(verification, nowMs)),
		...(isAwaitingClose
			? [
					note(
						h,
						"mt-2 text-xs leading-relaxed text-foreground",
						"Maple leaves high and critical issues for a human to close. This one stays open until you do.",
					),
				]
			: []),
		...(verification.verdictNote && isSettled
			? [
					note(
						h,
						"mt-2 border-l-2 border-border pl-3 text-xs leading-relaxed text-muted-foreground",
						verification.verdictNote,
					),
				]
			: []),
		...(verification.status === "verified" && verification.baselineVersions.length > 0
			? [
					note(
						h,
						"mt-2 text-xs text-muted-foreground/80",
						"Occurrences from builds that predate the merge were ignored. Those are older clients still running the broken version.",
					),
				]
			: []),
		...(verification.investigationId
			? [
					h.a(
						[
							h.Href(
								hrefOf(
									AppRoute.Investigation({ id: verification.investigationId, search: {} }),
								),
							),
							h.Class("mt-2 inline-block text-xs text-primary hover:underline"),
						],
						["View the verification run"],
					),
				]
			: []),
		...(verification.attempt > 0 && verification.status === "waiting"
			? [
					note(
						h,
						"mt-2 text-xs text-muted-foreground/80",
						"First check was inconclusive; watching for longer.",
					),
				]
			: []),
	])
}
