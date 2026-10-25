import type { TranscriptRow } from "@maple/agent-sessions"
import { cn } from "@maple/ui/lib/utils"
import { Stream } from "effect"
import { Mount } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { emptyMessage } from "../../../ui/empty"
import { virtualAttributes, virtualize } from "../kit/virtualize"
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

// The session transcript: the session as a conversation.

type H = HtmlBuilder<Message>

/** Starting guesses only: every mounted row is measured. */
const ROW_ESTIMATE = {
	turn: 38,
	"empty-turn": 30,
	user: 92,
	system: 42,
	assistant: 100,
	prompt: 130,
	thinking: 42,
	tool: 180,
	"lane-open": 44,
	"lane-close": 34,
	parallel: 34,
	"parallel-turns": 34,
	structure: 30,
	note: 86,
	divider: 60,
} satisfies Record<TranscriptRow["kind"], number>

/** `useVirtualizer` with `directDomUpdates`: rows measured, placed and the list sized off-render. */
const VirtualizeTranscript = Mount.defineStream("VirtualizeAgentSessionTranscript", {
	messages: [Message.ChangedTranscriptWindow],
	execute: ({ element, viewStateChanges }) =>
		viewStateChanges.pipe(
			Stream.switchMap((viewState) =>
				viewState === "Live" && element instanceof HTMLElement
					? virtualize(
							element,
							{
								overscan: 12,
								isMeasured: true,
								container: ":scope > div",
								rows: ":scope > div > [data-index]",
								isAnimationFrameResize: true,
							},
							(window) => Message.ChangedTranscriptWindow({ window }),
						)
					: Stream.never,
			),
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
	const mounted = model.transcriptWindow.items.flatMap((item) => {
		const row = rows[item.index]
		return row === undefined ? [] : [{ row, index: item.index }]
	})
	return h.div(
		[h.Class(cn(COLUMN, "pt-2"))],
		[
			h.div(
				[
					...virtualAttributes(
						h,
						rows.map((row) => row.key),
						rows.map((row) => ROW_ESTIMATE[row.kind]),
						model.scroll ?? undefined,
					),
					h.OnMount(VirtualizeTranscript()),
				],
				[
					h.div(
						[h.Class("relative w-full")],
						mounted.map(({ row, index }) =>
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
