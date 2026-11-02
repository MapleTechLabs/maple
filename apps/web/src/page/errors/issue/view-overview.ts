import type { ErrorIssueDocument, IssueSeverity } from "@maple/domain/http"
import { formatNumber } from "@maple/ui/lib/format"
import type { Tone } from "@maple/ui/lib/tone"
import { formatRelativeTime, toEpochMs } from "@maple/ui/lib/time-format"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as CopyButton from "../../../ui/copy-button"
import { eyebrow } from "../../../ui/eyebrow"
import { panel, panelHeader } from "../../../ui/panel"
import { formatExactCount } from "../../kit/locale"
import { relativeTime } from "../../kit/relative-time"
import { statRail, statRailItem } from "../../kit/stat-rail"
import { SEVERITY_TOKEN } from "../kit/severity"
import { Message } from "./message"
import type { Model } from "./model"

// `IssueExceptionPanel` and `IssueStats`: what broke, then how often and since when.

type H = HtmlBuilder<Message>

const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g")
const stripAnsi = (text: string): string => text.replace(ANSI_ESCAPE, "")

/** A frame path breaks after each `/` rather than mid-word. */
const breakablePath = (h: H, path: string): ReadonlyArray<Html | string> =>
	path.split("/").flatMap((part, index) => (index === 0 ? [part] : [h.wbr([]), `/${part}`]))

/** The labelled sub-box of a panel body (the finding page's "Root cause"). */
export const issueField = (h: H, label: string, children: ReadonlyArray<Html>): Html =>
	h.div(
		[h.Class("flex min-w-0 flex-col gap-1.5 rounded-md border p-3")],
		[eyebrow(h, { as: "div" }, [label]), ...children],
	)

const COPY_CLASS =
	"-my-0.5 shrink-0 opacity-0 transition-opacity focus-visible:opacity-100 group-hover/mono:opacity-100 pointer-coarse:opacity-100"

/** The exception message, then the top frame it was raised from. */
export const exceptionPanel = (h: H, model: Model, issue: ErrorIssueDocument): Html => {
	const message = stripAnsi(issue.exceptionMessage || issue.errorLabel)
	return panel(h, { className: "shrink-0 overflow-hidden" }, [
		panelHeader(h, {
			title: "What broke",
		}),
		h.div(
			[h.Class("flex flex-col gap-4 p-4")],
			[
				message
					? h.p(
							[
								h.Class(
									"max-h-48 min-w-0 overflow-y-auto break-words whitespace-pre-wrap font-mono text-sm leading-relaxed text-foreground",
								),
							],
							[message],
						)
					: h.p(
							[h.Class("text-sm text-muted-foreground")],
							["This error carries no message, only its type and where it was raised."],
						),
				issueField(h, "Raised at", [
					issue.topFrame
						? h.div(
								[h.Class("group/mono flex min-w-0 items-start gap-1.5")],
								[
									h.code(
										[
											h.Class(
												"min-w-0 break-words font-mono text-xs leading-5 text-foreground-soft",
											),
										],
										breakablePath(h, issue.topFrame),
									),
									CopyButton.view(h, {
										model: model.fingerprintCopy,
										value: issue.topFrame,
										label: "top frame",
										toParentMessage: (message) =>
											Message.GotFingerprintCopyMessage({ message }),
										className: COPY_CLASS,
									}),
								],
							)
						: h.span(
								[h.Class("text-xs text-muted-foreground")],
								["No stack frame was attributed to this fingerprint."],
							),
				]),
			],
		),
	])
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
	/** The window's buckets, oldest first, for the Events tile's bars. */
	spark: ReadonlyArray<number>
	/** The window's tail against its own average; `null` when there is too little to say. */
	surge: number | null
	timeZone: string
	nowMs: number
}>

export const SURGE_THRESHOLD = 2.5

const exact = (value: number): Html | string => formatNumber(value)

const stamp = (h: H, iso: string, inputs: StatInputs): Html =>
	relativeTime(h, { value: iso, nowMs: inputs.nowMs, timeZone: inputs.timeZone, tooltip: "title" })

/** Below this the window's tail has dropped to under half its usual rate. */
const FADE_THRESHOLD = 0.5

/** What the window's tail says about the trend; nothing when there is too little to say. */
const trendLine = (inputs: StatInputs): string | undefined =>
	inputs.windowCount === 0
		? "Quiet in this window"
		: inputs.surge === null
			? undefined
			: inputs.surge >= SURGE_THRESHOLD
				? `${inputs.surge.toFixed(1)}x the usual rate`
				: inputs.surge < FADE_THRESHOLD
					? `Fading, ${inputs.surge.toFixed(1)}x the usual rate`
					: "Steady in this window"

/** Resolving keeps `lastRegressedAt`, so a fix after the last regression is what holds now. */
const isFixHeldSince = (issue: ErrorIssueDocument): boolean =>
	issue.lastResolvedAt !== null &&
	(issue.lastRegressedAt === null || toEpochMs(issue.lastResolvedAt) > toEpochMs(issue.lastRegressedAt))

/** `IssueStats`: the window's events and trend, lifetime events, first seen, last seen and any regression. */
export const issueStats = (h: H, issue: ErrorIssueDocument, inputs: StatInputs): Html => {
	const isSurging = inputs.surge !== null && inputs.surge >= SURGE_THRESHOLD
	const tone: Tone = issue.severity === null ? "neutral" : SEVERITY_STAT_TONE[issue.severity]
	// Only error issues read a window timeseries; an alert's window was never queried.
	const hasWindow = issue.kind === "error"
	return statRail(h, { columns: hasWindow ? 4 : 3, className: "shrink-0" }, [
		...(hasWindow
			? [
					statRailItem(h, {
						eyebrow: `Events · ${inputs.windowLabel}`,
						value: h.span(
							[h.Title(formatExactCount(inputs.windowCount))],
							[exact(inputs.windowCount)],
						),
						tone: isSurging ? tone : "neutral",
						spark: inputs.spark,
						sparkColor:
							issue.severity === null ? undefined : `var(${SEVERITY_TOKEN[issue.severity]})`,
						subline: trendLine(inputs),
					}),
				]
			: []),
		statRailItem(h, {
			eyebrow: "All time",
			value: h.span([h.Title(formatExactCount(issue.occurrenceCount))], [exact(issue.occurrenceCount)]),
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
					? h.span(
							[h.Class("text-severity-warn")],
							["regressed ", formatRelativeTime(issue.lastRegressedAt, inputs.nowMs)],
						)
					: issue.snoozeUntil !== null
						? h.span([], ["snoozed until ", formatRelativeTime(issue.snoozeUntil, inputs.nowMs)])
						: issue.lastResolvedAt !== null
							? h.span(
									[],
									[
										"fix held since ",
										formatRelativeTime(issue.lastResolvedAt, inputs.nowMs),
									],
								)
							: undefined,
		}),
	])
}
