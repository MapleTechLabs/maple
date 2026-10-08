import {
	clampPosition,
	clampSize,
	moveItem,
	normalizeLayout,
	resizeItem,
	type Compaction,
	type Layout,
} from "../src/index.ts"
import { boxes, type Op } from "./arbitraries.ts"

// A scenario is what the canvas does with a stored board: normalize it for
// drawing, then fold user steps over it (each pointer cell crossed is one
// step). Both the live parity suite and the frozen golden fixtures replay
// scenarios through this one runner, so they test the same thing.

export interface Scenario {
	readonly name: string
	readonly cols: number
	readonly compaction: Compaction
	readonly layout: Layout
	readonly ops: ReadonlyArray<Op>
}

export type Boxes = ReturnType<typeof boxes>

/** One snapshot after normalizing, then one after every op. */
export interface Engine {
	normalize(layout: Layout, cols: number, compaction: Compaction): Layout
	move(layout: Layout, id: string, x: number, y: number, cols: number): Layout
	resize(layout: Layout, id: string, w: number, h: number, cols: number): Layout
}

export const nativeEngine: Engine = {
	normalize: normalizeLayout,
	move: (layout, id, x, y, cols) => {
		const item = layout.find((candidate) => candidate.i === id)!
		const target = clampPosition(item, x, y, cols)
		return moveItem(layout, id, target.x, target.y)
	},
	resize: (layout, id, w, h, cols) => {
		const item = layout.find((candidate) => candidate.i === id)!
		const size = clampSize(item, w, h, cols)
		return resizeItem(layout, id, size.w, size.h)
	},
}

export function runScenario(engine: Engine, scenario: Scenario): Boxes[] {
	let layout = engine.normalize(scenario.layout, scenario.cols, scenario.compaction)
	const snapshots = [boxes(layout)]
	// Editing only ever happens on a compacted grid.
	if (scenario.compaction !== "vertical" || layout.length === 0) return snapshots
	for (const op of scenario.ops) {
		const id = layout[op.pick % layout.length]!.i
		layout =
			op.kind === "move"
				? engine.move(layout, id, op.x, op.y, scenario.cols)
				: engine.resize(layout, id, op.w, op.h, scenario.cols)
		snapshots.push(boxes(layout))
	}
	return snapshots
}
