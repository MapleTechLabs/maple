import { Effect, Queue, Stream } from "effect"
import { Mount } from "foldkit"
import { Message } from "./message"
import { ProductEdit } from "./product-edit"

type Moved = ReturnType<typeof Message.ChangedProduct>

// Column reordering: a pointer drag that
// starts on a row's grip lifts the row and follows the pointer; each sibling centre it crosses is
// a `MovedListColumn`, sent live.

export const ROW_ATTRIBUTE = "list-column-row"
export const GRIP_ATTRIBUTE = "list-column-grip"

/** `whileDrag`: the lifted row's look. */
const LIFTED = { transform: "scale(1.02)", boxShadow: "0 4px 14px rgba(0,0,0,0.12)", zIndex: "50" }
const RESTING = { transform: "", boxShadow: "", zIndex: "", position: "" }

const rowsOf = (container: Element): ReadonlyArray<HTMLElement> =>
	[...container.children].filter(
		(child): child is HTMLElement => child instanceof HTMLElement && child.hasAttribute(`data-${ROW_ATTRIBUTE}`),
	)

const centreOf = (row: HTMLElement): number => {
	const bounds = row.getBoundingClientRect()
	return bounds.top + bounds.height / 2
}

/** The slot a row dragged from `from` lands in: one past every other row whose centre it passed. */
export const targetIndex = (centres: ReadonlyArray<number>, from: number, centre: number): number =>
	centres.filter((other, index) => index !== from && other < centre).length

const startDrag = (container: Element, event: PointerEvent, emit: (message: Moved) => void): void => {
	const grip = event.target instanceof Element ? event.target.closest(`[data-${GRIP_ATTRIBUTE}]`) : null
	const row = grip?.closest(`[data-${ROW_ATTRIBUTE}]`)
	if (!(row instanceof HTMLElement)) return
	const rows = rowsOf(container)
	const from = rows.indexOf(row)
	if (from === -1) return
	event.preventDefault()
	const centres = rows.map(centreOf)
	const startY = event.clientY
	const drag = { at: from }
	Object.assign(row.style, LIFTED, { position: "relative" })
	// Like `onReorder`, every slot crossed is its own move; the lifted look follows the column.
	const onMove = (move: PointerEvent) => {
		const centre = (centres[from] ?? 0) + move.clientY - startY
		const target = targetIndex(centres, from, centre)
		if (target !== drag.at)
			emit(Message.ChangedProduct({ edit: ProductEdit.MovedListColumn({ index: drag.at, delta: target - drag.at }) }))
		drag.at = target
		rowsOf(container).forEach((other, index) =>
			index === target
				? Object.assign(other.style, LIFTED, {
						position: "relative",
						transform: `translateY(${centre - (centres[target] ?? 0)}px) scale(1.02)`,
					})
				: Object.assign(other.style, RESTING),
		)
	}
	const onEnd = () => {
		window.removeEventListener("pointermove", onMove)
		window.removeEventListener("pointerup", onEnd)
		window.removeEventListener("pointercancel", onEnd)
		rowsOf(container).forEach((other) => Object.assign(other.style, RESTING))
	}
	window.addEventListener("pointermove", onMove)
	window.addEventListener("pointerup", onEnd)
	window.addEventListener("pointercancel", onEnd)
}

/** On the column list: grip drags become reorders. */
export const MountListColumnDrag = Mount.defineStream("MountWidgetListColumnDrag", {
	messages: [Message.ChangedProduct],
	execute: ({ element }) =>
		Stream.callback<Moved>((queue) =>
			Effect.acquireRelease(
				Effect.sync(() => {
					const onDown = (event: Event) => {
						if (event instanceof PointerEvent)
							startDrag(element, event, (message) => Queue.offerUnsafe(queue, message))
					}
					element.addEventListener("pointerdown", onDown)
					return () => element.removeEventListener("pointerdown", onDown)
				}),
				(remove) => Effect.sync(remove),
			).pipe(Effect.flatMap(() => Effect.never)),
		),
})
