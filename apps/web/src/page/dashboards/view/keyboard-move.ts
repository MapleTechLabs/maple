import { clampSize, type GridItem, type Layout, nudgeItem, resizeItem, sameLayout } from "@maple/grid-engine"
import type { PageContext, PageReturn } from "../../contract"
import { gridOfWidget, shownLayoutOf } from "./grid"
import { commitLayout } from "./layout-commit"
import type { Message } from "./message"
import type { KeyboardMove, Model } from "./model"
import { isEditing } from "./mode"

// `useGridInteraction`'s keyboard session: Space or Enter on a grip picks the tile up, arrows move
// it a cell, Shift and arrows resize it, Space or Enter drops it, Escape puts it back.

type Return = PageReturn<Model, Message>
type KeyMessage = Extract<Message, { readonly _tag: "PressedGripKey" }>

const describePosition = (item: GridItem): string =>
	`column ${item.x + 1}, row ${item.y + 1}, ${item.w} wide by ${item.h} tall`

const ARROWS = new Map<string, readonly [-1 | 0 | 1, -1 | 0 | 1]>([
	["ArrowLeft", [-1, 0]],
	["ArrowRight", [1, 0]],
	["ArrowUp", [0, -1]],
	["ArrowDown", [0, 1]],
])

/** `growItem`: one cell wider or narrower, taller or shorter, within the item's limits. */
const growItem = (layout: Layout, id: string, [dw, dh]: readonly [number, number], cols: number): Layout => {
	const item = layout.find((candidate) => candidate.i === id)
	if (item === undefined) return layout
	const size = clampSize(item, item.w + dw, item.h + dh, cols)
	return resizeItem(layout, id, size.w, size.h)
}

/** `endKeyboard`: a drop commits and announces where; a cancel puts the tile back. */
export const endKeyboardMove = (
	model: Model,
	context: PageContext,
	move: KeyboardMove,
	isCommit: boolean,
): Return => {
	const final = isCommit && isEditing(model) ? move.preview : move.origin
	const item = final.find((candidate) => candidate.i === move.widgetId)
	const position = item === undefined ? "its position" : describePosition(item)
	const gridAnnouncement = isCommit
		? `${move.label} dropped at ${position}.`
		: `Move cancelled. ${move.label} is back at ${position}.`
	return commitLayout(
		{ ...model, keyboardMove: null, gridAnnouncement },
		context,
		move.widgetId,
		move.origin,
		final,
	)
}

const pickUp = (model: Model, message: KeyMessage): Return => {
	const grid = gridOfWidget(model, message.widgetId)
	if (grid === null || model.gesture !== null || !isEditing(model) || !grid.tier.canonical) return { model }
	const origin = shownLayoutOf(model, grid)
	const item = origin.find((candidate) => candidate.i === message.widgetId)
	if (item === undefined) return { model }
	const label = message.label === "" ? "Widget" : message.label
	return {
		model: {
			...model,
			keyboardMove: { widgetId: message.widgetId, label, origin, preview: origin },
			gridAnnouncement: `Picked up ${label} at ${describePosition(item)}. Arrow keys move it, Shift and arrow keys resize it, Space drops it, Escape cancels.`,
		},
	}
}

export const keyboardStep = (model: Model, context: PageContext, message: KeyMessage): Return => {
	const move = model.keyboardMove
	const isPickKey = message.key === " " || message.key === "Enter"
	if (move === null) return isPickKey ? pickUp(model, message) : { model }
	if (move.widgetId !== message.widgetId) return { model }
	if (isPickKey) return endKeyboardMove(model, context, move, true)
	if (message.key === "Escape") return endKeyboardMove(model, context, move, false)
	const direction = ARROWS.get(message.key)
	const grid = gridOfWidget(model, move.widgetId)
	if (direction === undefined || grid === null) return { model }
	const next = message.isShift
		? growItem(move.preview, move.widgetId, direction, grid.geometry.cols)
		: nudgeItem(move.preview, move.widgetId, direction[0], direction[1], grid.geometry.cols)
	if (sameLayout(next, move.preview)) return { model }
	const moved = next.find((candidate) => candidate.i === move.widgetId)
	return {
		model: {
			...model,
			keyboardMove: { ...move, preview: next },
			gridAnnouncement:
				moved === undefined ? model.gridAnnouncement : `${move.label}: ${describePosition(moved)}.`,
		},
	}
}
