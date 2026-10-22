import type { MarkdownDocument } from "@foldkit/markdown"
import type { AnnotationSegment } from "@maple/domain/chat-annotations"
import { stripChatContext } from "@maple/domain/chat-preamble"
import { formatTimestampInTimezone } from "@maple/web-data/lib/timezone-format"
import { cn } from "@maple/ui/lib/utils"
import {
	messageScrollerButtonIconStyles,
	messageScrollerButtonLabelStyles,
	messageScrollerButtonStyles,
	messageScrollerContentStyles,
	messageScrollerItemStyles,
	messageScrollerStyles,
	messageScrollerViewportStyles,
} from "@maple/ui/styles/ui/message-scroller"
import { markerVariants } from "@maple/ui/styles/ui/marker"
import type { Html, HtmlBuilder } from "foldkit/html"
import { messageResponse, type ViewOverrides } from "../../kit/message-response"
import { bubble, bubbleContent } from "../../../ui/bubble"
import { button } from "../../../ui/button"
import * as CopyButton from "../../../ui/copy-button"
import { icon } from "../../../ui/icon"
import { marker, markerContent, markerIcon } from "../../../ui/marker"
import { message as messageRow, messageContent, messageFooter } from "../../../ui/message"
import { dotLoader } from "./dot-loader"
import { type MinimapState, turnMinimap } from "./turn-minimap"
import { richTextSegments, transcriptMarkdown } from "./rich-text"
import {
	buildTranscriptRows,
	isMachineTurn,
	isToolPart,
	messageText,
	rendersOwnCard,
	showsThinkingRow,
	toolPartsOf,
} from "./transcript-rows"
import type { ToolPart, UIMessage, UIMessagePart } from "./ui-message"
import { type PanelHost, runningClock, toolNodes, toolStandalone } from "./view-tool"

// The transcript: the scrolling thread.

export type MarkdownCache = Readonly<
	Record<string, { readonly document: MarkdownDocument | null; readonly isStale: boolean }>
>

/** Everything a transcript needs from its host besides the messages. */
export type TranscriptHost<M> = PanelHost<M> &
	Readonly<{
		markdown: MarkdownCache
		timeZone: string
		isLoading: boolean
		readOnly: "shared" | "resolved" | "transcript" | null
		/** Copy status by button id (`copy:<messageId>`, `link:<messageId>`). */
		copies: Readonly<Record<string, CopyButton.Model>>
		onCopy: (id: string, message: CopyButton.Message) => M
		permalinkFor?: (messageId: string) => string
		/** Cards the transcript does not own: inline `<<maple:…>>` cards, approvals, sub-agents. */
		/** The autoscroll Mount (`MountMessageScroller()`), typed for the host's Message. */
		scrollerMount: Parameters<HtmlBuilder<M>["OnMount"]>[0]
		/** The turn rail's state and its Mount (`MountTurnMinimap` lifted to the host). */
		minimap: MinimapState
		minimapMount: Parameters<HtmlBuilder<M>["OnMount"]>[0]
		inlineCard?: (segment: Exclude<AnnotationSegment, { type: "text" }>) => Html
		ownCard?: (part: ToolPart, messageId: string) => Html | null
		/** A sub-agent row; `draw` renders its answer and steps the way the thread does. */
		taskCard?: (
			part: Extract<UIMessagePart, { _tag: "task" }>,
			draw: Readonly<{ richText: (text: string) => Html; tool: (part: ToolPart) => Html }>,
		) => Html
		markdownOverrides?: ViewOverrides
		/** `fallbackDiagnosis`: the report card an investigation thread leads with until its own turn lands. */
		fallback?: Html
		/** `JumpToDiagnosis`: the thread's `submit_diagnosis` turn and the Mount (`MountJumpToMessage`). */
		jump?: Readonly<{ messageId: string; mount: Parameters<HtmlBuilder<M>["OnMount"]>[0] }>
	}>

const TRANSCRIPT_ITEM = "[content-visibility:visible] [contain-intrinsic-size:none]"
const PART_STACK = "flex flex-col gap-2"

const READ_ONLY_LABEL = new Map([
	["shared", "Shared conversation · read-only"],
	["resolved", "Investigation resolved · read-only"],
	["transcript", "Agent reasoning log · read-only"],
])

const markdownBody = <M>(
	h: HtmlBuilder<M>,
	host: TranscriptHost<M>,
	text: string,
	className?: string,
): Html =>
	messageResponse(
		h,
		host.markdown[text]?.document ?? null,
		text,
		className,
		undefined,
		host.markdownOverrides,
	)

/** `RichText`: markdown, split at inline cards when the text carries any. */
export const richText = <M>(h: HtmlBuilder<M>, host: TranscriptHost<M>, text: string): Html => {
	const body = richTextSegments(text)
	if (body._tag === "Plain") return markdownBody(h, host, text)
	return h.div(
		[h.Class("flex flex-col gap-2")],
		body.segments.flatMap((segment) => {
			if (segment.type === "text")
				return segment.content.trim() === "" ? [] : [markdownBody(h, host, segment.content)]
			return host.inlineCard === undefined ? [] : [host.inlineCard(segment)]
		}),
	)
}

/** Message parts to nodes; consecutive tool calls collapse into one group. */
const messageParts = <M>(
	h: HtmlBuilder<M>,
	host: TranscriptHost<M>,
	message: UIMessage,
): ReadonlyArray<Html> => {
	const { nodes, buffer } = message.parts.reduce<{
		nodes: ReadonlyArray<Html>
		buffer: ReadonlyArray<ToolPart>
	}>(
		(acc, part, index) => {
			const flushed = [...acc.nodes, ...toolNodes(h, acc.buffer, `tool-${acc.nodes.length}`, host)]
			if (part._tag === "text") {
				const text = stripChatContext(part.text)
				return { nodes: text === "" ? flushed : [...flushed, richText(h, host, text)], buffer: [] }
			}
			if (part._tag === "task")
				return {
					nodes:
						host.taskCard === undefined
							? flushed
							: [
									...flushed,
									host.taskCard(part, {
										richText: (text) => richText(h, host, text),
										tool: (leaf) => toolStandalone(h, leaf, host),
									}),
								],
					buffer: [],
				}
			if (!isToolPart(part)) return acc
			if (rendersOwnCard(part)) {
				const card = host.ownCard?.(part, `${message.id}:${index}`) ?? null
				return { nodes: card === null ? flushed : [...flushed, card], buffer: [] }
			}
			return { nodes: acc.nodes, buffer: [...acc.buffer, part] }
		},
		{ nodes: [], buffer: [] },
	)
	return [...nodes, ...toolNodes(h, buffer, `tool-${nodes.length}`, host)]
}

/** `StatusMarker`: the live "Thinking…" row. */
export const statusMarker = <M>(
	h: HtmlBuilder<M>,
	label = "Thinking…",
	clockMount?: PanelHost<M>["clockMount"],
): Html =>
	h.div(
		[
			h.Class(cn(markerVariants({ variant: "default", className: "text-xs" }))),
			h.DataAttribute("slot", "marker"),
			h.DataAttribute("variant", "default"),
			h.Role("status"),
		],
		[
			markerIcon(h, [dotLoader(h)], "size-5"),
			markerContent(
				h,
				[h.span([h.Class("shimmer")], [label]), ...runningClock(h, clockMount)],
				"flex items-center gap-2",
			),
		],
	)

/** Keyed by message id, so the scroller sees rows added, never patched in place. */
const scrollerItem = <M>(
	h: HtmlBuilder<M>,
	id: string,
	isAnchor: boolean,
	children: ReadonlyArray<Html>,
): Html =>
	h.keyed("div")(
		id,
		[
			h.Class(cn(messageScrollerItemStyles, TRANSCRIPT_ITEM)),
			h.DataAttribute("message-id", id),
			h.DataAttribute("scroll-anchor", String(isAnchor)),
			h.DataAttribute("slot", "message-scroller-item"),
		],
		children,
	)

const separator = <M>(h: HtmlBuilder<M>, text: string): Html =>
	marker(h, { variant: "separator" }, [markerContent(h, [text])])

const messageActions = <M>(h: HtmlBuilder<M>, host: TranscriptHost<M>, message: UIMessage): Html => {
	const text = messageText(message)
	const permalink = host.permalinkFor?.(message.id)
	const copy = (id: string, value: string, label: string, idleIcon?: "LinkIcon") =>
		CopyButton.view(h, {
			model: host.copies[id] ?? CopyButton.init(),
			toParentMessage: (child) => host.onCopy(id, child),
			value,
			label,
			size: "icon-xs",
			iconSize: 12,
			className: "size-5",
			idleIcon,
		})
	return h.div(
		[
			h.Class(
				"-my-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover/message:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100",
			),
		],
		[
			...(text === "" ? [] : [copy(`copy:${message.id}`, text, "Message")]),
			...(permalink === undefined
				? []
				: [copy(`link:${message.id}`, permalink, "Link to message", "LinkIcon")]),
			...(message.createdAt === undefined
				? []
				: [
						h.time(
							[
								h.Attribute("datetime", new Date(message.createdAt).toISOString()),
								h.Title(
									formatTimestampInTimezone(message.createdAt, {
										timeZone: host.timeZone,
										withYear: true,
									}),
								),
								h.Class("ml-1 text-2xs text-muted-foreground tabular-nums"),
							],
							[
								formatTimestampInTimezone(message.createdAt, {
									timeZone: host.timeZone,
									style: "range",
								}),
							],
						),
					]),
		],
	)
}

const messageItem = <M>(
	h: HtmlBuilder<M>,
	host: TranscriptHost<M>,
	message: UIMessage,
	showThinking: boolean,
): Html => {
	const isUser = message.role === "user"
	if (isUser && isMachineTurn(message))
		return scrollerItem(h, message.id, false, [separator(h, "Investigation started")])
	return scrollerItem(h, message.id, isUser, [
		messageRow(h, { align: isUser ? "end" : "start", className: "text-sm" }, [
			messageContent(h, [
				bubble(h, { variant: isUser ? "secondary" : "ghost", align: isUser ? "end" : "start" }, [
					bubbleContent(
						h,
						[
							h.div(
								[h.Class(PART_STACK)],
								[
									...messageParts(h, host, message),
									...(showThinking ? [statusMarker(h, undefined, host.clockMount)] : []),
								],
							),
						],
						isUser ? "rounded-lg px-3.5 py-2.5 text-sm" : "text-sm",
					),
				]),
				...(isUser || messageText(message) === ""
					? []
					: [messageFooter(h, [messageActions(h, host, message)], "-mt-1")]),
			]),
		]),
	])
}

const toolRunItem = <M>(
	h: HtmlBuilder<M>,
	host: TranscriptHost<M>,
	id: string,
	messages: ReadonlyArray<UIMessage>,
	showThinking: boolean,
): Html =>
	scrollerItem(h, id, false, [
		messageRow(h, { align: "start", className: "text-sm" }, [
			messageContent(h, [
				bubble(h, { variant: "ghost", align: "start" }, [
					bubbleContent(
						h,
						[
							h.div(
								[h.Class(PART_STACK)],
								[
									...toolNodes(h, toolPartsOf(messages), id, host),
									...(showThinking ? [statusMarker(h, undefined, host.clockMount)] : []),
								],
							),
						],
						"text-sm",
					),
				]),
			]),
		]),
	])

const scrollButton = <M>(h: HtmlBuilder<M>): Html =>
	button(
		h,
		{
			variant: "secondary",
			size: "icon-sm",
			className: messageScrollerButtonStyles,
			slot: "message-scroller-button",
			attributes: [
				h.DataAttribute("active", "false"),
				h.DataAttribute("direction", "end"),
				h.DataAttribute("size", "icon-sm"),
				h.DataAttribute("variant", "secondary"),
				h.Attribute("inert", ""),
				h.Tabindex(-1),
			],
		},
		[
			icon(h, "ArrowDownIcon", { className: messageScrollerButtonIconStyles }),
			h.span([h.Class(messageScrollerButtonLabelStyles)], ["Scroll to end"]),
		],
	)

/** `JumpToDiagnosis`: back to the report once it scrolled away (its Mount shows and presses it). */
const jumpButton = <M>(
	h: HtmlBuilder<M>,
	messageId: string,
	mount: Parameters<HtmlBuilder<M>["OnMount"]>[0],
): Html =>
	h.keyed("div")(
		`jump:${messageId}`,
		[h.Class("contents")],
		[
			button(
				h,
				{
					size: "sm",
					variant: "outline",
					className: "absolute bottom-4 start-4 max-w-[45%] rounded-full bg-background shadow-sm",
					attributes: [h.OnMount(mount)],
				},
				[icon(h, "PulseIcon"), h.span([h.Class("truncate")], ["Jump to diagnosis"])],
			),
		],
	)

/** The thread, or `emptyState` centred in its place while there is nothing to scroll. */
export const transcript = <M>(
	h: HtmlBuilder<M>,
	host: TranscriptHost<M>,
	messages: ReadonlyArray<UIMessage>,
	emptyState: () => Html,
): Html => {
	if (messages.length === 0 && host.fallback === undefined)
		return h.keyed("div")(
			"transcript-empty",
			[h.Class("flex min-h-0 flex-1 items-center justify-center px-4 py-6")],
			[emptyState()],
		)
	const last = messages[messages.length - 1]
	const awaitingFirstToken = host.isLoading && last?.role === "user"
	const rows = buildTranscriptRows(messages)
	const readOnlyLabel = host.readOnly === null ? undefined : READ_ONLY_LABEL.get(host.readOnly)
	const isMarkdownPending = transcriptMarkdown(messages).some(
		(text) => host.markdown[text]?.isStale ?? true,
	)
	// Keyed apart from the empty state: patched in place, the scroller's Mount would never run.
	return h.keyed("div")(
		"transcript-scroller",
		[
			h.Class(cn(messageScrollerStyles, "min-h-0 flex-1")),
			h.DataAttribute("slot", "message-scroller"),
			h.OnMount(host.scrollerMount),
		],
		[
			h.div(
				[
					h.AriaLabel("Messages"),
					h.Class(messageScrollerViewportStyles),
					h.DataAttribute("slot", "message-scroller-viewport"),
					h.Role("region"),
					h.Tabindex(0),
				],
				[
					h.div(
						[
							h.Attribute("aria-relevant", "additions"),
							h.Class(
								cn(messageScrollerContentStyles, "mx-auto w-full max-w-3xl gap-4 px-4 py-6"),
							),
							h.DataAttribute("slot", "message-scroller-content"),
							...(isMarkdownPending ? [h.DataAttribute("markdown-pending", "")] : []),
							h.Role("log"),
						],
						[
							...(readOnlyLabel === undefined
								? []
								: [scrollerItem(h, "__read-only", false, [separator(h, readOnlyLabel)])]),
							...(host.fallback === undefined
								? []
								: [scrollerItem(h, "__fallback-diagnosis", false, [host.fallback])]),
							...rows.map((row) => {
								if (row.kind === "tool-run") {
									const lastOfRun = row.messages[row.messages.length - 1]
									const thinking =
										lastOfRun !== undefined &&
										showsThinkingRow(lastOfRun, host.isLoading, lastOfRun.id === last?.id)
									return toolRunItem(h, host, row.id, row.messages, thinking)
								}
								return messageItem(
									h,
									host,
									row.message,
									showsThinkingRow(
										row.message,
										host.isLoading,
										row.message.id === last?.id,
									),
								)
							}),
							...(awaitingFirstToken
								? [
										scrollerItem(h, "__status", false, [
											statusMarker(h, undefined, host.clockMount),
										]),
									]
								: []),
							h.keyed("div")(
								"__spacer",
								[
									h.AriaHidden(true),
									h.DataAttribute("message-scroller-spacer", ""),
									h.Attribute("hidden", ""),
								],
								[],
							),
						],
					),
				],
			),
			turnMinimap(h, rows, host.minimap, host.minimapMount),
			scrollButton(h),
			...(host.jump === undefined ? [] : [jumpButton(h, host.jump.messageId, host.jump.mount)]),
		],
	)
}
