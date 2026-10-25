import type { MarkdownDocument } from "@foldkit/markdown"
import { highlightCode } from "../../../lib/highlight"
import { cn } from "@maple/ui/lib/utils"
import { Effect, Queue, Schema, Stream } from "effect"
import { Mount } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { button } from "../../../ui/button"
import { type CodeActions, messageResponse } from "../../kit/message-response"

// Clamped text and its first line: a body clamped with a "Show full" control.

const CLAMP_CLASSES = {
	6: "line-clamp-[6]",
	8: "line-clamp-[8]",
	12: "line-clamp-[12]",
	14: "line-clamp-[14]",
	24: "line-clamp-[24]",
} as const

export type ClampLines = keyof typeof CLAMP_CLASSES

const PREVIEW_LINES = 72
const PREVIEW_CHARS = 8_000
const RENDER_LIMIT_CHARS = 200_000

export type ClampedRendering = "text" | "json" | "md"

/** The prefix of `text` a clamped body mounts: 72 lines or 8000 characters, whichever ends first. */
export const previewOf = (text: string): string => {
	const limit = Math.min(text.length, PREVIEW_CHARS)
	const breaks = text.slice(0, limit).split("\n")
	if (breaks.length <= PREVIEW_LINES) return limit === text.length ? text : text.slice(0, limit)
	return breaks.slice(0, PREVIEW_LINES).join("\n")
}

const exceedsLines = (text: string, lines: number): boolean => text.split("\n", lines + 1).length > lines

/** The first non-blank line, trimmed: a collapsed disclosure's preview. */
export const firstLine = (text: string): string =>
	text
		.split("\n")
		.find((line) => line.trim() !== "")
		?.trim() ?? ""

const ClampMessage = defineMessageUnion({ MeasuredClamp: { isClamped: Schema.Boolean } })
type MeasuredClamp = typeof ClampMessage.MeasuredClamp.Type

/** Whether the body overruns its clamp, on mount and on every resize: markdown and short bodies only. */
export const MeasureClamp = Mount.defineStream("MeasureAgentSessionClamp", {
	messages: [ClampMessage.MeasuredClamp],
	execute: ({ element }) =>
		Stream.callback<MeasuredClamp>((queue) =>
			Effect.acquireRelease(
				Effect.sync(() => {
					const observer = new ResizeObserver(() => {
						if (element instanceof HTMLElement)
							Queue.offerUnsafe(
								queue,
								ClampMessage.MeasuredClamp({
									isClamped: element.scrollHeight > element.clientHeight + 1,
								}),
							)
					})
					observer.observe(element)
					return observer
				}),
				(observer) => Effect.sync(() => observer.disconnect()),
			).pipe(Effect.andThen(Effect.never)),
		),
})

export type ClampedTextOptions<M> = Readonly<{
	text: string
	rendering?: ClampedRendering
	isMono?: boolean
	clampLines?: ClampLines
	toneClass?: string
	proseClassName?: string
	isExpanded: boolean
	onToggleExpanded: M
	/** The parse of a markdown body, `null` while it is loading or when the text was rejected. */
	markdown?: (text: string) => MarkdownDocument | null
	/** A measured overflow, reported back by `MeasureClamp`. */
	isMeasuredClamped: boolean
	onMeasured: (isClamped: boolean) => M
	/** A markdown body's code blocks: what their Copy and Download buttons send. */
	codeActions?: CodeActions<M>
}>

export const clampedText = <M>(h: HtmlBuilder<M>, options: ClampedTextOptions<M>): Html => {
	const { text, isExpanded } = options
	const rendering = options.rendering ?? "text"
	const clampLines = options.clampLines ?? 12
	const shown = isExpanded ? text : previewOf(text)
	const isCut = shown.length < text.length
	const effective = rendering !== "text" && shown.length > RENDER_LIMIT_CHARS ? "text" : rendering
	const isKnownClamped = isCut || (effective !== "md" && exceedsLines(shown, clampLines))
	const isClamped = isKnownClamped || options.isMeasuredClamped
	const proseClassName = options.proseClassName ?? "text-foreground text-sm leading-relaxed"
	const body =
		effective === "md"
			? [
					messageResponse(
						h,
						options.markdown?.(shown) ?? null,
						shown,
						proseClassName,
						options.codeActions,
					),
				]
			: effective === "json"
				? []
				: [shown]
	return h.div(
		[h.Class("min-w-0")],
		[
			h.div(
				[
					h.Class(
						cn(
							effective !== "md" && "whitespace-pre-wrap",
							"break-words",
							options.isMono === true
								? "font-mono text-muted-foreground text-xs leading-relaxed"
								: "max-w-[70rem] text-foreground text-sm leading-relaxed",
							options.toneClass,
							!isExpanded && CLAMP_CLASSES[clampLines],
						),
					),
					...(effective === "json" ? [h.InnerHTML(highlightCode(shown, "json"))] : []),
					...(isExpanded || isKnownClamped
						? []
						: [
								h.OnMount(
									Mount.mapMessage(MeasureClamp(), ({ isClamped }) =>
										options.onMeasured(isClamped),
									),
								),
							]),
				],
				body,
			),
			...(isClamped || isExpanded
				? [
						button(
							h,
							{
								variant: "link",
								size: "xs",
								className:
									"mt-1 h-auto p-0 text-muted-foreground text-xs hover:text-foreground",
								attributes: [h.AriaExpanded(isExpanded), h.OnClick(options.onToggleExpanded)],
							},
							[isExpanded ? "Show less" : "Show full"],
						),
					]
				: []),
		],
	)
}
