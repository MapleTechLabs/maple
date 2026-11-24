import type { ErrorIssueDocument, IssueSeverity } from "@maple/domain/http"
import { formatNumber } from "@maple/ui/lib/format"
import type { Tone } from "@maple/ui/lib/tone"
import { toEpochMs } from "@maple/ui/lib/time-format"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as CopyButton from "@maple/views/ui/copy-button"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { panel, panelHeader } from "@maple/views/ui/panel"
import { formatExactCount } from "@maple/views/lib/locale"
import { relativeTime } from "../../kit/relative-time"
import { statRail, statRailItem } from "../../kit/stat-rail"
import { Message } from "./message"
import type { Model } from "./model"
import { typography } from "@maple/views/ui/typography"
import { hstack, vstack } from "@maple/views/ui/stack"
import { Array as Arr, String as Str } from "effect"
import { stripClass } from "@maple/views/ui/rule"
import { disclosureStrip, monospaceBlock } from "../../kit/disclosure-strip"
import type { SymbolicatedStack } from "@maple/domain/errors/js-stack"
import { badge } from "@maple/views/ui/display"
import { icon } from "@maple/views/ui/icon"
import { inlineCode } from "@maple/views/ui/inline-code"
import { stackFrameList } from "@maple/views/ui/stack-frames"
import { toggle } from "@maple/views/ui/toggle"

// `IssueExceptionPanel` and `IssueStats`: what broke, then how often and since when.

type H = HtmlBuilder<Message>

const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g")
const stripAnsi = (text: string): string => Str.replace(ANSI_ESCAPE, "")(text)

/** A frame path breaks after each `/` rather than mid-word. */
const breakablePath = (h: H, path: string): ReadonlyArray<Html | string> =>
	Arr.flatMap(Str.split("/")(path), (part, index) => (index === 0 ? [part] : [h.wbr([]), `/${part}`]))

/** The labelled sub-box of a panel body (the finding page's "Root cause"). */
export const issueField = (h: H, label: string, children: ReadonlyArray<Html>): Html =>
	vstack(h, { gap: "1.5", shrink: true, className: stripClass("box") }, [
		eyebrow(h, { as: "div" }, [label]),
		...children,
	])

const COPY_CLASS =
	"-my-0.5 shrink-0 opacity-0 transition-opacity focus-visible:opacity-100 group-hover/mono:opacity-100 pointer-coarse:opacity-100"

/** The first mapped in-app frame as `function (file:line:column)`, when the stack was source mapped. */
const mappedTopFrame = (stack: SymbolicatedStack | null): string | undefined => {
	const frame = stack?.frames.find((f) => f.resolved && f.in_app)
	if (frame === undefined || frame.file === null) return undefined
	const position = frame.line === null ? "" : `:${frame.line}${frame.column === null ? "" : `:${frame.column}`}`
	return `${frame.function ?? "<anonymous>"} (${frame.file}${position})`
}

/** The exception message, the top frame it was raised from, and the newest full stack trace. */
export const exceptionPanel = (
	h: H,
	model: Model,
	issue: ErrorIssueDocument,
	stacktrace: string | null,
	stack: SymbolicatedStack | null,
): Html => {
	const message = stripAnsi(issue.exceptionMessage || issue.errorLabel)
	const topFrame = mappedTopFrame(stack) ?? issue.topFrame
	return panel(h, { className: "shrink-0 overflow-hidden" }, [
		panelHeader(h, {
			title: "What broke",
		}),
		vstack(h, { gap: "4", className: "p-4" }, [
			message
				? h.p(
						[
							h.Class(
								"max-h-48 min-w-0 overflow-y-auto break-words whitespace-pre-wrap font-mono text-sm leading-relaxed text-foreground",
							),
						],
						[message],
					)
				: typography(h, { size: "sm", tone: "muted", as: "p" }, [
						"This error carries no message, only its type and where it was raised.",
					]),
			issueField(h, "Raised at", [
				topFrame
					? hstack(h, { gap: "1.5", align: "start", shrink: true, className: "group/mono" }, [
							h.code(
								[
									h.Class(
										"min-w-0 break-words font-mono text-xs leading-5 text-foreground-soft",
									),
								],
								breakablePath(h, topFrame),
							),
							CopyButton.view(h, {
								model: model.fingerprintCopy,
								value: topFrame,
								label: "top frame",
								toParentMessage: (message) => Message.GotFingerprintCopyMessage({ message }),
								className: COPY_CLASS,
							}),
						])
					: typography(h, { size: "xs", tone: "muted" }, [
							"No stack frame was attributed to this fingerprint",
						]),
			]),
			...missingMapHint(h, stack),
		]),
		...stackFoot(h, model, stacktrace, stack),
	])
}

const rawStrip = (h: H, stacktrace: string | null): ReadonlyArray<Html> =>
	stacktrace === null
		? []
		: [disclosureStrip(h, { label: "Full stack trace", text: stripAnsi(stacktrace) })]

/** Where to start when no map matched: the first minified file the backend looked for. */
const missingMapHint = (h: H, stack: SymbolicatedStack | null): ReadonlyArray<Html> => {
	const file = stack?.status === "missing_map" ? stack.missing[0] : undefined
	return file === undefined
		? []
		: [
				typography(h, { size: "xs", tone: "muted", as: "p", className: "break-all" }, [
					`No source map found for ${file}. Upload maps with `,
					inlineCode(h, {}, ["maple sourcemaps upload"]),
				]),
			]
}

/** The symbolicated frames under a "Source mapped" bar, with "Raw" swapping in the text as sent. */
const symbolicatedStrip = (h: H, model: Model, stacktrace: string | null, stack: SymbolicatedStack): Html =>
	h.div(
		[h.Class("border-t")],
		[
			hstack(h, { gap: "2", justify: "between", className: "px-4 py-2" }, [
				hstack(h, { gap: "2", shrink: true }, [
					typography(h, { size: "xs", tone: "muted" }, ["Stack trace"]),
					badge(
						h,
						{
							variant: stack.status === "resolved" ? "ok" : "meta",
							size: "sm",
							attributes:
								stack.status === "partial" && stack.missing.length > 0
									? [h.Title(`No source map for ${Arr.join(stack.missing, ", ")}`)]
									: [],
						},
						stack.status === "resolved"
							? [icon(h, "CircleCheckIcon", {}), "Source mapped"]
							: ["Partly source mapped"],
					),
				]),
				...(stacktrace === null
					? []
					: [
							toggle(
								h,
								{
									isPressed: model.isShowingRawStack,
									onClick: Message.ToggledRawStack(),
									size: "xs",
									variant: "outline",
								},
								["Raw"],
							),
						]),
			]),
			model.isShowingRawStack && stacktrace !== null
				? monospaceBlock(h, stripAnsi(stacktrace))
				: stackFrameList(h, {
						frames: stack.frames,
						toggled: model.stackToggles,
						onToggle: (key) => Message.ToggledStackRow({ key }),
						idPrefix: "issue-stack",
						className: "border-t",
					}),
		],
	)

/** The panel's foot: mapped frames once a map matched, else today's raw strip. */
const stackFoot = (
	h: H,
	model: Model,
	stacktrace: string | null,
	stack: SymbolicatedStack | null,
): ReadonlyArray<Html> => {
	if (stack === null) return rawStrip(h, stacktrace)
	switch (stack.status) {
		case "resolved":
		case "partial":
			return stack.frames.length === 0
				? rawStrip(h, stacktrace)
				: [symbolicatedStrip(h, model, stacktrace, stack)]
		case "missing_map":
		case "not_applicable":
			return rawStrip(h, stacktrace)
	}
}

/** The rail tone of a severity: high and critical read as critical, unset as neutral. */
const SEVERITY_STAT_TONE = {
	critical: "crit",
	high: "crit",
	medium: "warn",
	low: "info",
} satisfies Record<IssueSeverity, Tone>

export type StatInputs = Readonly<{
	windowCount: number
	windowLabel: string
	/**
	 * The window's bucket width as a label ("15m"), how many whole buckets it has and what they hold
	 * (the surge's own population), so a surge can say its rate in counts; `null` leaves a ratio.
	 */
	buckets: Readonly<{ label: string; count: number; total: number }> | null
	/** The window's tail against its own average; `null` when there is too little to say. */
	surge: number | null
	timeZone: string
	nowMs: number
}>

export const SURGE_THRESHOLD = 2.5

const exact = (value: number): Html | string => formatNumber(value)

const stamp = (h: H, iso: string, inputs: StatInputs): Html =>
	relativeTime(h, { value: iso, nowMs: inputs.nowMs, timeZone: inputs.timeZone })

/** Below this the window's tail has dropped to under half its usual rate. */
const FADE_THRESHOLD = 0.5

const about = (value: number): string => `~${formatNumber(Math.max(1, Math.round(value)))}`

/**
 * A surge in counts: the recent rate against the window's average. The header's badge already
 * says the ratio, so the tile says what it means.
 */
const surgeLine = (inputs: StatInputs, surge: number): string => {
	if (inputs.buckets === null || inputs.buckets.count === 0) return `${surge.toFixed(1)}x the usual rate`
	const usual = inputs.buckets.total / inputs.buckets.count
	return `${about(usual * surge)}/${inputs.buckets.label} now, ${about(usual)} usual`
}

/** What the window's tail says about the trend; nothing when there is too little to say. */
const trendLine = (inputs: StatInputs): string | undefined =>
	inputs.windowCount === 0
		? "Quiet in this window"
		: inputs.surge === null
			? undefined
			: inputs.surge >= SURGE_THRESHOLD
				? surgeLine(inputs, inputs.surge)
				: inputs.surge < FADE_THRESHOLD
					? `Fading, ${inputs.surge.toFixed(1)}x the usual rate`
					: "Steady in this window"

/** Resolving keeps `lastRegressedAt`, so a fix after the last regression is what holds now. */
const isFixHeldSince = (issue: ErrorIssueDocument): boolean =>
	issue.lastResolvedAt !== null &&
	(issue.lastRegressedAt === null || toEpochMs(issue.lastResolvedAt) > toEpochMs(issue.lastRegressedAt))

/**
 * `IssueStats`: the window's events and trend, lifetime events, first seen, last seen and any
 * regression. `isFlush` draws it as the head strip of the occurrences panel, over its chart.
 */
export const issueStats = (
	h: H,
	issue: ErrorIssueDocument,
	inputs: StatInputs,
	options: Readonly<{ isFlush?: boolean }> = {},
): Html => {
	const isSurging = inputs.surge !== null && inputs.surge >= SURGE_THRESHOLD
	const tone: Tone = issue.severity === null ? "neutral" : SEVERITY_STAT_TONE[issue.severity]
	// Only error issues read a window timeseries; an alert's window was never queried.
	const hasWindow = issue.kind === "error"
	return statRail(
		h,
		{ columns: hasWindow ? 4 : 3, isFlush: options.isFlush === true, className: "shrink-0" },
		[
			...(hasWindow
				? [
						statRailItem(h, {
							eyebrow: `Events · ${inputs.windowLabel}`,
							value: h.span(
								[h.Title(formatExactCount(inputs.windowCount))],
								[exact(inputs.windowCount)],
							),
							tone: isSurging ? tone : "neutral",
							compact: true,
							subline: trendLine(inputs),
						}),
					]
				: []),
			statRailItem(h, {
				eyebrow: "All time",
				value: h.span(
					[h.Title(formatExactCount(issue.occurrenceCount))],
					[exact(issue.occurrenceCount)],
				),
				compact: true,
			}),
			statRailItem(h, {
				eyebrow: "First seen",
				value: stamp(h, issue.firstSeenAt, inputs),
				compact: true,
				valueClassName: "text-xl",
			}),
			statRailItem(h, {
				eyebrow: "Last seen",
				value: stamp(h, issue.lastSeenAt, inputs),
				compact: true,
				valueClassName: "text-xl",
				subline:
					issue.lastRegressedAt !== null && !isFixHeldSince(issue)
						? typography(h, { tone: "warning" }, [
								"regressed ",
								stamp(h, issue.lastRegressedAt, inputs),
							])
						: issue.snoozeUntil !== null
							? h.span([], ["snoozed until ", stamp(h, issue.snoozeUntil, inputs)])
							: issue.lastResolvedAt !== null
								? h.span([], ["fix held since ", stamp(h, issue.lastResolvedAt, inputs)])
								: undefined,
			}),
		],
	)
}
