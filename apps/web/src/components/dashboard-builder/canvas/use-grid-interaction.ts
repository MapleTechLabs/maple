import {
	startTransition,
	useLayoutEffect,
	useRef,
	useState,
	type FocusEvent,
	type KeyboardEvent,
	type PointerEvent as ReactPointerEvent,
} from "react"
import {
	cellAt,
	clampSize,
	itemRect,
	moveItem,
	nudgeItem,
	resizeItem,
	sameLayout,
	sizeAt,
	type GridGeometry,
	type GridItem,
	type Layout,
	type PixelRect,
} from "@maple/grid-engine"

import { useMountEffect } from "@/hooks/use-mount-effect"

/**
 * Drag, resize and keyboard rearranging for one dashboard grid.
 *
 * The cost model is the point. Pointer moves never touch React: the lifted
 * tile follows the pointer through a `transform` written straight to its
 * element, once per frame. React renders only when the pointer enters a new
 * cell and the layout actually changes, and then only the cells whose item
 * changed (the engine keeps unchanged items' identity, and cells are memoised
 * on it). Widget content never re-renders during a drag.
 *
 * One drop is one `onCommit`, carrying the final layout; nothing is reported
 * for re-layouts the user did not make (a tier change, a resized window).
 */

export type InteractionKind = "drag" | "resize" | "keyboard"

export interface ActiveInteraction {
	readonly kind: InteractionKind
	readonly id: string
	/** The item's box when it was picked up, in px inside the grid's padding box. */
	readonly rect: PixelRect
	readonly preview: Layout
}

/** A tile just released, and where it was drawn when let go, so it can glide into its slot. */
export interface Drop {
	readonly id: string
	readonly left: number
	readonly top: number
}

export const DRAG_HANDLE_SELECTOR = ".widget-drag-handle"
const RESIZE_HANDLE_SELECTOR = "[data-grid-resize-handle]"

/** Pointer travel before a press on a handle becomes a drag, matching the old grid. */
const DRAG_THRESHOLD_PX = 3
/** Auto-scroll while the pointer is this close to the scroller's edge. */
const EDGE_PX = 50
const EDGE_STEP_PX = 12

interface PointerSession {
	readonly kind: "drag" | "resize"
	readonly id: string
	readonly pointerId: number
	readonly startX: number
	readonly startY: number
	readonly startLeft: number
	readonly startTop: number
	readonly origin: Layout
	readonly rect: PixelRect
	readonly scroller: HTMLElement
	readonly element: HTMLElement
	lastX: number
	lastY: number
	dx: number
	dy: number
	started: boolean
	preview: Layout
	frame: number
	detach: () => void
}

interface KeyboardSession {
	readonly id: string
	readonly label: string
	readonly origin: Layout
	preview: Layout
}

interface Settled {
	/** The `layout` input at drop time. A newer one means the store caught up. */
	readonly base: Layout
	readonly layout: Layout
}

interface Options {
	/** What the grid draws when nobody is interacting. */
	readonly layout: Layout
	readonly geometry: GridGeometry
	readonly enabled: boolean
	readonly onCommit: (next: Layout) => void
}

function nearestScroller(element: HTMLElement): HTMLElement {
	for (let node = element.parentElement; node; node = node.parentElement) {
		const overflowY = getComputedStyle(node).overflowY
		if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight)
			return node
	}
	return document.scrollingElement instanceof HTMLElement
		? document.scrollingElement
		: document.documentElement
}

/** Scroll one step if the pointer is near the scroller's edge. Returns whether it did. */
function autoScroll(scroller: HTMLElement, clientY: number): boolean {
	const isDocument = scroller === document.scrollingElement || scroller === document.documentElement
	const top = isDocument ? 0 : scroller.getBoundingClientRect().top
	const bottom = isDocument ? window.innerHeight : scroller.getBoundingClientRect().bottom
	const before = scroller.scrollTop
	if (clientY < top + EDGE_PX) scroller.scrollTop -= EDGE_STEP_PX
	else if (clientY > bottom - EDGE_PX) scroller.scrollTop += EDGE_STEP_PX
	return scroller.scrollTop !== before
}

/** Shift+arrow: one cell wider/narrower or taller/shorter, within the item's limits. */
function growItem(layout: Layout, id: string, [dw, dh]: readonly [number, number], cols: number): Layout {
	const item = layout.find((candidate) => candidate.i === id)
	if (!item) return layout
	const size = clampSize(item, item.w + dw, item.h + dh, cols)
	return resizeItem(layout, id, size.w, size.h)
}

function describePosition(item: GridItem): string {
	return `column ${item.x + 1}, row ${item.y + 1}, ${item.w} wide by ${item.h} tall`
}

function cellOf(target: EventTarget | null, container: HTMLElement | null) {
	if (!(target instanceof Element) || !container) return null
	const handle = target.closest<HTMLElement>(`${DRAG_HANDLE_SELECTOR}, ${RESIZE_HANDLE_SELECTOR}`)
	const cell = handle?.closest<HTMLElement>("[data-grid-item]")
	// Section grids are siblings, never nested, but a tile could one day host a
	// grid of its own; only this grid's direct cells are ours.
	if (!handle || !cell || cell.parentElement !== container) return null
	const id = cell.dataset.gridItem
	return id === undefined ? null : { handle, cell, id }
}

export function useGridInteraction({ layout, geometry, enabled, onCommit }: Options) {
	const containerRef = useRef<HTMLDivElement>(null)
	const ghostRef = useRef<HTMLDivElement>(null)
	const [active, setActive] = useState<ActiveInteraction | null>(null)
	const [settled, setSettled] = useState<Settled | null>(null)
	const [drop, setDrop] = useState<Drop | null>(null)
	const [announcement, setAnnouncement] = useState("")

	// After a drop the grid keeps drawing the dropped layout until the store
	// echoes it back as a new `layout`, so the tile never flashes back to its
	// old cell for the render in between.
	const idle = settled !== null && settled.base === layout ? settled.layout : layout
	// Losing edit rights mid-interaction (the window narrowed past the canonical
	// tier, the board went read-only) abandons it: the grid stops drawing it at
	// once, and the handlers cancel instead of committing on the next event.
	const current = enabled ? active : null
	const shown = current?.preview ?? idle

	// Handlers run outside render; they read the latest inputs from here.
	const latest = useRef({ layout, shown, geometry, enabled, onCommit })
	useLayoutEffect(() => {
		latest.current = { layout, shown, geometry, enabled, onCommit }
	})

	const pointer = useRef<PointerSession | null>(null)
	const keyboard = useRef<KeyboardSession | null>(null)

	// Whether cells should glide to new positions. True from pick-up through the
	// render that ends the interaction (so a cancelled drag glides back), then
	// cleared by this hook's layout effect, which runs after the cells' own.
	// A tier change or a store update therefore snaps.
	const gliding = useRef(false)
	useLayoutEffect(() => {
		gliding.current = current !== null
	})

	const publish = (preview: Layout) => setActive((current) => (current ? { ...current, preview } : current))

	const finish = (final: Layout, origin: Layout, dropped: Drop | null) => {
		gliding.current = true
		if (!sameLayout(final, origin)) {
			// The grid draws the dropped layout now, from `settled`. The store
			// update re-renders every moved tile's content, so it goes in as a
			// transition: React time-slices it instead of blocking the frame the
			// tile lands in.
			const { onCommit: commit, layout: base } = latest.current
			startTransition(() => commit(final))
			setSettled({ base, layout: final })
		}
		setActive(null)
		setDrop(dropped)
	}

	const endPointer = (commit: boolean) => {
		const session = pointer.current
		if (!session) return
		pointer.current = null
		session.detach()
		cancelAnimationFrame(session.frame)
		if (!session.started) return
		session.element.style.transform = ""
		const dropped =
			session.kind === "drag"
				? { id: session.id, left: session.rect.left + session.dx, top: session.rect.top + session.dy }
				: null
		finish(commit ? session.preview : session.origin, session.origin, dropped)
	}

	const step = () => {
		const session = pointer.current
		const container = containerRef.current
		if (!session || !container) return
		session.frame = 0
		const grid = container.getBoundingClientRect()
		// Scrolling moves the grid under a still pointer; fold that in so the tile
		// stays under the cursor while the board auto-scrolls.
		session.dx = session.lastX - session.startX + (session.startLeft - grid.left)
		session.dy = session.lastY - session.startY + (session.startTop - grid.top)
		const { geometry: currentGeometry } = latest.current
		const item = session.preview.find((candidate) => candidate.i === session.id)
		if (!item) return

		let next = session.preview
		if (session.kind === "drag") {
			session.element.style.transform = `translate3d(${session.dx}px, ${session.dy}px, 0)`
			const cell = cellAt(
				currentGeometry,
				item,
				session.rect.left + session.dx,
				session.rect.top + session.dy,
			)
			if (cell.x !== item.x || cell.y !== item.y)
				next = moveItem(session.preview, session.id, cell.x, cell.y)
		} else {
			const width = Math.max(0, session.rect.width + session.dx)
			const height = Math.max(0, session.rect.height + session.dy)
			const ghost = ghostRef.current
			if (ghost) {
				ghost.style.width = `${width}px`
				ghost.style.height = `${height}px`
			}
			const size = sizeAt(currentGeometry, item, width, height)
			if (size.w !== item.w || size.h !== item.h)
				next = resizeItem(session.preview, session.id, size.w, size.h)
		}
		if (next !== session.preview && !sameLayout(next, session.preview)) {
			session.preview = next
			publish(next)
		}
		if (autoScroll(session.scroller, session.lastY)) session.frame = requestAnimationFrame(step)
	}

	const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (!enabled || event.button !== 0 || pointer.current || keyboard.current) return
		const container = containerRef.current
		const target = cellOf(event.target, container)
		if (!target || !container) return
		const origin = latest.current.shown
		const item = origin.find((candidate) => candidate.i === target.id)
		if (!item) return
		// Stops text selection and the compatibility mouse events behind it.
		event.preventDefault()

		const onMove = (move: PointerEvent) => {
			const session = pointer.current
			if (!session || move.pointerId !== session.pointerId) return
			if (!latest.current.enabled) {
				endPointer(false)
				return
			}
			session.lastX = move.clientX
			session.lastY = move.clientY
			if (!session.started) {
				const travelled = Math.hypot(move.clientX - session.startX, move.clientY - session.startY)
				if (travelled < DRAG_THRESHOLD_PX) return
				session.started = true
				gliding.current = true
				setDrop(null)
				setActive({
					kind: session.kind,
					id: session.id,
					rect: session.rect,
					preview: session.preview,
				})
			}
			if (session.frame === 0) session.frame = requestAnimationFrame(step)
		}
		const onUp = (up: PointerEvent) => {
			if (up.pointerId === pointer.current?.pointerId) endPointer(latest.current.enabled)
		}
		const onCancel = (cancel: PointerEvent) => {
			if (cancel.pointerId === pointer.current?.pointerId) endPointer(false)
		}
		const onKey = (key: globalThis.KeyboardEvent) => {
			if (key.key !== "Escape") return
			key.preventDefault()
			endPointer(false)
		}
		window.addEventListener("pointermove", onMove)
		window.addEventListener("pointerup", onUp)
		window.addEventListener("pointercancel", onCancel)
		window.addEventListener("keydown", onKey)

		const grid = container.getBoundingClientRect()
		pointer.current = {
			kind: target.handle.matches(RESIZE_HANDLE_SELECTOR) ? "resize" : "drag",
			id: target.id,
			pointerId: event.pointerId,
			startX: event.clientX,
			startY: event.clientY,
			startLeft: grid.left,
			startTop: grid.top,
			origin,
			rect: itemRect(latest.current.geometry, item),
			scroller: nearestScroller(container),
			element: target.cell,
			lastX: event.clientX,
			lastY: event.clientY,
			dx: 0,
			dy: 0,
			started: false,
			preview: origin,
			frame: 0,
			detach: () => {
				window.removeEventListener("pointermove", onMove)
				window.removeEventListener("pointerup", onUp)
				window.removeEventListener("pointercancel", onCancel)
				window.removeEventListener("keydown", onKey)
			},
		}
	}

	const endKeyboard = (commit: boolean) => {
		const session = keyboard.current
		if (!session) return
		keyboard.current = null
		const final = commit && latest.current.enabled ? session.preview : session.origin
		const item = final.find((candidate) => candidate.i === session.id)
		setAnnouncement(
			commit
				? `${session.label} dropped at ${item ? describePosition(item) : "its position"}.`
				: `Move cancelled. ${session.label} is back at ${item ? describePosition(item) : "its position"}.`,
		)
		finish(final, session.origin, null)
	}

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (!enabled || pointer.current) return
		const target = cellOf(event.target, containerRef.current)
		if (!target || !target.handle.matches(DRAG_HANDLE_SELECTOR)) return
		const { geometry: currentGeometry } = latest.current
		const session = keyboard.current

		if (!session) {
			if (event.key !== " " && event.key !== "Enter") return
			event.preventDefault()
			const origin = latest.current.shown
			const item = origin.find((candidate) => candidate.i === target.id)
			if (!item) return
			const label = target.handle.dataset.gridLabel || "Widget"
			keyboard.current = { id: target.id, label, origin, preview: origin }
			gliding.current = true
			setDrop(null)
			setActive({
				kind: "keyboard",
				id: target.id,
				rect: itemRect(currentGeometry, item),
				preview: origin,
			})
			setAnnouncement(
				`Picked up ${label} at ${describePosition(item)}. Arrow keys move it, Shift and arrow keys resize it, Space drops it, Escape cancels.`,
			)
			return
		}
		if (session.id !== target.id) return

		if (event.key === " " || event.key === "Enter") {
			event.preventDefault()
			endKeyboard(true)
			return
		}
		if (event.key === "Escape") {
			event.preventDefault()
			endKeyboard(false)
			return
		}
		const direction = arrowDirection(event.key)
		if (!direction) return
		event.preventDefault()
		const next = event.shiftKey
			? growItem(session.preview, session.id, direction, currentGeometry.cols)
			: nudgeItem(session.preview, session.id, direction[0], direction[1], currentGeometry.cols)
		if (sameLayout(next, session.preview)) return
		session.preview = next
		publish(next)
		const moved = next.find((candidate) => candidate.i === session.id)
		if (moved) setAnnouncement(`${session.label}: ${describePosition(moved)}.`)
	}

	// Tabbing away from a picked-up tile drops it where it is.
	const onBlur = (event: FocusEvent<HTMLDivElement>) => {
		const session = keyboard.current
		if (!session) return
		const next =
			event.relatedTarget instanceof Element ? cellOf(event.relatedTarget, containerRef.current) : null
		if (next?.id !== session.id) endKeyboard(true)
	}

	useMountEffect(() => () => {
		const session = pointer.current
		if (!session) return
		session.detach()
		cancelAnimationFrame(session.frame)
	})

	return {
		shown,
		active: current,
		drop,
		announcement,
		gliding,
		ghostRef,
		containerProps: { ref: containerRef, onPointerDown, onKeyDown, onBlur },
	}
}

function arrowDirection(key: string): readonly [-1 | 0 | 1, -1 | 0 | 1] | undefined {
	switch (key) {
		case "ArrowLeft":
			return [-1, 0]
		case "ArrowRight":
			return [1, 0]
		case "ArrowUp":
			return [0, -1]
		case "ArrowDown":
			return [0, 1]
		default:
			return undefined
	}
}
