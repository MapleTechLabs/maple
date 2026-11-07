import type { WorldCell } from "@maple/domain/http"
import { Array as Arr, String as Str } from "effect"
import * as THREE from "three"
import { describe, expect, it } from "vitest"
import { CELL_SIZE } from "../factory/grid"
import { moveTool, type Placement } from "./move-tool"
import type { ToolContext, ToolPointer } from "./tools"

// The pointer's x is the ground x in cells; anything left of 50 px is building "a".
// Held: the primary button is down (presses and moves); released: nothing is down (ups).
const at = (x: number, buttons = 1): ToolPointer => ({
	clientX: x,
	clientY: 0,
	offsetX: x,
	offsetY: 0,
	button: 0,
	buttons,
})
const up = (x: number) => at(x, 0)

const harness = (blocked: (cell: WorldCell) => boolean = () => false) => {
	const log: Array<string> = []
	const context: ToolContext = {
		camera: new THREE.OrthographicCamera(),
		size: () => ({ width: 100, height: 100 }),
		pickMachines: (event) => (event.offsetX < 50 ? ["a"] : []),
		pickDuck: () => null,
		pickGround: (event) => new THREE.Vector3(event.offsetX * CELL_SIZE, 0, 0),
		selectedId: () => null,
		select: (id) => log.push(`select:${id ?? "none"}`),
		quack: () => {},
		wake: () => {},
		invalidate: () => {},
		previewMachine: (id, position) =>
			log.push(`preview:${id}:${position === null ? "none" : Math.round(position[0] / CELL_SIZE)}`),
		holdPan: (held) => log.push(`pan:${held ? "held" : "free"}`),
	}
	const placement: Placement = {
		canPlace: (_id, cell) => !blocked(cell),
		cellOf: () => ({ x: 10, z: 0 }),
		onMove: (id, cell) => log.push(`move:${id}:${cell.x}`),
	}
	return { tool: moveTool(() => placement), context, log }
}

describe("moveTool", () => {
	it("drags a building over free cells and drops it on the last one", () => {
		const { tool, context, log } = harness()
		tool.pointerDown?.(at(10), context)
		tool.pointerMove?.(at(12), context)
		tool.pointerMove?.(at(14), context)
		tool.pointerUp?.(up(14), context)
		expect(log).toEqual(["pan:held", "preview:a:12", "preview:a:14", "pan:free", "move:a:14"])
	})

	it("skips cells another building holds", () => {
		const { tool, context, log } = harness((cell) => cell.x === 14)
		tool.pointerDown?.(at(10), context)
		tool.pointerMove?.(at(12), context)
		tool.pointerMove?.(at(14), context)
		tool.pointerUp?.(up(14), context)
		expect(log.at(-1)).toBe("move:a:12")
	})

	it("a press that never leaves its cell moves nothing and still selects", () => {
		const { tool, context, log } = harness()
		tool.pointerDown?.(at(10), context)
		tool.pointerUp?.(up(10), context)
		tool.click?.(at(10), context)
		expect(log).toEqual(["pan:held", "pan:free", "preview:a:none", "select:a"])
	})

	it("a cancelled pointer puts the building back instead of dropping it", () => {
		const { tool, context, log } = harness()
		tool.pointerDown?.(at(10), context)
		tool.pointerMove?.(at(12), context)
		tool.pointerCancel?.(context)
		tool.pointerUp?.(up(12), context)
		expect(log).toEqual(["pan:held", "preview:a:12", "preview:a:none", "pan:free"])
	})

	it("releasing the left button while the right stays down still drops", () => {
		const { tool, context, log } = harness()
		tool.pointerDown?.(at(10), context)
		tool.pointerMove?.(at(12), context)
		// Right pressed: still dragging. Left released with right held: a move with buttons = 2.
		tool.pointerMove?.(at(12, 3), context)
		tool.pointerMove?.(at(14, 2), context)
		tool.pointerUp?.(up(14), context)
		expect(Arr.filter(log, Str.startsWith("move:"))).toEqual(["move:a:12"])
	})

	it("a press on the ground pans as usual", () => {
		const { tool, context, log } = harness()
		tool.pointerDown?.(at(80), context)
		tool.pointerMove?.(at(90), context)
		tool.pointerUp?.(up(90), context)
		expect(log).toEqual([])
	})
})
