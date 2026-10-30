import type { TranscriptPayload } from "@maple/agent-sessions"
import { formatBytes } from "@maple/ui/lib/format"
import { TONE_SOFT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { badge } from "../../../ui/display"
import { eyebrow } from "../../../ui/eyebrow"
import { icon } from "../../../ui/icon"
import type { ClampLines } from "./clamped-text"
import type { Message } from "./message"
import type { Model } from "./model"
import { disclosed, jsonPayload, viewSwitch } from "./payload-view"
import { clampedBody, payloadCopyButton } from "./transcript-kit"

// Tool input and output, and its summary: one invocation, both halves, joined by a spine.

type H = HtmlBuilder<Message>

const IN_CLAMP: ClampLines = 8
const OUT_CLAMP: ClampLines = 14
const META = "font-mono text-3xs text-muted-foreground"
const GUTTER = "flex w-8 shrink-0 flex-col items-center gap-1.5 pt-2.5"

const sizeLine = (payload: TranscriptPayload): string => {
	const size = formatBytes(payload.byteLength)
	return payload.lineCount > 1 ? `${size} · ${payload.lineCount} lines` : size
}

/** The collapsed card's stand-in: both sizes, in gutter order. */
export const toolIoSummary = (
	h: H,
	args: TranscriptPayload | undefined,
	result: TranscriptPayload | undefined,
): Html =>
	h.span(
		[h.Class("flex shrink-0 items-center gap-1 font-mono text-2xs text-muted-foreground")],
		[
			icon(h, "ArrowDownIcon", {
				size: 10,
				className: "text-foreground-subtle",
				attributes: [h.AriaHidden(true)],
			}),
			args === undefined ? "not captured" : formatBytes(args.byteLength),
			icon(h, "ArrowUpIcon", {
				size: 10,
				className: "ml-2 text-chart-4",
				attributes: [h.AriaHidden(true)],
			}),
			result === undefined ? "not captured" : sizeLine(result),
		],
	)

const marker = (h: H, direction: "in" | "out", isFailed: boolean): Html =>
	direction === "in"
		? h.span(
				[
					h.Class(
						"flex size-4 shrink-0 items-center justify-center rounded-full border border-input",
					),
				],
				[
					icon(h, "ArrowDownIcon", {
						size: 9,
						className: "text-muted-foreground",
						attributes: [h.AriaHidden(true)],
					}),
				],
			)
		: h.span(
				[
					h.Class(
						cn(
							"flex size-4 shrink-0 items-center justify-center rounded-full",
							isFailed ? "bg-severity-error" : "bg-chart-4",
						),
					),
				],
				[
					icon(h, "ArrowUpIcon", {
						size: 9,
						className: "text-background",
						attributes: [h.AriaHidden(true)],
					}),
				],
			)

export const truncatedNote = (h: H): Html =>
	h.p(
		[h.Class("text-2xs text-muted-foreground italic")],
		["Cut off here by the instrumentation, not by Maple. The tail was never recorded."],
	)

export const truncatedBadge = (h: H): Html =>
	badge(h, { size: "xs", mono: true, className: TONE_SOFT.warn }, ["truncated by the emitter"])

/** The copy and the rendered/raw switch at a payload header's right edge. */
export const payloadActions = (
	h: H,
	model: Model,
	options: Readonly<{ payload: TranscriptPayload; textKey: string; label: string }>,
): ReadonlyArray<Html> => {
	if (options.payload.text === "") return []
	const { formatted, isJson } = jsonPayload(options.payload.text)
	const rawKey = `${options.textKey}:raw`
	const isRaw = disclosed(model.openRows, rawKey, false)
	return [
		h.span(
			[h.Class("-my-1 ml-auto flex items-center")],
			[
				...(isJson ? [viewSwitch(h, { rendered: "json", isRaw, rawKey, className: "mr-1" })] : []),
				payloadCopyButton(h, model, {
					key: options.textKey,
					value: isRaw ? options.payload.text : formatted,
					label: options.label,
				}),
			],
		),
	]
}

/** The payload's body, pretty-printed unless the reader chose raw. */
export const payloadBody = (
	h: H,
	model: Model,
	options: Readonly<{
		payload: TranscriptPayload
		textKey: string
		clampLines: ClampLines
		toneClass?: string
	}>,
): ReadonlyArray<Html> => {
	if (options.payload.text === "") return []
	const { formatted, isJson } = jsonPayload(options.payload.text)
	const isRaw = disclosed(model.openRows, `${options.textKey}:raw`, false)
	return [
		clampedBody(h, model, {
			text: isRaw ? options.payload.text : formatted,
			textKey: options.textKey,
			rendering: !isRaw && isJson ? "json" : "text",
			isMono: true,
			clampLines: options.clampLines,
			toneClass: options.toneClass,
		}),
	]
}

type Half = Readonly<{
	direction: "in" | "out"
	label: string
	name: string
	payload: TranscriptPayload
	meta?: string
	isFailed: boolean
	clampLines: ClampLines
	textKey: string
}>

const ioHalf = (h: H, model: Model, half: Half): Html =>
	h.div(
		[
			h.Class(
				cn(
					"flex items-stretch",
					half.direction === "in" ? "bg-surface-sunken" : "border-border-subtle border-t",
					half.direction === "out" && half.isFailed && "bg-severity-error/5",
				),
			),
		],
		[
			h.div(
				[h.Class(GUTTER)],
				[
					marker(h, half.direction, half.isFailed),
					...(half.direction === "in"
						? [h.span([h.AriaHidden(true), h.Class("w-px grow bg-input")], [])]
						: []),
				],
			),
			h.div(
				[h.Class("flex min-w-0 grow flex-col gap-2 pt-2.5 pr-3 pb-3")],
				[
					h.div(
						[h.Class("flex flex-wrap items-center gap-2")],
						[
							eyebrow(
								h,
								{
									variant: "mono",
									className: half.isFailed ? "text-severity-error" : "text-foreground",
								},
								[half.label],
							),
							h.span(
								[h.Class(META)],
								[
									[half.name, half.meta, sizeLine(half.payload)]
										.filter((part) => part !== undefined && part !== "")
										.join(" · "),
								],
							),
							...(half.payload.truncatedByEmitter ? [truncatedBadge(h)] : []),
							...payloadActions(h, model, {
								payload: half.payload,
								textKey: half.textKey,
								label: half.name,
							}),
						],
					),
					...payloadBody(h, model, {
						payload: half.payload,
						textKey: half.textKey,
						clampLines: half.clampLines,
						toneClass: half.isFailed ? "text-severity-error/90" : undefined,
					}),
					...(half.payload.truncatedByEmitter ? [truncatedNote(h)] : []),
				],
			),
		],
	)

const missingHalf = (h: H, label: string, note: string): Html =>
	h.div(
		[h.Class("flex items-center border-input border-t border-dashed bg-surface-faint py-2.5 pr-3")],
		[
			h.span(
				[h.Class("flex w-8 shrink-0 justify-center")],
				[
					h.span(
						[
							h.Class(
								"flex size-4 items-center justify-center rounded-full border border-input border-dashed",
							),
						],
						[icon(h, "CircleQuestionIcon", { size: 9, className: "text-muted-foreground" })],
					),
				],
			),
			eyebrow(h, { variant: "mono", className: "shrink-0 pr-2.5 text-muted-foreground" }, [label]),
			h.span([h.Class("min-w-0 text-muted-foreground text-xs")], [note]),
		],
	)

/** `ToolIo`: both halves always drawn; one quiet line when neither was captured. */
export const toolIo = (
	h: H,
	model: Model,
	options: Readonly<{
		args: TranscriptPayload | undefined
		result: TranscriptPayload | undefined
		isFailed: boolean
		resultMeta?: string
		missingResultNote: string
		keyPrefix: string
	}>,
): ReadonlyArray<Html> => {
	const { args, result } = options
	if (args === undefined && result === undefined)
		return [
			h.div(
				[
					h.Class(
						"flex items-center gap-2.5 border-input border-t border-dashed bg-surface-faint px-3 py-2.5",
					),
				],
				[
					h.span(
						[
							h.AriaHidden(true),
							h.Class("flex shrink-0 items-center gap-0.5 text-foreground-subtle"),
						],
						[icon(h, "ArrowDownIcon", { size: 10 }), icon(h, "ArrowUpIcon", { size: 10 })],
					),
					h.span(
						[h.Class("min-w-0 text-muted-foreground text-xs")],
						["Payloads not captured. This span records the call's timing and identity only."],
					),
				],
			),
		]
	return [
		args === undefined
			? missingHalf(h, "Sent", "not captured. The span carries no arguments attribute.")
			: ioHalf(h, model, {
					direction: "in",
					label: "Sent",
					name: "arguments",
					payload: args,
					isFailed: false,
					clampLines: IN_CLAMP,
					textKey: `${options.keyPrefix}:args-text`,
				}),
		result === undefined
			? missingHalf(h, "Returned", options.missingResultNote)
			: ioHalf(h, model, {
					direction: "out",
					label: options.isFailed ? "Returned · error" : "Returned",
					name: "result",
					payload: result,
					meta: options.resultMeta,
					isFailed: options.isFailed,
					clampLines: OUT_CLAMP,
					textKey: `${options.keyPrefix}:result-text`,
				}),
	]
}
