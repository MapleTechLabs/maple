import { describe, expect, it } from "vitest"

import type { Op } from "./arbitraries.ts"
import { nativeEngine, runScenario } from "./scenarios.ts"
import golden from "./fixtures/golden.json" with { type: "json" }

// react-grid-layout 2.3.0's answers, frozen before it was removed: every
// built-in dashboard template under random edits, plus generated dirty boards
// (overlaps, holes, out-of-bounds items) at each tier, driven the way its
// `GridLayout` drove them. While both existed, a live differential suite held
// the engine to the library over 10k+ generated cases; this keeps the result,
// so stored dashboards keep drawing where the old grid drew them.
//
// A move is compared at its settled point: what the library converged to as
// the pointer kept firing inside one cell (see `moveItem`).

type Tuple = [string, number, number, number, number]

interface RawOp {
	readonly kind: string
	readonly pick: number
	readonly x?: number
	readonly y?: number
	readonly w?: number
	readonly h?: number
}

const toOp = (op: RawOp): Op =>
	op.kind === "move"
		? { kind: "move", pick: op.pick, x: op.x ?? 0, y: op.y ?? 0 }
		: { kind: "resize", pick: op.pick, w: op.w ?? 0, h: op.h ?? 0 }

describe("golden layouts from react-grid-layout", () => {
	it.each(golden.map((entry) => [entry.name, entry] as const))("%s", (_name, entry) => {
		const scenario = {
			name: entry.name,
			cols: entry.cols,
			compaction: entry.compaction === "none" ? ("none" as const) : ("vertical" as const),
			layout: entry.layout,
			ops: entry.ops.map(toOp),
		}
		const actual = runScenario(nativeEngine, scenario).map((snapshot) =>
			snapshot.map((item): Tuple => [item.i, item.x, item.y, item.w, item.h]),
		)
		expect(actual).toEqual(entry.expected)
	})
})
