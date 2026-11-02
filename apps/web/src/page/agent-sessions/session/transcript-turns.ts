import { formatCost, type SessionTurn, tokenFlowLabel, type TranscriptRow } from "@maple/agent-sessions"
import { countLabel, formatDuration } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { heading } from "../../../ui/heading"
import { icon } from "../../../ui/icon"
import { pressable } from "../../../ui/pressable"
import { Message } from "./message"
import { clockOf, indentLanes, META, row } from "./transcript-shell"
import { failedBadge } from "./view-kit"

// The transcript's turn chapters (`TurnChapter`, `EmptyTurnRow`, `summariseTurn`).

type H = HtmlBuilder<Message>

export const turnOrdinal = (turn: SessionTurn): string =>
	`${turn.anchorKind === "trace" ? "Segment" : "Turn"} ${turn.index}`

const summariseTurn = (chapter: Extract<TranscriptRow, { kind: "turn" }>): string =>
	[
		countLabel(chapter.llmCalls, "LLM call"),
		...(chapter.toolNames.length > 0 ? [chapter.toolNames.join(", ")] : []),
	].join(" · ")

const rule = (h: H): Html => h.span([h.AriaHidden(true), h.Class("h-px grow bg-border-subtle")], [])

export const turnChapter = (
	h: H,
	chapter: Extract<TranscriptRow, { kind: "turn" }>,
	timeZone: string,
	isCollapsed: boolean,
): Html => {
	const { turn } = chapter
	const detail = [
		turn.agentName,
		countLabel(turn.traceIds.length, "trace"),
		`${chapter.aiSpanCount} agent spans`,
	]
		.filter((part) => part !== undefined)
		.join(" · ")
	return heading(
		h,
		{ level: 3, variant: "subsection", className: "mt-7 flex items-center px-2 pb-1" },
		[
			...indentLanes(h, chapter.depth),
			pressable(
				h,
				{
					onClick: Message.ToggledTurn({ turnId: turn.id }),
					// The chapter's own spans set their type; the weight they inherit stays normal.
					className: cn(
						"group/turn flex min-w-0 max-w-[924px] flex-1 items-center gap-2.5 rounded-xs text-left font-normal",
						"focus-visible:ring-ring focus-visible:ring-inset",
					),
					attributes: [h.AriaExpanded(!isCollapsed), h.Title(detail)],
				},
				[
					...(isCollapsed ? [] : [rule(h)]),
					isCollapsed
						? icon(h, "ChevronRightIcon", {
								size: 12,
								className: "shrink-0 text-muted-foreground",
							})
						: icon(h, "ChevronDownIcon", {
								size: 12,
								className:
									"shrink-0 text-muted-foreground opacity-0 group-hover/turn:opacity-100",
							}),
					h.span(
						[
							h.Class(
								"shrink-0 font-medium text-muted-foreground text-xs group-hover/turn:text-foreground",
							),
						],
						[turnOrdinal(turn)],
					),
					...(turn.failed ? [failedBadge(h)] : []),
					...(isCollapsed
						? [
								h.span(
									[h.Class("min-w-0 shrink truncate text-ui text-foreground")],
									[
										turn.label ??
											h.span(
												[h.Class("text-muted-foreground italic")],
												["no prompt captured"],
											),
									],
								),
								h.span([h.Class(cn(META, "grow basis-0"))], [summariseTurn(chapter)]),
							]
						: []),
					h.span(
						[h.Class(cn(META, "shrink-0"))],
						[
							...(chapter.usage.tokens.total > 0
								? [`${tokenFlowLabel(chapter.usage.tokens)} · `]
								: []),
							...(chapter.usage.cost === undefined
								? []
								: [`${formatCost(chapter.usage.cost)} · `]),
							clockOf(turn.startMs, timeZone),
							" · ",
							formatDuration(turn.durationMs),
						],
					),
					...(isCollapsed ? [] : [rule(h)]),
				],
			),
		],
	)
}

export const emptyTurnRow = (h: H, chapter: Extract<TranscriptRow, { kind: "empty-turn" }>): Html =>
	row(h, { depth: chapter.depth, className: "pt-2", isFlush: true }, [
		h.div(
			[h.Class("flex items-center gap-2.5 text-muted-foreground")],
			[
				icon(h, "DotsIcon", { size: 14, className: "shrink-0" }),
				h.span([h.Class("shrink-0 font-semibold text-xs")], [turnOrdinal(chapter.turn)]),
				h.span(
					[h.Class("min-w-0 truncate text-xs")],
					["no agent activity (HTTP/DB work only, see Traces)"],
				),
				h.span([h.AriaHidden(true), h.Class("h-px grow bg-border")], []),
			],
		),
	])
