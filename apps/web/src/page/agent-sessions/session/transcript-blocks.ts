import type { TranscriptPayload, TranscriptRow } from "@maple/agent-sessions"
import { formatBytes, formatDuration } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { icon } from "@maple/views/ui/icon"
import { panel } from "@maple/views/ui/panel"
import { pressable } from "@maple/views/ui/pressable"
import { Message } from "./message"
import type { Model } from "./model"
import { disclosed } from "./payload-view"
import { payloadActions, payloadBody, toolIo, toolIoSummary, truncatedBadge, truncatedNote } from "./tool-io"
import { clockOf, META, ON_HOVER, row } from "./transcript-shell"
import { typography } from "@maple/views/ui/typography"
import { hstack, vstack } from "@maple/views/ui/stack"
import { Array as Arr, String as Str } from "effect"

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
	return pressable(
		h,
		{
			onClick: Message.ToggledRow({ key: `${tool.key}:payloads` }),
			className: "group flex h-8 w-full min-w-0 items-center gap-2 px-2.5 text-left",
			attributes: [h.AriaExpanded(isOpen), h.Title(clockOf(tool.startMs, timeZone))],
		},
		[
			icon(h, "GearIcon", {
				size: 12,
				className: cn("shrink-0", tool.failed ? "text-severity-error" : "text-chart-4"),
			}),
			typography(
				h,
				{
					size: "xs",
					tone: "foreground",
					weight: "medium",
					mono: true,
					truncate: true,
					className: "min-w-0",
					attributes: [h.Title(name)],
				},
				[name],
			),
			...(tool.fromMessageOnly
				? []
				: [h.span([h.Class(cn(META, "shrink-0"))], [formatDuration(tool.span.durationMs)])]),
			...(tool.failed && tool.span.genAi.errorType !== undefined
				? [
						typography(h, { size: "2xs", tone: "error", mono: true, className: "shrink-0" }, [
							tool.span.genAi.errorType,
						]),
					]
				: []),
			...(isOpen ? [] : [toolIoSummary(h, tool.args, tool.result)]),
			hstack(h, { gap: "2", align: "center", as: "span", className: "ml-auto shrink-0" }, [
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
			]),
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
					? "border-severity-error-a4 bg-severity-error-a1"
					: isOpen
						? "border-border bg-card"
						: "border-transparent bg-surface-sunken hover:bg-surface-strong active:bg-surface-strong",
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
	return vstack(h, { gap: "2", className: "px-3 pt-2.5 pb-3" }, [
		hstack(h, { gap: "2", wrap: true }, [
			eyebrow(h, { variant: "mono" }, [options.label]),
			typography(h, { size: "3xs", tone: "muted", mono: true }, [
				Arr.join(
					[
						formatBytes(payload.byteLength),
						...(payload.lineCount > 1 ? [`${payload.lineCount} lines`] : []),
					],
					" · ",
				),
			]),
			...(payload.truncatedByEmitter ? [truncatedBadge(h)] : []),
			...payloadActions(h, model, {
				payload,
				textKey: options.textKey,
				label: Str.toLowerCase(options.label),
			}),
		]),
		...payloadBody(h, model, { payload, textKey: options.textKey, clampLines: 14 }),
		...(payload.truncatedByEmitter ? [truncatedNote(h)] : []),
	])
}
