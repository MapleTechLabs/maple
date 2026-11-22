import { Array as Arr } from "effect"

// Tiles move by changing their grid area, which CSS cannot transition, so a reflow under a drag
// and the dragged tile's drop would jump. This slides each moved tile from where it was drawn
// (FLIP): measure on every box change, offset back to the old spot, animate the offset away.

const DURATION_MS = 200
const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)"
const ITEM = "[data-grid-item]"

type Spot = Readonly<{ left: number; top: number }>

const isLifted = (cell: HTMLElement): boolean => cell.style.position === "absolute"

/** Installs the observer on a grid container; the returned function removes it. */
export const installGridFlip = (grid: HTMLElement): (() => void) => {
	const spots = new WeakMap<HTMLElement, Spot>()
	const running = new WeakMap<HTMLElement, Animation>()
	const widthAt = { px: grid.clientWidth }
	const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)")

	const spotOf = (cell: HTMLElement): Spot => {
		const box = grid.getBoundingClientRect()
		const rect = cell.getBoundingClientRect()
		return { left: rect.left - box.left, top: rect.top - box.top }
	}

	const remember = () =>
		Arr.forEach(grid.querySelectorAll<HTMLElement>(ITEM), (cell) => {
			if (running.get(cell) === undefined) spots.set(cell, spotOf(cell))
		})

	const settle = (cell: HTMLElement) => {
		// Moved again mid-slide: the slide's offset still drawn is where it starts from.
		const drawn = spotOf(cell)
		running.get(cell)?.cancel()
		running.delete(cell)
		const before = spots.get(cell)
		const after = spotOf(cell)
		spots.set(cell, after)
		// A lifted tile follows the pointer itself; a keyboard move stays instant.
		if (before === undefined || isLifted(cell) || grid.dataset.keyboardMoving !== undefined) return
		const dx = before.left + (drawn.left - after.left) - after.left
		const dy = before.top + (drawn.top - after.top) - after.top
		if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return
		const animation = cell.animate(
			reducedMotion.matches
				? [{ opacity: 0.4 }, { opacity: 1 }]
				: [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }],
			{ duration: DURATION_MS, easing: EASE_OUT },
		)
		running.set(cell, animation)
		animation.onfinish = () => running.delete(cell)
	}

	const observer = new MutationObserver((records) => {
		// A new width moves every tile at once (a breakpoint, a sidebar): take the new spots as they are.
		if (grid.clientWidth !== widthAt.px) {
			widthAt.px = grid.clientWidth
			remember()
			return
		}
		const moved = new Set<HTMLElement>()
		Arr.forEach(records, (record) => {
			if (record.type === "childList") return
			if (record.target instanceof HTMLElement && record.target.matches(ITEM)) moved.add(record.target)
		})
		Arr.forEach([...moved], settle)
		Arr.forEach(grid.querySelectorAll<HTMLElement>(ITEM), (cell) => {
			if (!spots.has(cell)) spots.set(cell, spotOf(cell))
		})
	})

	remember()
	// The cells are the grid's children; records from deeper inside a tile are dropped above.
	observer.observe(grid, {
		subtree: true,
		childList: true,
		attributes: true,
		attributeFilter: ["data-grid-box", "style"],
	})
	return () => observer.disconnect()
}
