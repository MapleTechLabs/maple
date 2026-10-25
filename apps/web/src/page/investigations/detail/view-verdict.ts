import type { V2Investigation } from "@maple/domain/http/v2"
import { countLabel, EMPTY_VALUE } from "@maple/ui/lib/format"
import { toEpochMs } from "@maple/ui/lib/time-format"
import { TONE_FILL, TONE_TEXT, type Tone } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { reportHeadline, splitDuration } from "@maple/web-data/investigations/display"
import type { Html, HtmlBuilder } from "foldkit/html"
import { badge } from "../../../ui/display"
import { eyebrow } from "../../../ui/eyebrow"
import { icon } from "../../../ui/icon"
import { statFigure } from "../../../ui/stat-figure"
import { statusDot } from "../../../ui/status-dot"
import { confidenceMeter } from "../kit"
import { elapsedBetween } from "./derive"

// `VerdictCard` and `RunProgress`: the verdict and the run's progress.

type Children = ReadonlyArray<Html | string>

const HEADING = "font-display text-xl font-semibold leading-7 tracking-tight text-foreground [overflow-wrap:anywhere]"

const SEVERITY_LABEL = { critical: "Critical", high: "High", medium: "Medium", low: "Low" } as const
const SEVERITY_TEXT_TONE = {
	critical: "crit",
	high: "crit",
	medium: "warn",
	low: "neutral",
} as const satisfies Record<keyof typeof SEVERITY_LABEL, Tone>

const shell = <M>(h: HtmlBuilder<M>, accent: string, children: ReadonlyArray<Html | null>, stats: ReadonlyArray<Html>): Html =>
	h.div(
		[h.Class("flex shrink-0 overflow-hidden rounded-r-xl border bg-card max-lg:flex-col max-lg:rounded-b-xl max-lg:rounded-tr-none")],
		[
			h.span([h.AriaHidden(true), h.Class(cn("w-[3px] shrink-0 max-lg:h-[3px] max-lg:w-full", accent))]),
			h.div([h.Class("flex min-w-0 flex-1 flex-col gap-3 px-7 py-6")], children.filter((child): child is Html => child !== null)),
			h.div(
				[h.Class("flex w-53 shrink-0 flex-col border-l max-lg:w-full max-lg:flex-row max-lg:flex-wrap max-lg:border-l-0 max-lg:border-t")],
				stats,
			),
		],
	)

const stat = <M>(h: HtmlBuilder<M>, label: string, children: Children, isLast = false): Html =>
	h.div(
		[
			h.Class(
				cn(
					"flex flex-col gap-2 px-6 py-5.5 max-lg:min-w-40 max-lg:flex-1 max-lg:border-b-0 max-lg:py-4",
					isLast ? null : "border-b max-lg:border-r",
				),
			),
		],
		[eyebrow(h, {}, [label]), h.div([h.Class("text-sm")], children)],
	)

const muted = <M>(h: HtmlBuilder<M>, text: string): Html => h.span([h.Class("text-muted-foreground")], [text])

const bigStat = <M>(h: HtmlBuilder<M>, elapsed: { value: string; unit: string } | null): Html =>
	elapsed === null
		? muted(h, EMPTY_VALUE)
		: statFigure(h, { value: elapsed.value, unit: elapsed.unit, mono: false, valueClassName: "text-foreground" })

const repeatsHeading = (heading: string | null, text: string): boolean =>
	text.trim().length === 0 || text.trim() === heading?.trim()

const body = <M>(h: HtmlBuilder<M>, heading: string | null, text: string): Html | null =>
	repeatsHeading(heading, text) ? null : h.p([h.Class("text-sm leading-6 text-muted-foreground [overflow-wrap:anywhere]")], [text])

const mechanism = <M>(h: HtmlBuilder<M>, heading: string | null, text: string): Html | null =>
	repeatsHeading(heading, text)
		? null
		: h.div(
				[h.Class("mt-1 border-l-2 pl-4")],
				[h.p([h.Class("whitespace-pre-line text-sm leading-6 text-muted-foreground [overflow-wrap:anywhere]")], [text])],
			)

const nextActions = <M>(h: HtmlBuilder<M>, actions: ReadonlyArray<string>): Html | null =>
	actions.length === 0
		? null
		: h.div(
				[h.Class("mt-2 flex flex-col gap-2.5 border-t pt-4")],
				[
					eyebrow(h, {}, ["What to do"]),
					h.ol(
						[h.Class("flex flex-col gap-2")],
						actions.map((action, index) =>
							h.keyed("li")(
								String(index),
								[h.Class("flex gap-3 text-sm leading-6 text-foreground")],
								[
									h.span([h.Class("mt-px shrink-0 text-xs tabular-nums text-muted-foreground")], [String(index + 1)]),
									h.span([h.Class("min-w-0 [overflow-wrap:anywhere]")], [action]),
								],
							),
						),
					),
				],
			)

const diagnosed = <M>(h: HtmlBuilder<M>, investigation: V2Investigation): Html => {
	const report = investigation.report
	if (report === null)
		return shell(
			h,
			"bg-border",
			[
				eyebrow(h, { as: "div" }, ["No diagnosis recorded"]),
				h.p([h.Class("text-sm text-muted-foreground")], ["The pass finished without attaching a report. Run it again to try for a cause."]),
			],
			[stat(h, "Confidence", [confidenceMeter(h, investigation.confidence)], true)],
		)
	const heading = reportHeadline(report)
	const severity = report.severityAssessment
	return shell(
		h,
		"bg-primary",
		[
			eyebrow(h, { as: "div", className: "text-primary" }, ["Suspected cause"]),
			h.h2([h.Class(HEADING)], [heading ?? ""]),
			body(h, heading, report.summary),
			mechanism(h, heading, report.suspectedCause),
			nextActions(h, report.suggestedActions),
		],
		[
			stat(h, "Confidence", [confidenceMeter(h, report.confidence)]),
			stat(h, "AI severity", [
				severity
					? h.span([h.Class(cn("font-medium", TONE_TEXT[SEVERITY_TEXT_TONE[severity]]))], [SEVERITY_LABEL[severity]])
					: muted(h, EMPTY_VALUE),
			]),
			stat(h, "Time to diagnosis", [bigStat(h, elapsedBetween(investigation.created_at, investigation.diagnosed_at))], true),
		],
	)
}

const STALL_MS = 90_000

const silenceLabel = (ms: number): string => {
	const minutes = Math.floor(ms / 60_000)
	return minutes < 1 ? "under a minute" : minutes === 1 ? "a minute" : `${minutes} minutes`
}

/** `RunProgress`: the pass's steps, the last one live; a silent run goes still and says so. */
const runProgress = <M>(h: HtmlBuilder<M>, investigation: V2Investigation, nowMs: number, className: string): Html | null => {
	const progress = investigation.progress
	const isRunning = investigation.status === "investigating"
	const silentFor = progress === null ? 0 : Math.max(0, nowMs - progress.updatedAt)
	const isStalled = isRunning && silentFor > STALL_MS
	const steps = progress?.steps ?? []
	if (steps.length === 0)
		return isRunning
			? h.div(
					[h.Class(cn("flex items-center gap-2.5 text-xs text-muted-foreground", className))],
					[statusDot(h, { tone: "live", size: "sm" }), "Starting the pass"],
				)
			: null
	return h.div(
		[h.Class(cn("flex flex-col gap-2.5", className))],
		[
			eyebrow(h, { as: "div", className: "flex items-baseline gap-2" }, [
				h.span([], [countLabel(progress?.stepCount ?? 0, "step")]),
				...(isStalled
					? [
							h.span([h.AriaHidden(true), h.Class("text-muted-foreground/40")], ["·"]),
							h.span([h.Class("text-severity-warn normal-case tracking-normal")], [`no step for ${silenceLabel(silentFor)}`]),
						]
					: []),
			]),
			h.ol(
				[h.Class("flex flex-col")],
				steps.map((step, index) => {
					const isLast = index === steps.length - 1
					return h.keyed("li")(
						`${step.at}-${step.tool}-${index}`,
						[h.Class("flex items-baseline gap-2.5 py-[3px] text-xs")],
						[
							statusDot(h, {
								tone: "custom",
								size: "sm",
								className: cn(
									"translate-y-[-2px]",
									isLast && isRunning && !isStalled ? "bg-primary" : isLast && isStalled ? TONE_FILL.warn : "bg-muted-foreground/35",
								),
							}),
							h.span(
								[
									h.Class(cn("min-w-0 flex-1 truncate", isLast && isRunning ? "text-foreground" : "text-muted-foreground")),
									h.Title(step.label),
								],
								[step.label],
							),
						],
					)
				}),
			),
		],
	)
}

const investigating = <M>(h: HtmlBuilder<M>, investigation: V2Investigation, nowMs: number): Html => {
	const start = toEpochMs(investigation.created_at)
	return shell(
		h,
		"bg-primary",
		[
			eyebrow(h, { as: "div", className: "flex flex-wrap items-center gap-2 text-primary" }, [
				h.span([h.Class("flex items-center gap-1.5")], [statusDot(h, { tone: "live" }), "Investigating"]),
			]),
			h.h2([h.Class(HEADING)], ["Maple is gathering evidence."]),
			h.p(
				[h.Class("text-sm leading-6 text-muted-foreground")],
				["One agent is working this question: reading the traces, logs and metrics around it and testing the likely explanations."],
			),
			runProgress(h, investigation, nowMs, "mt-1 border-t pt-4"),
		],
		[
			stat(h, "Elapsed", [bigStat(h, Number.isFinite(start) ? splitDuration(Math.max(0, nowMs - start)) : null)]),
			stat(h, "Confidence", [muted(h, "Pending")], true),
		],
	)
}

const ranForOf = (investigation: V2Investigation) =>
	elapsedBetween(investigation.started_at ?? investigation.created_at, investigation.updated_at)

const failed = <M>(h: HtmlBuilder<M>, investigation: V2Investigation, nowMs: number): Html =>
	shell(
		h,
		"bg-severity-error",
		[
			eyebrow(h, { as: "div", className: "text-severity-error" }, ["No diagnosis"]),
			h.h2([h.Class(HEADING)], ["The pass ended without a diagnosis"]),
			h.p([h.Class("text-sm leading-6 text-muted-foreground")], ["No report was recorded. Retry to run the pass again."]),
			investigation.error
				? h.div(
						[h.Class("flex items-start gap-3 rounded-lg border border-severity-error/25 bg-severity-error/6 px-3 py-2.5")],
						[
							badge(h, { size: "xs", mono: true, className: "mt-0.5 bg-severity-error/12 text-severity-error" }, ["reason"]),
							h.code([h.Class("min-w-0 break-words font-mono text-xs leading-5 text-foreground")], [investigation.error]),
						],
					)
				: null,
			runProgress(h, investigation, nowMs, "mt-1 border-t pt-4"),
		],
		[stat(h, "Ran for", [bigStat(h, ranForOf(investigation))]), stat(h, "Confidence", [muted(h, "None")], true)],
	)

const PARTIAL_VISIBLE_MAX = 5

const partialList = <M>(h: HtmlBuilder<M>, label: string, items: ReadonlyArray<string>, iconName: "CircleXmarkIcon" | "CircleQuestionIcon", tone: string): Html | null => {
	if (items.length === 0) return null
	const visible = items.slice(0, PARTIAL_VISIBLE_MAX)
	const hidden = items.length - visible.length
	return h.div(
		[h.Class("flex min-w-0 flex-col gap-2")],
		[
			eyebrow(h, {}, [label]),
			h.ul(
				[h.Class("flex flex-col gap-1.5")],
				visible.map((item) =>
					h.keyed("li")(item, [h.Class(cn("flex gap-2 text-sm leading-6", tone))], [
						icon(h, iconName, { size: 13, className: "mt-0.5 shrink-0 text-muted-foreground/70" }),
						h.span([h.Class("min-w-0")], [item]),
					]),
				),
			),
			...(hidden > 0 ? [h.span([h.Class("text-xs text-muted-foreground")], [`+${hidden} more in the report`])] : []),
		],
	)
}

const inconclusive = <M>(h: HtmlBuilder<M>, investigation: V2Investigation): Html => {
	const report = investigation.report
	const ruledOut = report?.ruledOut ?? []
	const unchecked = report?.unchecked ?? []
	const headline = reportHeadline(report) ?? "No cause was established, and this run recorded no partial."
	const lists = [
		partialList(h, "Ruled out", ruledOut, "CircleXmarkIcon", "text-foreground"),
		partialList(h, "Couldn't check", unchecked, "CircleQuestionIcon", "text-muted-foreground"),
	].filter((list): list is Html => list !== null)
	return shell(
		h,
		"bg-severity-warn",
		[
			eyebrow(h, { as: "div", className: "flex flex-wrap items-center gap-2 text-severity-warn" }, [
				"Partial result",
				h.span([h.AriaHidden(true), h.Class("text-muted-foreground/40")], ["·"]),
				h.span([], ["No cause established"]),
			]),
			h.h2([h.Class(HEADING)], [headline]),
			report === null ? null : body(h, headline, report.summary),
			lists.length === 0 ? null : h.div([h.Class("mt-1 grid gap-x-8 gap-y-5 lg:grid-cols-2")], lists),
		],
		[
			stat(h, "Ran for", [bigStat(h, ranForOf(investigation))]),
			stat(h, "Ruled out", [h.span([h.Class("text-foreground tabular-nums")], [String(ruledOut.length)])]),
			stat(h, "Confidence", [report === null ? muted(h, EMPTY_VALUE) : confidenceMeter(h, "low")], true),
		],
	)
}

export const verdictCard = <M>(h: HtmlBuilder<M>, investigation: V2Investigation, nowMs: number): Html => {
	switch (investigation.status) {
		case "investigating":
			return investigating(h, investigation, nowMs)
		case "inconclusive":
			return inconclusive(h, investigation)
		case "failed":
			return failed(h, investigation, nowMs)
		default:
			return diagnosed(h, investigation)
	}
}
