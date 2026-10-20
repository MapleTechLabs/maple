import type { ErrorIssueDocument } from "@maple/domain/http"
import { formatNumber } from "@maple/ui/lib/format"
import { formatRelativeTime } from "@maple/ui/lib/time-format"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as CopyButton from "../../../ui/copy-button"
import { eyebrow } from "../../../ui/eyebrow"
import { truncatedText } from "../../../ui/truncated-text"
import { formatTimestamp } from "../hub/view-signal"
import { SEVERITY_FILL } from "../kit/severity"
import { Message } from "./message"
import type { Model } from "./model"

// `IssueCulpritPanel`, `IssueField` and `IssueFactStrip` (components/errors/).

type H = HtmlBuilder<Message>

const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g")
const stripAnsi = (text: string): string => text.replace(ANSI_ESCAPE, "")

/** `IssueField`: an eyebrow over its value, ruled off from the field above. */
export const issueField = (h: H, label: string, children: ReadonlyArray<Html>): Html =>
	h.div(
		[h.Class("flex min-w-0 flex-col gap-1.5 border-t pt-3.5 first:border-t-0 first:pt-0")],
		[eyebrow(h, {}, [label]), ...children],
	)

const COPY_CLASS =
	"-my-0.5 shrink-0 opacity-0 transition-opacity focus-visible:opacity-100 group-hover/mono:opacity-100 pointer-coarse:opacity-100"

/** `Mono`: a copyable monospace value. TODO(tooltip): the copy button's "Copy" tooltip popup. */
const mono = (
	h: H,
	value: string,
	label: string,
	model: CopyButton.Model,
	wrap: (m: CopyButton.Message) => Message,
): Html =>
	h.div(
		[h.Class("group/mono flex min-w-0 items-start gap-1.5")],
		[
			h.code([h.Class("min-w-0 break-all font-mono text-xs leading-5 text-foreground/90")], [value]),
			CopyButton.view(h, {
				model,
				value,
				label,
				toParentMessage: wrap,
				className: COPY_CLASS,
				attributes: [
					h.DataAttribute("base-ui-tooltip-trigger", ""),
					h.DataAttribute("slot", "tooltip-trigger"),
				],
			}),
		],
	)

/** The message, the culprit frame and the fingerprint, behind a severity rule. */
export const culpritPanel = (h: H, model: Model, issue: ErrorIssueDocument): Html => {
	const message = stripAnsi(issue.exceptionMessage || issue.errorLabel)
	const toFingerprint = (message: CopyButton.Message) => Message.GotFingerprintCopyMessage({ message })
	return h.div(
		[h.Class("flex shrink-0 overflow-hidden rounded-r-xl border bg-card")],
		[
			h.span(
				[
					h.AriaHidden(true),
					h.Class(
						cn(
							"w-[3px] shrink-0",
							issue.severity === null ? "bg-border" : SEVERITY_FILL[issue.severity],
						),
					),
				],
				[],
			),
			h.div(
				[h.Class("flex min-w-0 flex-1 flex-col gap-4 px-6 py-5")],
				[
					message
						? h.p(
								[
									h.Class(
										"max-h-48 min-w-0 overflow-y-auto break-words whitespace-pre-wrap text-sm leading-relaxed text-foreground",
									),
								],
								[message],
							)
						: h.p(
								[h.Class("text-sm text-muted-foreground")],
								["This error carries no message — only its type and where it was raised."],
							),
					// TODO(top-frame-copy): a top frame should copy through its own button status.
					issueField(h, "Culprit", [
						issue.topFrame
							? mono(h, issue.topFrame, "Top frame", model.fingerprintCopy, toFingerprint)
							: h.span(
									[h.Class("text-xs text-muted-foreground")],
									["No stack frame was attributed to this fingerprint."],
								),
					]),
					...(issue.fingerprintHash
						? [
								issueField(h, "Fingerprint", [
									mono(
										h,
										issue.fingerprintHash,
										"Fingerprint",
										model.fingerprintCopy,
										toFingerprint,
									),
								]),
							]
						: []),
				],
			),
		],
	)
}

const STRIP = [
	"grid shrink-0 gap-y-5 px-1",
	"grid-cols-2 xl:grid-cols-4",
	"[&>*]:border-l [&>*]:pl-6",
	"[&>*:nth-child(odd)]:border-l-0 [&>*:nth-child(odd)]:pl-0",
	"xl:[&>*:nth-child(odd)]:border-l xl:[&>*:nth-child(odd)]:pl-6",
	"xl:[&>*:first-child]:border-l-0 xl:[&>*:first-child]:pl-0",
].join(" ")

/** `FactStrip` / `FactLane`: labelled facts in ruled lanes. */
export const factStrip = (h: H, lanes: ReadonlyArray<Html>): Html => h.div([h.Class(STRIP)], lanes)

export const factLane = (h: H, label: string, children: ReadonlyArray<Html>): Html =>
	h.div(
		[h.Class("flex min-w-0 flex-col gap-1.5")],
		[eyebrow(h, {}, [label]), h.div([h.Class("min-w-0 text-sm")], children)],
	)

const count = (h: H, value: number): Html =>
	h.span(
		[h.Class("text-foreground tabular-nums"), h.Title(value.toLocaleString("en-US"))],
		[formatNumber(value)],
	)

/** `RelativeTime tooltip="title"`: relative text, the absolute stamp as its title. */
export const stamp = (h: H, iso: string, timeZone: string, nowMs: number): Html => {
	const ms = new Date(iso).getTime()
	return h.time(
		[
			h.Attribute("datetime", new Date(ms).toISOString()),
			h.Title(formatTimestamp(iso, timeZone, true)),
			h.Class("text-foreground tabular-nums"),
		],
		[formatRelativeTime(ms, nowMs)],
	)
}

export type FactInputs = Readonly<{
	windowCount: number
	windowLabel: string
	timeZone: string
	nowMs: number
}>

/** `IssueFactStrip`: window and lifetime counts, first and last seen, then what applies. */
export const issueFactStrip = (h: H, issue: ErrorIssueDocument, inputs: FactInputs): Html =>
	factStrip(h, [
		factLane(h, `Events · ${inputs.windowLabel}`, [count(h, inputs.windowCount)]),
		factLane(h, "Events · all time", [count(h, issue.occurrenceCount)]),
		factLane(h, "First seen", [stamp(h, issue.firstSeenAt, inputs.timeZone, inputs.nowMs)]),
		factLane(h, "Last seen", [stamp(h, issue.lastSeenAt, inputs.timeZone, inputs.nowMs)]),
		...(issue.regressionCount > 0
			? [
					factLane(h, "Regressions", [
						h.span(
							[h.Class("text-foreground")],
							[
								h.span([h.Class("tabular-nums")], [String(issue.regressionCount)]),
								...(issue.lastRegressedAt
									? [
											h.span(
												[h.Class("text-muted-foreground")],
												[
													" ",
													"· last ",
													formatRelativeTime(issue.lastRegressedAt, inputs.nowMs),
												],
											),
										]
									: []),
							],
						),
					]),
				]
			: issue.lastResolvedAt
				? [
						factLane(h, "Fix held since", [
							stamp(h, issue.lastResolvedAt, inputs.timeZone, inputs.nowMs),
						]),
					]
				: []),
		...(issue.resolvedVersions.length > 0
			? [
					factLane(h, "Resolved in", [
						truncatedText(h, {
							text: issue.resolvedVersions.join(", "),
							mono: true,
							className: "text-xs text-foreground",
						}),
					]),
				]
			: []),
		...(issue.snoozeUntil
			? [factLane(h, "Snoozed until", [stamp(h, issue.snoozeUntil, inputs.timeZone, inputs.nowMs)])]
			: []),
	])
