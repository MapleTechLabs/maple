import type { Compaction, GridItem, Layout } from "./types.ts"

// Layout operations with react-grid-layout's vertical-compaction semantics, so
// boards persisted while that library drew them land in exactly the same cells.
// `test/golden.test.ts` holds the engine to the library's frozen answers.
//
// Every exported function is pure. Internally each one clones the layout into
// mutable working items and runs the algorithm on those, because the push-down
// rules are defined in terms of in-place moves. Output items that did not move
// are the caller's original objects, so a memoised cell keyed on its item never
// re-renders for a move elsewhere on the board.

interface WorkItem {
	i: string
	x: number
	y: number
	w: number
	h: number
	minW?: number
	maxW?: number
	minH?: number
	maxH?: number
	moved: boolean
}

interface Box {
	readonly i: string
	readonly x: number
	readonly y: number
	readonly w: number
	readonly h: number
}

function toWork(item: GridItem): WorkItem {
	return { ...item, moved: false }
}

/** The working item back as a `GridItem`, reusing `original` when it is unchanged. */
function fromWork(work: WorkItem, original: GridItem | undefined): GridItem {
	if (
		original !== undefined &&
		original.x === work.x &&
		original.y === work.y &&
		original.w === work.w &&
		original.h === work.h
	) {
		return original
	}
	const { moved: _moved, ...item } = work
	return item
}

function finish(work: ReadonlyArray<WorkItem>, input: Layout): Layout {
	const byId = new Map(input.map((item) => [item.i, item]))
	const output = work.map((item) => fromWork(item, byId.get(item.i)))
	return output.every((item, index) => item === input[index]) && output.length === input.length
		? input
		: output
}

export function collides(a: Box, b: Box): boolean {
	if (a.i === b.i) return false
	if (a.x + a.w <= b.x) return false
	if (a.x >= b.x + b.w) return false
	if (a.y + a.h <= b.y) return false
	if (a.y >= b.y + b.h) return false
	return true
}

function firstCollision<T extends Box>(layout: ReadonlyArray<T>, item: Box): T | undefined {
	return layout.find((other) => collides(other, item))
}

/** Lowest occupied row, i.e. the layout's height in rows. */
export function bottom(layout: ReadonlyArray<Box>): number {
	let max = 0
	for (const item of layout) max = Math.max(max, item.y + item.h)
	return max
}

function sortByRowCol<T extends Box>(layout: ReadonlyArray<T>): T[] {
	return layout.toSorted((a, b) => a.y - b.y || a.x - b.x)
}

/** Pull items wider or further right than the grid back inside it. */
function correctBounds(layout: WorkItem[], cols: number): void {
	for (const item of layout) {
		if (item.x + item.w > cols) item.x = cols - item.w
		if (item.x < 0) {
			item.x = 0
			item.w = cols
		}
	}
}

function resolveCompactionCollision(sorted: ReadonlyArray<WorkItem>, item: WorkItem, moveTo: number): void {
	item.y += 1
	const index = sorted.findIndex((other) => other.i === item.i)
	for (const other of sorted.slice(index + 1)) {
		if (other.y > item.y + item.h) break
		if (collides(item, other)) resolveCompactionCollision(sorted, other, moveTo + item.h)
	}
	item.y = moveTo
}

function compactVerticalWork(layout: ReadonlyArray<WorkItem>): WorkItem[] {
	const placed: WorkItem[] = []
	const sorted = sortByRowCol(layout)
	const out: WorkItem[] = []
	let maxY = 0
	for (const original of sorted) {
		const item: WorkItem = { ...original }
		item.x = Math.max(item.x, 0)
		item.y = Math.min(maxY, Math.max(item.y, 0))
		while (item.y > 0 && !firstCollision(placed, item)) item.y--
		let collision: WorkItem | undefined
		while ((collision = firstCollision(placed, item)) !== undefined) {
			resolveCompactionCollision(sorted, item, collision.y + collision.h)
		}
		item.y = Math.max(item.y, 0)
		maxY = Math.max(maxY, item.y + item.h)
		placed.push(item)
		item.moved = false
		out[layout.indexOf(original)] = item
	}
	return out
}

function compactWork(layout: WorkItem[], compaction: Compaction): WorkItem[] {
	return compaction === "vertical" ? compactVerticalWork(layout) : layout.map((item) => ({ ...item }))
}

/**
 * Pack a layout: items floated up until each rests on another (vertical), in
 * reading order. Idempotent. Order of the returned array matches the input.
 */
export function compact(layout: Layout, compaction: Compaction): Layout {
	return finish(compactWork(layout.map(toWork), compaction), layout)
}

/**
 * Bring a stored layout into a drawable state: clamp it into `cols`, then
 * compact. This is what the grid draws, whatever was persisted.
 */
export function normalizeLayout(layout: Layout, cols: number, compaction: Compaction): Layout {
	const work = layout.map(toWork)
	correctBounds(work, cols)
	return finish(compactWork(work, compaction), layout)
}

function moveElement(
	layout: WorkItem[],
	item: WorkItem,
	x: number | undefined,
	y: number | undefined,
	isUserAction: boolean,
): WorkItem[] {
	if (item.y === y && item.x === x) return [...layout]
	const oldY = item.y
	if (x !== undefined) item.x = x
	if (y !== undefined) item.y = y
	item.moved = true

	let sorted = sortByRowCol(layout)
	// Moving up, the items above are visited nearest-first.
	if (y !== undefined && oldY >= y) sorted = sorted.reverse()

	let result = [...layout]
	for (const collision of sorted.filter((other) => collides(other, item))) {
		if (collision.moved) continue
		result = moveAwayFromCollision(result, item, collision, isUserAction)
	}
	return result
}

function moveAwayFromCollision(
	layout: WorkItem[],
	collidesWith: WorkItem,
	itemToMove: WorkItem,
	isUserAction: boolean,
): WorkItem[] {
	if (isUserAction) {
		// Try hopping the displaced item over the one being dragged, so dragging
		// a tile down past a neighbour swaps them rather than shoving the whole
		// column.
		const fake: Box = {
			i: "-1",
			x: itemToMove.x,
			y: Math.max(collidesWith.y - itemToMove.h, 0),
			w: itemToMove.w,
			h: itemToMove.h,
		}
		const first = firstCollision(layout, fake)
		if (first === undefined) return moveElement(layout, itemToMove, undefined, fake.y, false)
		if (first.y + first.h > collidesWith.y) {
			return moveElement(layout, itemToMove, undefined, itemToMove.y + 1, false)
		}
	}
	return moveElement(layout, itemToMove, undefined, itemToMove.y + 1, false)
}

/** Clamp a requested cell into the grid for an item of this width. */
export function clampPosition(item: GridItem, x: number, y: number, cols: number): { x: number; y: number } {
	return { x: clamp(x, 0, Math.max(0, cols - item.w)), y: Math.max(0, y) }
}

/** Clamp a requested size into the grid and the item's own min/max. */
export function clampSize(item: GridItem, w: number, h: number, cols: number): { w: number; h: number } {
	const inGridW = clamp(w, 1, Math.max(1, cols - item.x))
	const inGridH = Math.max(1, h)
	return {
		w: clamp(inGridW, item.minW ?? 1, item.maxW ?? Infinity),
		h: clamp(inGridH, item.minH ?? 1, item.maxH ?? Infinity),
	}
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value))
}

function moveStep(layout: Layout, id: string, x: number, y: number): Layout {
	const work = layout.map(toWork)
	const item = work.find((candidate) => candidate.i === id)
	if (item === undefined) return layout
	const moved = moveElement(work, item, x, y, true)
	return finish(compactVerticalWork(moved), layout)
}

/**
 * One drag step: put `id` at (`x`, `y`), push whatever it lands on out of the
 * way, then compact. Feed each step the previous step's output; a drag is a
 * fold of these over the cells the pointer crosses.
 *
 * The push-then-compact step is not idempotent: re-applying it for the same
 * cell can carry the tile one more slot down a column. react-grid-layout ran
 * it on every pointer event, so how far a tile travelled depended on how much
 * the mouse jittered inside a cell. Here it runs to its settled point, which
 * is where enough jitter would have taken it, and the result depends only on
 * the cell.
 *
 * `x`/`y` are taken as given. Clamp with `clampPosition` first.
 */
export function moveItem(layout: Layout, id: string, x: number, y: number): Layout {
	let current = layout
	// Each extra step moves the tile past one more neighbour, so a column of
	// n items settles within n steps.
	for (let step = 0; step <= layout.length; step++) {
		const next = moveStep(current, id, x, y)
		if (sameLayout(next, current)) return current
		current = next
	}
	return current
}

/**
 * One resize step from the bottom-right corner: give `id` the size (`w`, `h`),
 * then compact so anything it now overlaps is pushed down.
 *
 * `w`/`h` are taken as given. Clamp with `clampSize` first.
 */
export function resizeItem(layout: Layout, id: string, w: number, h: number): Layout {
	const work = layout.map(toWork)
	const item = work.find((candidate) => candidate.i === id)
	if (item === undefined) return layout
	item.w = w
	item.h = h
	return finish(compactVerticalWork(work), layout)
}

/**
 * Keyboard move: shift `id` one step in a direction.
 *
 * A single cell is often a no-op under vertical compaction (step a tile down
 * into empty space and it floats straight back), so this keeps reaching
 * further until the layout actually changes, up to the bottom of the board.
 */
export function nudgeItem(layout: Layout, id: string, dx: -1 | 0 | 1, dy: -1 | 0 | 1, cols: number): Layout {
	const item = layout.find((candidate) => candidate.i === id)
	if (item === undefined) return layout
	const limit = dy === 0 ? cols : bottom(layout) + 1
	for (let step = 1; step <= limit; step++) {
		const target = clampPosition(item, item.x + dx * step, item.y + dy * step, cols)
		if (target.x === item.x && target.y === item.y) return layout
		const next = moveItem(layout, id, target.x, target.y)
		if (!sameLayout(next, layout)) return next
	}
	return layout
}

/** Same items in the same boxes, ignoring order. */
export function sameLayout(a: Layout, b: Layout): boolean {
	if (a === b) return true
	if (a.length !== b.length) return false
	const byId = new Map(b.map((item) => [item.i, item]))
	return a.every((item) => {
		const other = byId.get(item.i)
		return (
			other !== undefined &&
			other.x === item.x &&
			other.y === item.y &&
			other.w === item.w &&
			other.h === item.h
		)
	})
}

/** Items of `next` whose box differs from the same id in `previous`. */
export function changedItems(previous: Layout, next: Layout): GridItem[] {
	const byId = new Map(previous.map((item) => [item.i, item]))
	return next.filter((item) => {
		const before = byId.get(item.i)
		return (
			before === undefined ||
			before.x !== item.x ||
			before.y !== item.y ||
			before.w !== item.w ||
			before.h !== item.h
		)
	})
}
