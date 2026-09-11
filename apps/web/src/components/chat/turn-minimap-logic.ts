import { messageText } from "./message-actions"
import { stripContextPreamble } from "./context-preamble"
import { isMachineTurn, type TranscriptRow } from "./transcript-rows"

/** Vertical space one turn marker gets before the rail stops growing. */
const ITEM_SPACING_PX = 8
/** The rail is centred in the scroller; leave room for the composer and the header. */
const MAX_HEIGHT_CSS = "calc(100% - 6rem)"
/** `max-w-3xl` on the transcript column, in pixels. */
const CONTENT_MAX_WIDTH_PX = 768
/** Below this much free gutter the rail hides until the pointer comes near it. */
const PERSISTENT_GUTTER_PX = 48
/** Where the hover strip starts, measured from the viewport's inline edge. */
const HIT_STRIP_INSET_PX = 12
const HIT_STRIP_MAX_WIDTH_PX = 40
/** Once a preview is open, the space leading to it stays interactive. */
const EXPANDED_HIT_STRIP_WIDTH = "22rem"

/** A rail below this many turns is noise, not navigation. */
export const TURN_MINIMAP_MIN_ITEMS = 2

export interface TurnMinimapItem {
	/** The scroller item id to jump to — the user turn's own row. */
	readonly id: string
	readonly userText: string | null
	readonly assistantText: string | null
}

export interface TurnMinimapModel {
	readonly items: readonly TurnMinimapItem[]
	/** Every transcript row id → the index of the turn it belongs to. */
	readonly turnByRowId: ReadonlyMap<string, number>
}

const compactPreview = (text: string | null | undefined): string | null => {
	const compact = text?.replace(/\s+/gu, " ").trim() ?? ""
	return compact.length > 0 ? compact : null
}

/**
 * One marker per human turn, with the reply that turn produced.
 *
 * The rail addresses *rows*, not messages: adjacent tool-only turns are merged into a
 * single `tool-run` row and only that row is registered with the scroller, so a message
 * id from inside a burst would never resolve. `turnByRowId` covers every row for the same
 * reason — visibility arrives as row ids and has to be attributed back to a turn.
 *
 * A machine turn (an investigation's server-seeded opener) renders as a separator, not a
 * bubble, so it starts no marker; it belongs to whatever turn is already open.
 */
export function deriveTurnMinimap(rows: readonly TranscriptRow[]): TurnMinimapModel {
	const items: TurnMinimapItem[] = []
	const turnByRowId = new Map<string, number>()

	for (const row of rows) {
		if (row.kind === "message" && row.message.role === "user" && !isMachineTurn(row.message)) {
			items.push({
				id: row.id,
				userText: compactPreview(stripContextPreamble(messageText(row.message))),
				assistantText: null,
			})
		} else if (row.kind === "message" && row.message.role === "assistant") {
			const current = items[items.length - 1]
			const text = compactPreview(messageText(row.message))
			// The turn's last prose wins: it is what the reader remembers the turn by.
			if (current && text) items[items.length - 1] = { ...current, assistantText: text }
		}
		if (items.length > 0) turnByRowId.set(row.id, items.length - 1)
	}

	return { items, turnByRowId }
}

/** The turn the reader is currently on — the first one with a row on screen. */
export function resolveCurrentTurnIndex(
	visibleRowIds: readonly string[],
	turnByRowId: ReadonlyMap<string, number>,
): number | null {
	let current: number | null = null
	for (const id of visibleRowIds) {
		const index = turnByRowId.get(id)
		if (index === undefined) continue
		if (current === null || index < current) current = index
	}
	return current
}

export function minimapHeightStyle(itemCount: number): string {
	return `min(${Math.max(1, (itemCount - 1) * ITEM_SPACING_PX)}px, ${MAX_HEIGHT_CSS})`
}

export function minimapTopPercent(index: number, itemCount: number): number {
	if (itemCount <= 1) return 0
	return (Math.max(0, Math.min(index, itemCount - 1)) / (itemCount - 1)) * 100
}

export function minimapIndexFromPointer(input: {
	readonly itemCount: number
	readonly railTop: number
	readonly railHeight: number
	readonly pointerY: number
}): number | null {
	if (input.itemCount <= 0 || input.railHeight <= 0) return null
	if (input.itemCount === 1) return 0
	const progress = Math.max(0, Math.min(1, (input.pointerY - input.railTop) / input.railHeight))
	return Math.max(0, Math.min(input.itemCount - 1, Math.round(progress * (input.itemCount - 1))))
}

const sideGutterPx = (viewportWidth: number): number =>
	Math.max(0, (viewportWidth - Math.min(viewportWidth, CONTENT_MAX_WIDTH_PX)) / 2)

/** Wide enough to show the rail permanently instead of on hover. */
export function minimapHasPersistentGutter(viewportWidth: number): boolean {
	if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return false
	return sideGutterPx(viewportWidth) >= PERSISTENT_GUTTER_PX
}

/**
 * The rail overlays the viewport's inline edge while the transcript column stays centred,
 * so the gutter between them shrinks under zoom or in the side panel. A fixed-width hover
 * strip would then sit on top of the message text and swallow its clicks and selection.
 * Cap it to the gutter; 0 makes the strip inert.
 */
export function minimapHitStripWidth(viewportWidth: number): number {
	if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return 0
	return Math.max(
		0,
		Math.min(HIT_STRIP_MAX_WIDTH_PX, Math.floor(sideGutterPx(viewportWidth)) - HIT_STRIP_INSET_PX),
	)
}

export function minimapInteractiveWidth(collapsedWidth: number, expanded: boolean): number | string {
	return expanded ? EXPANDED_HIT_STRIP_WIDTH : collapsedWidth
}

/** Keeps the open preview from hanging off the top or bottom of the rail. */
export function minimapPreviewTranslate(index: number, itemCount: number): string {
	if (index <= 0) return "0%"
	if (index >= itemCount - 1) return "-100%"
	return "-50%"
}
