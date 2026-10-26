import type { TranscriptPayload, TranscriptRow } from "@maple/agent-sessions"
import { formatBytes, formatDuration } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { eyebrow } from "../../../ui/eyebrow"
import { icon } from "../../../ui/icon"
import { panel } from "../../../ui/panel"
import { Message } from "./message"
import type { Model } from "./model"
import { disclosed } from "./payload-view"
import { payloadActions, payloadBody, toolIo, toolIoSummary, truncatedBadge, truncatedNote } from "./tool-io"
import { clockOf, META, ON_HOVER, row } from "./transcript-shell"

// The transcript's tool cards and payload sections (`ToolBlock`, `PayloadSection`).

type H = HtmlBuilder<Message>

const missingResultNote = (tool: Extract<TranscriptRow, { kind: "tool" }>): string =>
	tool.fromMessageOnly
		? "not captured. This call is known only from the message that made it. Whether it ran is unknown."
		: tool.failed
			? "not captured. The span failed without recording a result or an error message."
			: "not captured. The span carries no result attribute and no later message echoes this call id. Whether it succeeded is unknown."

const toolHeader = (
	h: H,
	tool: Extract<TranscriptRow, { kind: "tool" }>,
	isOpen: boolean,
	timeZone: string,
): Html => {
	const name = tool.toolName ?? tool.span.spanName
	return h.button(
		[
			h.AriaExpanded(isOpen),
			h.Class("group flex h-8 w-full min-w-0 cursor-pointer items-center gap-2 px-2.5 text-left"),
			h.Title(clockOf(tool.startMs, timeZone)),
			h.Type("button"),
			h.OnClick(Message.ToggledRow({ key: `${tool.key}:payloads` })),
		],
		[
			icon(h, "GearIcon", {
				size: 12,
				className: cn("shrink-0", tool.failed ? "text-severity-error" : "text-chart-4"),
			}),
			h.span(
				[h.Class("min-w-0 truncate font-medium font-mono text-foreground text-xs"), h.Title(name)],
				[name],
			),
			...(tool.fromMessageOnly
				? []
				: [h.span([h.Class(cn(META, "shrink-0"))], [formatDuration(tool.span.durationMs)])]),
			...(tool.failed && tool.span.genAi.errorType !== undefined
				? [
						h.span(
							[h.Class("shrink-0 font-mono text-2xs text-severity-error")],
							[tool.span.genAi.errorType],
						),
					]
				: []),
			...(isOpen ? [] : [toolIoSummary(h, tool.args, tool.result)]),
			h.span(
				[h.Class("ml-auto flex shrink-0 items-center gap-2")],
				[
					...(!tool.failed && tool.callId !== undefined
						? [h.span([h.Class(cn(META, "shrink-0", ON_HOVER))], [tool.callId])]
						: []),
					h.span(
						[
							h.AriaHidden(true),
							h.Class("-mr-1 p-1 text-muted-foreground group-hover:text-foreground"),
						],
						[icon(h, isOpen ? "ChevronDownIcon" : "ChevronRightIcon", { size: 12 })],
					),
				],
			),
		],
	)
}

export const toolBlock = (
	h: H,
	model: Model,
	tool: Extract<TranscriptRow, { kind: "tool" }>,
	timeZone: string,
): Html => {
	const isOpen = disclosed(model.openRows, `${tool.key}:payloads`, model.options.showPayloads)
	return row(h, { depth: tool.depth, className: "pt-1.5" }, [
		panel(
			h,
			{
				className: tool.failed
					? "border-severity-error/40 bg-severity-error/5"
					: isOpen
						? "border-border bg-card"
						: "border-transparent bg-muted/30 hover:bg-muted/50",
			},
			[
				toolHeader(h, tool, isOpen, timeZone),
				...(isOpen
					? toolIo(h, model, {
							args: tool.args,
							result: tool.result,
							isFailed: tool.failed,
							resultMeta: tool.failed ? `span status ${tool.span.statusCode}` : undefined,
							missingResultNote: missingResultNote(tool),
							keyPrefix: tool.key,
						})
					: []),
			],
		),
	])
}

/** `PayloadSection` (unbordered): a lane's task prompt or what a sub-agent returned. */
export const payloadSection = (
	h: H,
	model: Model,
	options: Readonly<{ label: string; payload: TranscriptPayload; textKey: string }>,
): Html => {
	const { payload } = options
	return h.div(
		[h.Class("flex flex-col gap-2 px-3 pt-2.5 pb-3")],
		[
			h.div(
				[h.Class("flex flex-wrap items-center gap-2")],
				[
					eyebrow(h, { variant: "mono" }, [options.label]),
					h.span(
						[h.Class("font-mono text-3xs text-muted-foreground")],
						[
							[
								formatBytes(payload.byteLength),
								...(payload.lineCount > 1 ? [`${payload.lineCount} lines`] : []),
							].join(" · "),
						],
					),
					...(payload.truncatedByEmitter ? [truncatedBadge(h)] : []),
					...payloadActions(h, model, {
						payload,
						textKey: options.textKey,
						label: options.label.toLowerCase(),
					}),
				],
			),
			...payloadBody(h, model, { payload, textKey: options.textKey, clampLines: 14 }),
			...(payload.truncatedByEmitter ? [truncatedNote(h)] : []),
		],
	)
}
