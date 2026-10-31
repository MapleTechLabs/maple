import { stripChatContext } from "@maple/domain/chat-preamble"
import { cn } from "@maple/ui/lib/utils"
import { Option, Schema } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { icon } from "../../../../ui/icon"
import { iconButton } from "../../../../ui/icon-button"
import { isMachineTurn, messageText, type TranscriptRow } from "./transcript-rows"

// The turn minimap: one marker per human turn down the transcript's gutter, lit while its turn
// is on screen; hovering previews a turn, a click jumps. The pointer, keyboard and scrolling
// live in `MountTurnMinimap` (`turn-minimap-mount.ts`).

const ITEM_SPACING_PX = 8
const MAX_HEIGHT_CSS = "calc(100% - 6rem)"
const CONTENT_MAX_WIDTH_PX = 768
const PERSISTENT_GUTTER_PX = 48
const HIT_STRIP_INSET_PX = 12
const HIT_STRIP_MAX_WIDTH_PX = 40
const EXPANDED_HIT_STRIP_WIDTH = "22rem"
export const TURN_MINIMAP_MIN_ITEMS = 2

export type TurnItem = Readonly<{ id: string; userText: string | null; assistantText: string | null }>

const compactPreview = (text: string): string | null => {
	const compact = text.replace(/\s+/gu, " ").trim()
	return compact.length > 0 ? compact : null
}

/** One item per human turn, with the first reply's text; every row maps to its turn. */
export const deriveTurnMinimap = (
	rows: ReadonlyArray<TranscriptRow>,
): Readonly<{ items: ReadonlyArray<TurnItem>; turnByRowId: ReadonlyMap<string, number> }> => {
	const items = rows.reduce<ReadonlyArray<TurnItem>>((acc, row) => {
		if (row.kind !== "message") return acc
		if (row.message.role === "user" && !isMachineTurn(row.message))
			return [
				...acc,
				{
					id: row.id,
					userText: compactPreview(stripChatContext(messageText(row.message))),
					assistantText: null,
				},
			]
		const current = acc[acc.length - 1]
		const text = row.message.role === "assistant" ? compactPreview(messageText(row.message)) : null
		return current !== undefined && text !== null
			? [...acc.slice(0, -1), { ...current, assistantText: text }]
			: acc
	}, [])
	const turnByRowId = new Map(
		rows.flatMap((row, index) => {
			const turns = deriveTurnCount(rows.slice(0, index + 1))
			return turns > 0 ? [[row.id, turns - 1] as const] : []
		}),
	)
	return { items, turnByRowId }
}

const deriveTurnCount = (rows: ReadonlyArray<TranscriptRow>): number =>
	rows.filter((row) => row.kind === "message" && row.message.role === "user" && !isMachineTurn(row.message))
		.length

const resolveCurrentTurnIndex = (
	visibleIds: ReadonlyArray<string>,
	turnByRowId: ReadonlyMap<string, number>,
): number | null =>
	visibleIds.reduce<number | null>((current, id) => {
		const index = turnByRowId.get(id)
		return index === undefined ? current : current === null || index < current ? index : current
	}, null)

const minimapHeightStyle = (count: number): string =>
	`min(${Math.max(1, (count - 1) * ITEM_SPACING_PX)}px, ${MAX_HEIGHT_CSS})`

export const minimapTopPercent = (index: number, count: number): number =>
	count <= 1 ? 0 : (Math.max(0, Math.min(index, count - 1)) / (count - 1)) * 100

const sideGutterPx = (width: number): number =>
	Math.max(0, (width - Math.min(width, CONTENT_MAX_WIDTH_PX)) / 2)

const hasPersistentGutter = (width: number): boolean =>
	Number.isFinite(width) && width > 0 && sideGutterPx(width) >= PERSISTENT_GUTTER_PX

const hitStripWidth = (width: number): number =>
	!Number.isFinite(width) || width <= 0
		? 0
		: Math.max(0, Math.min(HIT_STRIP_MAX_WIDTH_PX, Math.floor(sideGutterPx(width)) - HIT_STRIP_INSET_PX))

const previewTranslate = (index: number, count: number): string =>
	index <= 0 ? "0%" : index >= count - 1 ? "-100%" : "-50%"

/** What the rail knows about the page: its width and the rows on screen. */
export const MinimapState = Schema.Struct({
	railWidth: Schema.Number,
	visibleIds: Schema.Array(Schema.String),
	/** The previewed turn (pointer or keyboard), `null` when none. */
	activeIndex: Schema.NullOr(Schema.Number),
})
export type MinimapState = typeof MinimapState.Type

export const initMinimap = (): MinimapState => ({ railWidth: 0, visibleIds: [], activeIndex: null })

export const MinimapMessage = defineMessageUnion({
	MeasuredMinimapRail: { width: Schema.Number },
	ChangedVisibleRows: { ids: Schema.Array(Schema.String) },
	PreviewedTurn: { index: Schema.NullOr(Schema.Number) },
})
export type MinimapMessage = typeof MinimapMessage.Type

export const updateMinimap = (state: MinimapState, message: MinimapMessage): MinimapState =>
	MinimapMessage.match(message, {
		MeasuredMinimapRail: ({ width }) => ({ ...state, railWidth: width }),
		ChangedVisibleRows: ({ ids }) => ({ ...state, visibleIds: ids }),
		PreviewedTurn: ({ index }) => ({ ...state, activeIndex: index }),
	})

const step = <M>(h: HtmlBuilder<M>, direction: "previous" | "next", target: Option.Option<string>): Html => {
	const previous = direction === "previous"
	return h.span(
		[
			h.Class(
				cn(
					"pointer-events-auto absolute start-0 z-10 inline-flex opacity-0 transition-opacity duration-150 focus-within:opacity-100 hover:opacity-100 active:opacity-100",
					previous ? "bottom-[calc(100%+4px)]" : "top-[calc(100%+4px)]",
				),
			),
		],
		[
			iconButton(
				h,
				{
					label: previous ? "Previous turn" : "Next turn",
					hasTooltip: false,
					size: "icon-xs",
					isDisabled: Option.isNone(target),
					attributes: Option.match(target, {
						onNone: () => [],
						onSome: (id) => [h.DataAttribute("turn-target", id)],
					}),
				},
				[icon(h, previous ? "ChevronUpIcon" : "ChevronDownIcon", { className: "size-3.5" })],
			),
		],
	)
}

const markerWidth = (distance: number | null): string =>
	distance === 0 ? "w-6 bg-foreground-subtle" : distance === 1 ? "w-4" : distance === 2 ? "w-2.5" : "w-2"

/** The rail, or nothing below two turns. `mount` is `MountTurnMinimap` lifted to the host. */
export const turnMinimap = <M>(
	h: HtmlBuilder<M>,
	rows: ReadonlyArray<TranscriptRow>,
	state: MinimapState,
	mount: Parameters<HtmlBuilder<M>["OnMount"]>[0],
): Html => {
	const { items, turnByRowId } = deriveTurnMinimap(rows)
	if (items.length < TURN_MINIMAP_MIN_ITEMS) return h.empty
	const currentIndex = resolveCurrentTurnIndex(state.visibleIds, turnByRowId)
	const visibleTurns = new Set(
		state.visibleIds.flatMap((id) => Option.toArray(Option.fromNullishOr(turnByRowId.get(id)))),
	)
	const active = state.activeIndex !== null && state.activeIndex < items.length ? state.activeIndex : null
	const activeItem = active === null ? undefined : items[active]
	const strip = hitStripWidth(state.railWidth)
	const neighbour = (offset: number) =>
		currentIndex === null
			? Option.none()
			: Option.map(Option.fromNullishOr(items[currentIndex + offset]), (item) => item.id)
	return h.div(
		[
			h.Class(
				cn(
					"pointer-events-none absolute inset-y-0 start-0 z-30 hidden w-full [@media(pointer:fine)]:block",
					hasPersistentGutter(state.railWidth)
						? "opacity-100"
						: "opacity-0 transition-opacity duration-150 focus-within:opacity-100 hover:opacity-100 active:opacity-100",
				),
			),
			h.DataAttribute("slot", "turn-minimap"),
			h.OnMount(mount),
		],
		[
			h.div(
				[
					h.Class(
						cn(
							"absolute top-1/2 start-3 -translate-y-1/2 select-none",
							strip > 0 ? "pointer-events-auto" : "pointer-events-none",
						),
					),
					h.Style({
						height: minimapHeightStyle(items.length),
						width: activeItem === undefined ? `${strip}px` : EXPANDED_HIT_STRIP_WIDTH,
					}),
				],
				[
					step(h, "previous", neighbour(-1)),
					h.button(
						[
							h.Type("button"),
							h.AriaLabel(
								activeItem === undefined
									? "Jump to a turn"
									: `Jump to turn: ${activeItem.userText ?? "user message"}`,
							),
							h.Class(
								"absolute inset-y-0 start-0 w-full cursor-pointer bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70",
							),
							h.DataAttribute("turn-rail", String(items.length)),
							h.DataAttribute("turn-current", String(currentIndex ?? 0)),
						],
						[
							h.div([h.Class("absolute top-0 start-3 h-full w-px bg-border-subtle")], []),
							...items.map((item, index) =>
								h.span(
									[
										h.AriaHidden(true),
										h.Class(
											cn(
												"pointer-events-none absolute start-0 h-0.5 -translate-y-1/2 rounded-full transition-[background-color,width] duration-150",
												visibleTurns.has(index)
													? "bg-foreground/80"
													: "bg-foreground-faint",
												markerWidth(
													active === null ? null : Math.abs(index - active),
												),
											),
										),
										h.DataAttribute("turn-id", item.id),
										h.Style({ top: `${minimapTopPercent(index, items.length)}%` }),
									],
									[],
								),
							),
							...(activeItem === undefined || active === null
								? []
								: [
										h.span(
											[
												h.Class(
													"pointer-events-auto absolute start-8 w-80 cursor-text select-text",
												),
												h.DataAttribute("turn-minimap-preview", ""),
												h.Style({
													top: `${minimapTopPercent(active, items.length)}%`,
													transform: `translateY(${previewTranslate(active, items.length)})`,
												}),
											],
											[
												h.span(
													[
														h.Class(
															"block rounded-lg border border-border bg-popover p-3 text-start text-popover-foreground shadow-popup",
														),
													],
													[
														h.span(
															[
																h.Class(
																	"block truncate text-sm font-medium leading-5",
																),
															],
															[activeItem.userText ?? "User message"],
														),
														...(activeItem.assistantText === null
															? []
															: [
																	h.span(
																		[
																			h.Class(
																				"mt-1 line-clamp-3 block text-sm leading-5 text-muted-foreground",
																			),
																		],
																		[activeItem.assistantText],
																	),
																]),
													],
												),
											],
										),
									]),
						],
					),
					step(h, "next", neighbour(1)),
				],
			),
		],
	)
}
