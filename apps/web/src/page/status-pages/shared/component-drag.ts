import { Array as Arr, Effect, Queue, Stream } from "effect"

// A pointer drag on a component's grip lifts its row and follows the pointer within its group; the
// group's other rows slide aside to open the slot it would land in, which a dashed outline marks.
// Letting go settles the row into that slot and sends one drop (the row's key and its new index in
// the group). Escape or a cancelled pointer springs it back and sends nothing. The builder and
// Settings > Monitors share it.

/** On a group's wrapper, around its list and its slot outline. */
export const LIST_ATTRIBUTE = "component-list"
/** On a component's row, valued with its key. */
export const ROW_ATTRIBUTE = "component-row"
export const GRIP_ATTRIBUTE = "component-grip"
/** On the outline drawn where the held row would land. */
export const SLOT_ATTRIBUTE = "component-slot"
/** The same four for the groups: each group's block (its head and its rows) moves as one. */
export const GROUP_LIST_ATTRIBUTE = "group-list"
/** On a group's block, valued with the group's name (`""` for no group). */
export const GROUP_ROW_ATTRIBUTE = "group-row"
export const GROUP_GRIP_ATTRIBUTE = "group-grip"
export const GROUP_SLOT_ATTRIBUTE = "group-slot"
/** Set on the held row and the slot outline while a drag runs; the view styles it. */
const DRAGGING = "data-dragging"

const MOVE_MS = 160
const MOVE = `transform ${MOVE_MS}ms cubic-bezier(0.2, 0, 0, 1)`
const LIFT = "scale(1.01)"
/** The reorder's render normally lands within a frame; the rows drop their offsets by then regardless. */
const RENDER_WAIT_MS = 500

/** A row's measured place, in viewport pixels. */
export type Span = Readonly<{ top: number; height: number }>

/** How far row `index` moves while the row from `from`, `size` tall, is held over slot `to`. */
export const shiftOf = (index: number, from: number, to: number, size: number): number =>
	index > from && index <= to ? -size : index < from && index >= to ? size : 0

/** How far the row from `from` moves to rest in slot `to`: rows may differ in height. */
export const landingOffset = (spans: ReadonlyArray<Span>, from: number, to: number): number => {
	const origin = spans[from]
	const target = spans[to]
	if (origin === undefined || target === undefined) return 0
	return to > from ? target.top + target.height - (origin.top + origin.height) : target.top - origin.top
}

/**
 * The slot the row from `from`, moved `offset` pixels, lands in: the one whose resting place is
 * nearest. Held as far as its group allows, that is the end slot.
 */
export const dropIndex = (spans: ReadonlyArray<Span>, from: number, offset: number): number =>
	Arr.reduce(spans, from, (best, _, index) =>
		Math.abs(offset - landingOffset(spans, from, index)) <
		Math.abs(offset - landingOffset(spans, from, best))
			? index
			: best,
	)

/** What a grip drags: a component within its group, or a whole group among the groups. */
export type DragKind = "component" | "group"

/** The markers of one kind of list: its wrapper, rows, grips and slot outline. */
type Markers = Readonly<{ list: string; row: string; grip: string; slot: string }>

const MARKERS = {
	component: { list: LIST_ATTRIBUTE, row: ROW_ATTRIBUTE, grip: GRIP_ATTRIBUTE, slot: SLOT_ATTRIBUTE },
	group: {
		list: GROUP_LIST_ATTRIBUTE,
		row: GROUP_ROW_ATTRIBUTE,
		grip: GROUP_GRIP_ATTRIBUTE,
		slot: GROUP_SLOT_ATTRIBUTE,
	},
} as const satisfies Record<DragKind, Markers>

/** A row let go over a new slot: what it is, its key and its new index among its siblings. */
export type ComponentDrop = Readonly<{ kind: DragKind; key: string; index: number }>

const translate = (offset: number): string => (offset === 0 ? "" : `translateY(${offset}px)`)

const startDrag = (
	event: PointerEvent,
	emit: (drop: ComponentDrop) => void,
	busy: { isDragging: boolean },
): void => {
	if (busy.isDragging || event.button !== 0 || !(event.target instanceof Element)) return
	const kind: DragKind | null =
		event.target.closest(`[data-${GRIP_ATTRIBUTE}]`) !== null
			? "component"
			: event.target.closest(`[data-${GROUP_GRIP_ATTRIBUTE}]`) !== null
				? "group"
				: null
	if (kind === null) return
	const markers = MARKERS[kind]
	const grip = event.target.closest(`[data-${markers.grip}]`)
	const row = grip?.closest(`[data-${markers.row}]`)
	const list = row?.closest(`[data-${markers.list}]`)
	// The list's own slot: a group's block holds its rows' list and slot too.
	const slot = list?.querySelector(`:scope > [data-${markers.slot}]`)
	if (
		!(grip instanceof HTMLElement) ||
		!(row instanceof HTMLElement) ||
		!(list instanceof HTMLElement) ||
		!(slot instanceof HTMLElement)
	)
		return
	const key = row.getAttribute(`data-${markers.row}`)
	const rows = Arr.filter(
		[...list.querySelectorAll(`[data-${markers.row}]`)],
		(other): other is HTMLElement => other instanceof HTMLElement,
	)
	const from = rows.indexOf(row)
	const spans = Arr.map(rows, (other): Span => {
		const bounds = other.getBoundingClientRect()
		return { top: bounds.top, height: bounds.height }
	})
	const origin = spans[from]
	const first = spans[0]
	const last = spans[spans.length - 1]
	if (key === null || origin === undefined || first === undefined || last === undefined) return
	event.preventDefault()
	busy.isDragging = true
	grip.setPointerCapture(event.pointerId)
	const ease = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "" : MOVE
	const listTop = list.getBoundingClientRect().top
	// Held inside its group: no higher than its first row, no lower than its last.
	const minOffset = first.top - origin.top
	const maxOffset = last.top + last.height - (origin.top + origin.height)
	const startY = event.clientY
	const drag = { to: from }

	const placeSlot = (to: number) => {
		slot.style.transform = `translateY(${origin.top + landingOffset(spans, from, to) - listTop}px)`
	}
	slot.style.height = `${origin.height}px`
	placeSlot(from)
	slot.setAttribute(DRAGGING, "")
	row.setAttribute(DRAGGING, "")
	row.style.transform = LIFT
	Arr.forEach(rows, (other) => {
		if (other !== row) other.style.transition = ease
	})
	// Shown at its first slot, then eased from slot to slot.
	slot.getBoundingClientRect()
	slot.style.transition = ease

	const onMove = (move: PointerEvent) => {
		const offset = Math.min(Math.max(move.clientY - startY, minOffset), maxOffset)
		row.style.transform = `translateY(${offset}px) ${LIFT}`
		const to = dropIndex(spans, from, offset)
		if (to === drag.to) return
		drag.to = to
		Arr.forEach(rows, (other, index) => {
			if (index !== from) other.style.transform = translate(shiftOf(index, from, to, origin.height))
		})
		placeSlot(to)
	}
	const reset = () => {
		Arr.forEach(rows, (other) => {
			other.style.transform = ""
			other.style.transition = ""
			other.removeAttribute(DRAGGING)
		})
		slot.style.transition = ""
		busy.isDragging = false
	}
	// The held row eases into `to`; a new slot is then sent, and the rendered order takes over from
	// the offsets in the frame it lands.
	const release = (to: number) => {
		grip.removeEventListener("pointermove", onMove)
		grip.removeEventListener("pointerup", onUp)
		grip.removeEventListener("pointercancel", onAbort)
		grip.removeEventListener("lostpointercapture", onAbort)
		window.removeEventListener("keydown", onKey, true)
		slot.removeAttribute(DRAGGING)
		row.style.transition = ease
		row.style.transform = translate(landingOffset(spans, from, to))
		if (to === from)
			Arr.forEach(rows, (other) => {
				other.style.transform = ""
			})
		window.setTimeout(
			() => {
				if (to === from) {
					reset()
					return
				}
				const observer = new MutationObserver(() => {
					observer.disconnect()
					window.clearTimeout(fallback)
					reset()
				})
				const fallback = window.setTimeout(() => {
					observer.disconnect()
					reset()
				}, RENDER_WAIT_MS)
				observer.observe(row.parentElement ?? row, { childList: true })
				emit({ kind, key, index: to })
			},
			ease === "" ? 0 : MOVE_MS,
		)
	}
	const onUp = () => release(drag.to)
	const onAbort = () => release(from)
	const onKey = (key: KeyboardEvent) => {
		if (key.key !== "Escape") return
		// The editor's own Escape would close the open component as well.
		key.preventDefault()
		key.stopPropagation()
		release(from)
	}
	grip.addEventListener("pointermove", onMove)
	grip.addEventListener("pointerup", onUp)
	grip.addEventListener("pointercancel", onAbort)
	grip.addEventListener("lostpointercapture", onAbort)
	window.addEventListener("keydown", onKey, true)
}

/** Grip drags in a component list, of a component or a group, each let go over a new slot as one drop. */
export const componentDrags: Stream.Stream<ComponentDrop> = Stream.callback<ComponentDrop>((queue) =>
	Effect.acquireRelease(
		Effect.sync(() => {
			const busy = { isDragging: false }
			const onDown = (event: PointerEvent) =>
				startDrag(event, (drop) => Queue.offerUnsafe(queue, drop), busy)
			document.addEventListener("pointerdown", onDown)
			return () => document.removeEventListener("pointerdown", onDown)
		}),
		(remove) => Effect.sync(remove),
	).pipe(Effect.flatMap(() => Effect.never)),
)
