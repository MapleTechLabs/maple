import type { TranscriptRow } from "@maple/agent-sessions"
import { cn } from "@maple/ui/lib/utils"
import { Effect, Stream } from "effect"
import { Mount } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { emptyMessage } from "../../../ui/empty"
import type { SessionData } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { toolBlock } from "./transcript-blocks"
import { assistantBlock, promptBlock, structureRow } from "./transcript-calls"
import {
	dividerBlock,
	laneClose,
	laneOpen,
	noteBlock,
	parallelMarker,
	parallelTurnsMarker,
} from "./transcript-lanes"
import { systemBlock, thinkingBlock, userBlock } from "./transcript-messages"
import { continuedKeys, transcriptRows } from "./transcript-rows"
import { COLUMN } from "./transcript-shell"
import { emptyTurnRow, turnChapter } from "./transcript-turns"

// `SessionTranscript` (session-detail/session-transcript.tsx): the session as a conversation.
// TODO(virtualize): every row is drawn and placed; legacy mounts only the rows near the viewport.
// TODO(span-landing): a pasted `?span=` link does not scroll its block into view.

type H = HtmlBuilder<Message>

/**
 * The virtualizer's placement, every row drawn: each row measured (rounded, as `measureElement`
 * rounds), stacked by transform, and the list sized to their sum. Written to the DOM like
 * `directDomUpdates`, so a row resize never re-renders the list.
 */
const PlaceTranscriptRows = Mount.defineStream("PlaceAgentSessionTranscriptRows", {
	messages: [Message.CompletedScroll],
	execute: ({ element }) =>
		Stream.callback<typeof Message.CompletedScroll.Type>(() =>
			Effect.acquireRelease(
				Effect.sync(() => {
					const place = () => {
						if (!(element instanceof HTMLElement)) return
						const rows = Array.from(element.children).filter(
							(child) => child instanceof HTMLElement,
						)
						const total = rows.reduce((top, row) => {
							row.style.transform = `translate3d(0px, ${top}px, 0px)`
							return top + Math.round(row.getBoundingClientRect().height)
						}, 0)
						element.style.height = `${total}px`
					}
					const resizes = new ResizeObserver(place)
					const observeRows = () => {
						resizes.disconnect()
						Array.from(element.children).forEach((child) => resizes.observe(child))
						place()
					}
					const additions = new MutationObserver(observeRows)
					additions.observe(element, { childList: true })
					observeRows()
					return () => {
						additions.disconnect()
						resizes.disconnect()
					}
				}),
				(release) => Effect.sync(release),
			).pipe(Effect.andThen(Effect.never)),
		),
})

type BlockContext = Readonly<{
	model: Model
	data: SessionData
	timeZone: string
	continued: ReadonlySet<string>
}>

const isSelectedRow = (model: Model, row: TranscriptRow): boolean =>
	"span" in row && row.span.spanId === model.search.span

const block = (h: H, context: BlockContext, row: TranscriptRow): Html => {
	const { model, timeZone } = context
	const callState = {
		isContinued: context.continued.has(row.key),
		isSelected: isSelectedRow(model, row),
		timeZone,
	}
	switch (row.kind) {
		case "turn":
			return turnChapter(h, row, timeZone, model.collapsedTurns.includes(row.turn.id))
		case "empty-turn":
			return emptyTurnRow(h, row)
		case "user":
			return userBlock(h, model, row, timeZone)
		case "system":
			return systemBlock(h, model, row)
		case "assistant":
			return assistantBlock(h, model, row, callState)
		case "prompt":
			return promptBlock(h, model, row, timeZone)
		case "thinking":
			return thinkingBlock(h, model, row, timeZone)
		case "tool":
			return toolBlock(h, model, row, timeZone)
		case "lane-open":
			return laneOpen(h, model, row, timeZone)
		case "lane-close":
			return laneClose(h, model, row)
		case "parallel":
			return parallelMarker(h, row, timeZone)
		case "parallel-turns":
			return parallelTurnsMarker(h, row, timeZone)
		case "structure":
			return structureRow(h, row, callState)
		case "note":
			return noteBlock(h, row)
		case "divider":
			return dividerBlock(h, row, context.data.progress, timeZone)
	}
}

export const transcript = (h: H, model: Model, data: SessionData, timeZone: string): Html => {
	const rows = transcriptRows(model, data)
	if (rows.length === 0)
		return emptyMessage(h, {}, [
			model.query.trim() === ""
				? "No AI activity in this session. Its spans are HTTP and database work, which the transcript excludes. The Traces view shows them."
				: "No blocks match this filter.",
		])
	const context: BlockContext = { model, data, timeZone, continued: continuedKeys(rows) }
	return h.div(
		[h.Class(cn(COLUMN, "pt-2"))],
		[
			h.div(
				[],
				[
					h.div(
						[h.Class("relative w-full"), h.OnMount(PlaceTranscriptRows())],
						rows.map((row, index) =>
							h.div(
								[
									h.Key(row.key),
									h.DataAttribute("index", String(index)),
									h.DataAttribute("slot", "transcript-row"),
									h.Class("absolute inset-x-0 top-0"),
								],
								[block(h, context, row)],
							),
						),
					),
				],
			),
		],
	)
}
