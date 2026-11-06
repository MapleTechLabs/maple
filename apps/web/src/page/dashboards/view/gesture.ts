import { cellAt, itemRect, moveItem, resizeItem, sameLayout, sizeAt } from "@maple/grid-engine"
import type { PageContext, PageReturn } from "../../contract"
import { gridOfWidget, isGestureGrid, shownLayoutOf } from "./grid"
import { commitLayout } from "./layout-commit"
import type { Message } from "./message"
import type { GridGesture, Model } from "./model"
import { endKeyboardMove, keyboardStep } from "./keyboard-move"
import { isEditing } from "./mode"
import { Option, Array as Arr } from "effect"

// Grid interaction: pointer drag and resize
// over the canvas, one commit on release. The pointer is tracked by a window subscription.
// TODO(motion): the glide into place is not animated.

type GestureMessage = Extract<
	Message,
	{
		readonly _tag:
			| "PressedGrip"
			| "PressedResizeHandle"
			| "MovedPointer"
			| "ReleasedPointer"
			| "CancelledPointer"
			| "PressedGripKey"
			| "BlurredGrip"
	}
>

type Return = PageReturn<Model, Message>

/** Pointer travel before a press on a handle becomes a drag, matching the old grid. */
const DRAG_THRESHOLD_PX = 3

const press = (
	model: Model,
	kind: GridGesture["kind"],
	widgetId: string,
	clientX: number,
	clientY: number,
): Return => {
	const grid = gridOfWidget(model, widgetId)
	// A press that never started (a tap whose release beat the window listeners) is replaced, never resumed.
	const isDragging = model.gesture !== null && model.gesture.isStarted
	if (grid === null || isDragging || model.keyboardMove !== null) return { model }
	if (!isEditing(model) || !grid.tier.canonical) return { model }
	const origin = shownLayoutOf(model, grid)
	const found = Arr.findFirst(origin, (candidate) => candidate.i === widgetId)
	if (Option.isNone(found)) return { model }
	const item = found.value
	return {
		model: {
			...model,
			gesture: {
				kind,
				widgetId,
				startX: clientX,
				startY: clientY,
				dx: 0,
				dy: 0,
				isStarted: false,
				cols: grid.geometry.cols,
				key: grid.key,
				gridOrigin: null,
				rect: itemRect(grid.geometry, item),
				origin,
				preview: origin,
			},
		},
	}
}

type Frame = Readonly<{ clientX: number; clientY: number; gridLeft: number; gridTop: number }>

/**
 * `step`: the lifted tile follows the pointer, with any auto-scroll since the press folded in;
 * the layout changes only when the cell does.
 */
const move = (model: Model, gesture: GridGesture, frame: Frame): Return => {
	const grid = gridOfWidget(model, gesture.widgetId)
	if (!isGestureGrid(grid, gesture)) return { model: { ...model, gesture: null } }
	const gridOrigin = gesture.gridOrigin ?? { left: frame.gridLeft, top: frame.gridTop }
	const dx = frame.clientX - gesture.startX + (gridOrigin.left - frame.gridLeft)
	const dy = frame.clientY - gesture.startY + (gridOrigin.top - frame.gridTop)
	const travelled = Math.hypot(frame.clientX - gesture.startX, frame.clientY - gesture.startY)
	const isStarted = gesture.isStarted || travelled >= DRAG_THRESHOLD_PX
	if (!isStarted) return { model: { ...model, gesture: { ...gesture, gridOrigin } } }
	const found = Arr.findFirst(gesture.preview, (candidate) => candidate.i === gesture.widgetId)
	if (Option.isNone(found)) return { model }
	const item = found.value
	const next = (() => {
		if (gesture.kind === "drag") {
			const cell = cellAt(grid.geometry, item, gesture.rect.left + dx, gesture.rect.top + dy)
			return cell.x !== item.x || cell.y !== item.y
				? moveItem(gesture.preview, gesture.widgetId, cell.x, cell.y)
				: gesture.preview
		}
		const size = sizeAt(
			grid.geometry,
			item,
			Math.max(0, gesture.rect.width + dx),
			Math.max(0, gesture.rect.height + dy),
		)
		return size.w !== item.w || size.h !== item.h
			? resizeItem(gesture.preview, gesture.widgetId, size.w, size.h)
			: gesture.preview
	})()
	const preview = sameLayout(next, gesture.preview) ? gesture.preview : next
	return { model: { ...model, gesture: { ...gesture, gridOrigin, dx, dy, isStarted, preview } } }
}

const release = (model: Model, context: PageContext, gesture: GridGesture, isCommit: boolean): Return => {
	const ended = { ...model, gesture: null }
	const isSameGrid = isGestureGrid(gridOfWidget(model, gesture.widgetId), gesture)
	return gesture.isStarted && isCommit && isSameGrid
		? commitLayout(ended, context, gesture.widgetId, gesture.origin, gesture.preview)
		: { model: ended }
}

/**
 * The grid was measured again or the document changed: a pointer or keyboard move begun on another
 * column count or container would commit a projected layout, so it ends where it began.
 */
export const cancelStaleGesture = (model: Model, context: PageContext): Return => {
	const { gesture, keyboardMove } = model
	if (gesture !== null && !isGestureGrid(gridOfWidget(model, gesture.widgetId), gesture))
		return { model: { ...model, gesture: null } }
	if (keyboardMove !== null && !isGestureGrid(gridOfWidget(model, keyboardMove.widgetId), keyboardMove))
		return endKeyboardMove(model, context, keyboardMove, false)
	return { model }
}

export const gestureStep = (model: Model, context: PageContext, message: GestureMessage): Return => {
	switch (message._tag) {
		case "PressedGrip":
			return press(model, "drag", message.widgetId, message.clientX, message.clientY)
		case "PressedResizeHandle":
			return press(model, "resize", message.widgetId, message.clientX, message.clientY)
		case "MovedPointer":
			return model.gesture === null ? { model } : move(model, model.gesture, message)
		case "ReleasedPointer":
			return model.gesture === null
				? { model }
				: release(model, context, model.gesture, isEditing(model))
		case "CancelledPointer":
			return model.gesture === null ? { model } : release(model, context, model.gesture, false)
		case "PressedGripKey":
			return keyboardStep(model, context, message)
		case "BlurredGrip":
			return model.keyboardMove === null || model.keyboardMove.widgetId !== message.widgetId
				? { model }
				: endKeyboardMove(model, context, model.keyboardMove, true)
	}
}
