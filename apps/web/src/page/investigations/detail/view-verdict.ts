import type { V2Investigation } from "@maple/domain/http/v2"
import { countLabel, EMPTY_VALUE } from "@maple/ui/lib/format"
import { toEpochMs } from "@maple/ui/lib/time-format"
import { TONE_FILL, TONE_TEXT, type Tone } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { reportHeadline, splitDuration } from "@maple/web-data/investigations/display"
import type { Html, HtmlBuilder } from "foldkit/html"
import { badge } from "@maple/views/ui/display"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { heading as kitHeading } from "@maple/views/ui/heading"
import { icon } from "@maple/views/ui/icon"
import { inlineCode } from "@maple/views/ui/inline-code"
import { statFigure } from "@maple/views/ui/stat-figure"
import { statusDot } from "@maple/views/ui/status-dot"
import { confidenceMeter } from "../kit"
import { elapsedBetween } from "./derive"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { hstack, hstackClass, vstack, vstackClass } from "@maple/views/ui/stack"
import { Array as Arr, String as Str } from "effect"

// `VerdictCard` and `RunProgress`: the verdict and the run's progress.

type Children = ReadonlyArray<Html | string>

const verdictHeading = <M>(h: HtmlBuilder<M>, text: string): Html =>
	kitHeading(h, { level: 2, variant: "title", className: "leading-7 [overflow-wrap:anywhere]" }, [text])

const SEVERITY_LABEL = { critical: "Critical", high: "High", medium: "Medium", low: "Low" } as const
const SEVERITY_TEXT_TONE = {
	critical: "crit",
	high: "crit",
	medium: "warn",
	low: "neutral",
} as const satisfies Record<keyof typeof SEVERITY_LABEL, Tone>

const shell = <M>(
	h: HtmlBuilder<M>,
	accent: string,
	children: ReadonlyArray<Html | null>,
	stats: ReadonlyArray<Html>,
): Html =>
	h.div(
		[
			h.Class(
				"flex shrink-0 overflow-hidden rounded-r-xl border bg-card max-lg:flex-col max-lg:rounded-b-xl max-lg:rounded-tr-none",
			),
		],
		[
			h.span([
				h.AriaHidden(true),
				h.Class(cn("w-[3px] shrink-0 max-lg:h-[3px] max-lg:w-full", accent)),
			]),
			h.div(
				[h.Class("flex min-w-0 flex-1 flex-col gap-3 px-7 py-6")],
				Arr.filter(children, (child): child is Html => child !== null),
			),
			h.div(
				[
					h.Class(
						"flex w-53 shrink-0 flex-col border-l max-lg:w-full max-lg:flex-row max-lg:flex-wrap max-lg:border-l-0 max-lg:border-t",
					),
				],
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
		: statFigure(h, {
				value: elapsed.value,
				unit: elapsed.unit,
				mono: false,
				valueClassName: "text-foreground",
			})

/** A heading never ends in a full stop, even when it is a promoted summary sentence. */
const asHeading = (text: string | null): string | null =>
	text === null ? null : Str.replace(/\.$/, "")(Str.trim(text))

const repeatsHeading = (heading: string | null, text: string): boolean =>
	Str.trim(text).length === 0 || asHeading(text) === heading

const body = <M>(h: HtmlBuilder<M>, heading: string | null, text: string): Html | null =>
	repeatsHeading(heading, text)
		? null
		: h.p(
				[h.Class("font-prose text-sm leading-6 text-muted-foreground [overflow-wrap:anywhere]")],
				[text],
			)

const mechanism = <M>(h: HtmlBuilder<M>, heading: string | null, text: string): Html | null =>
	repeatsHeading(heading, text)
		? null
		: h.div(
				[h.Class("mt-1 border-l-2 pl-4")],
				[
					h.p(
						[
							h.Class(
								"whitespace-pre-line font-prose text-sm leading-6 text-muted-foreground [overflow-wrap:anywhere]",
							),
						],
						[text],
					),
				],
			)

// Identifiers: backticked spans, SCREAMING_SNAKE names, service-like kebab names (checkout-api)
// and short commit shas (hex with a digit and a letter). The rest of an action is prose.
const IDENTIFIER = new RegExp(
	Arr.join(
		[
			"(`[^`]+`",
			"\\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\\b",
			"\\b[a-z][a-z0-9]*(?:-[a-z0-9]+)*-(?:api|svc|service|worker|gateway|web|server|proxy|db|queue|consumer|producer)\\b",
			"\\b(?=[0-9a-f]*[0-9])(?=[0-9a-f]*[a-f])[0-9a-f]{5,40}\\b)",
		],
		"|",
	),
)

// A chip followed by punctuation ("checkout-api's", "8f21c,") drops its right padding, so the
// punctuation sits against the identifier instead of after a gap.
const PUNCTUATION_AFTER = /^['’.,;:!?)]/

const actionText = <M>(h: HtmlBuilder<M>, action: string): Children => {
	const parts = Arr.filter(Str.split(IDENTIFIER)(action), (part) => part.length > 0)
	return Arr.map(parts, (part, index) =>
		IDENTIFIER.test(part)
			? inlineCode(
					h,
					{ className: PUNCTUATION_AFTER.test(parts[index + 1] ?? "") ? "pr-px" : undefined },
					[Str.replace(/^`|`$/g, "")(part)],
				)
			: part,
	)
}

const nextActions = <M>(h: HtmlBuilder<M>, actions: ReadonlyArray<string>): Html | null =>
	actions.length === 0
		? null
		: h.div(
				[h.Class("mt-2 flex flex-col gap-2.5 border-t pt-4")],
				[
					eyebrow(h, {}, ["What to do"]),
					h.ol(
						[h.Class(vstackClass({ gap: "2" }))],
						Arr.map(actions, (action, index) =>
							h.keyed("li")(
								String(index),
								[
									h.Class(
										"flex items-baseline gap-3 font-prose text-sm leading-6 text-foreground",
									),
								],
								[
									typography(
										h,
										{ size: "xs", tone: "muted", numeric: true, className: "shrink-0" },
										[String(index + 1)],
									),
									h.span(
										[h.Class("min-w-0 [overflow-wrap:anywhere]")],
										actionText(h, action),
									),
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
				typography(h, { size: "sm", tone: "muted", as: "p" }, [
					"The pass finished without attaching a report. Run it again to try for a cause.",
				]),
			],
			[stat(h, "Confidence", [confidenceMeter(h, investigation.confidence)], true)],
		)
	const heading = asHeading(reportHeadline(report))
	const severity = report.severityAssessment
	return shell(
		h,
		"bg-primary",
		[
			eyebrow(h, { as: "div", className: "text-primary" }, ["Suspected cause"]),
			verdictHeading(h, heading ?? ""),
			body(h, heading, report.summary),
			mechanism(h, heading, report.suspectedCause),
			nextActions(h, report.suggestedActions),
		],
		[
			stat(h, "Confidence", [confidenceMeter(h, report.confidence)]),
			stat(h, "AI severity", [
				// A warning glyph, so a red "High" severity never reads as the green bar-glyph "High" confidence.
				severity
					? h.span(
							[
								h.Class(
									cn(
										"flex items-center gap-1.5 font-medium",
										TONE_TEXT[SEVERITY_TEXT_TONE[severity]],
									),
								),
							],
							[
								icon(h, "CircleWarningIcon", { size: 12, className: "shrink-0" }),
								SEVERITY_LABEL[severity],
							],
						)
					: muted(h, EMPTY_VALUE),
			]),
			stat(
				h,
				"Time to diagnosis",
				[bigStat(h, elapsedBetween(investigation.created_at, investigation.diagnosed_at))],
				true,
			),
		],
	)
}

const STALL_MS = 90_000

const silenceLabel = (ms: number): string => {
	const minutes = Math.floor(ms / 60_000)
	return minutes < 1 ? "under a minute" : minutes === 1 ? "a minute" : `${minutes} minutes`
}

/** `RunProgress`: the pass's steps, the last one live; a silent run goes still and says so. */
const runProgress = <M>(
	h: HtmlBuilder<M>,
	investigation: V2Investigation,
	nowMs: number,
	className: string,
): Html | null => {
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
		[h.Class(cn(vstackClass({ gap: "2.5" }), className))],
		[
			eyebrow(h, { as: "div", className: hstackClass({ gap: "2", align: "baseline" }) }, [
				h.span([], [countLabel(progress?.stepCount ?? 0, "step")]),
				...(isStalled
					? [
							h.span([h.AriaHidden(true), h.Class("text-foreground-faint")], ["·"]),
							h.span(
								[h.Class("text-severity-warn normal-case tracking-normal")],
								[`no step for ${silenceLabel(silentFor)}`],
							),
						]
					: []),
			]),
			h.ol(
				[h.Class("flex flex-col")],
				Arr.map(steps, (step, index) => {
					const isLast = index === steps.length - 1
					return h.keyed("li")(
						`${step.at}-${step.tool}-${index}`,
						[h.Class("flex items-baseline gap-2.5 py-1 text-xs")],
						[
							statusDot(h, {
								tone: "custom",
								size: "sm",
								className: cn(
									"translate-y-[-2px]",
									isLast && isRunning && !isStalled
										? "bg-primary"
										: isLast && isStalled
											? TONE_FILL.warn
											: "bg-foreground-faint",
								),
							}),
							h.span(
								[
									h.Class(
										cn(
											typographyClass({ truncate: true, className: "min-w-0 flex-1" }),
											isLast && isRunning ? "text-foreground" : "text-muted-foreground",
										),
									),
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
				hstack(h, { gap: "1.5", as: "span" }, [statusDot(h, { tone: "live" }), "Investigating"]),
			]),
			verdictHeading(h, "Maple is gathering evidence."),
			h.p(
				[h.Class("text-sm leading-6 text-muted-foreground")],
				[
					"One agent is working this question: reading the traces, logs and metrics around it and testing the likely explanations.",
				],
			),
			runProgress(h, investigation, nowMs, "mt-1 border-t pt-4"),
		],
		[
			stat(h, "Elapsed", [
				bigStat(h, Number.isFinite(start) ? splitDuration(Math.max(0, nowMs - start)) : null),
			]),
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
			verdictHeading(h, "The pass ended without a diagnosis"),
			h.p(
				[h.Class("text-sm leading-6 text-muted-foreground")],
				["No report was recorded. Retry to run the pass again."],
			),
			investigation.error
				? h.div(
						[
							h.Class(
								"flex items-start gap-3 rounded-md border border-severity-error-a3 bg-severity-error-a1 p-3",
							),
						],
						[
							badge(
								h,
								{
									size: "xs",
									mono: true,
									className: "mt-0.5 bg-severity-error-a2 text-severity-error",
								},
								["reason"],
							),
							h.code(
								[h.Class("min-w-0 break-words font-mono text-xs leading-5 text-foreground")],
								[investigation.error],
							),
						],
					)
				: null,
			runProgress(h, investigation, nowMs, "mt-1 border-t pt-4"),
		],
		[
			stat(h, "Ran for", [bigStat(h, ranForOf(investigation))]),
			stat(h, "Confidence", [muted(h, "None")], true),
		],
	)

const PARTIAL_VISIBLE_MAX = 5

const partialList = <M>(
	h: HtmlBuilder<M>,
	label: string,
	items: ReadonlyArray<string>,
	iconName: "CircleXmarkIcon" | "CircleQuestionIcon",
	tone: string,
): Html | null => {
	if (items.length === 0) return null
	const visible = items.slice(0, PARTIAL_VISIBLE_MAX)
	const hidden = items.length - visible.length
	return vstack(h, { gap: "2", shrink: true }, [
		eyebrow(h, {}, [label]),
		vstack(
			h,
			{ gap: "1.5", as: "ul" },
			Arr.map(visible, (item) =>
				h.keyed("li")(
					item,
					[h.Class(cn("flex gap-2 text-sm leading-6", tone))],
					[
						icon(h, iconName, {
							size: 14,
							className: "mt-0.5 shrink-0 text-foreground-subtle",
						}),
						h.span([h.Class("min-w-0")], [item]),
					],
				),
			),
		),
		...(hidden > 0
			? [typography(h, { size: "xs", tone: "muted" }, [`+${hidden} more in the report`])]
			: []),
	])
}

const inconclusive = <M>(h: HtmlBuilder<M>, investigation: V2Investigation): Html => {
	const report = investigation.report
	const ruledOut = report?.ruledOut ?? []
	const unchecked = report?.unchecked ?? []
	const headline =
		asHeading(reportHeadline(report)) ?? "No cause was established, and this run recorded no partial"
	const lists = Arr.filter(
		[
			partialList(h, "Ruled out", ruledOut, "CircleXmarkIcon", "text-foreground"),
			partialList(h, "Couldn't check", unchecked, "CircleQuestionIcon", "text-muted-foreground"),
		],
		(list): list is Html => list !== null,
	)
	return shell(
		h,
		"bg-severity-warn",
		[
			eyebrow(h, { as: "div", className: "flex flex-wrap items-center gap-2 text-severity-warn" }, [
				"Partial result",
				h.span([h.AriaHidden(true), h.Class("text-foreground-faint")], ["·"]),
				h.span([], ["No cause established"]),
			]),
			verdictHeading(h, headline),
			report === null ? null : body(h, headline, report.summary),
			lists.length === 0 ? null : h.div([h.Class("mt-1 grid gap-x-8 gap-y-5 lg:grid-cols-2")], lists),
		],
		[
			stat(h, "Ran for", [bigStat(h, ranForOf(investigation))]),
			stat(h, "Ruled out", [
				typography(h, { tone: "foreground", numeric: true }, [String(ruledOut.length)]),
			]),
			stat(
				h,
				"Confidence",
				[report === null ? muted(h, EMPTY_VALUE) : confidenceMeter(h, "low")],
				true,
			),
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
