import { DRAG_TOLERANCE } from "../../../components/service-map/three/scene-input"
import * as THREE from "three"
import { describe, expect, it } from "vitest"
import type { DuckClick } from "./critters"
import { selectTool, type ToolContext, type ToolPointer } from "./tools"

const at = (x: number, y: number): ToolPointer => ({
	clientX: x,
	clientY: y,
	offsetX: x,
	offsetY: y,
	button: 0,
	buttons: 0,
})

/** A context whose picks come from `machineAt` and `duck`, recording what the tool does. */
const harness = (machineAt: (x: number) => string | null, duck: DuckClick | null = null, selected = "") => {
	const log: Array<string> = []
	const context: ToolContext = {
		camera: new THREE.OrthographicCamera(),
		size: () => ({ width: 100, height: 100 }),
		pickMachines: (event) => {
			const hit = machineAt(event.offsetX)
			return hit === null ? [] : [hit]
		},
		pickDuck: () => (duck === null ? null : () => duck),
		pickGround: () => null,
		selectedId: () => (selected === "" ? null : selected),
		select: (id) => log.push(`select:${id ?? "none"}`),
		quack: (count) => log.push(`quack:${count}`),
		wake: (ms) => log.push(`wake:${ms}`),
		invalidate: () => {},
		previewMachine: () => {},
		holdPan: () => {},
	}
	return { context, log }
}

const press = (context: ToolContext, from: ToolPointer, to: ToolPointer) => {
	const tool = selectTool()
	tool.pointerDown?.(from, context)
	tool.click?.(to, context)
}

describe("selectTool", () => {
	const onA = (x: number) => (x < 50 ? "a" : null)

	it("selects a machine clicked in place, and clears it on a second click", () => {
		const first = harness(onA)
		press(first.context, at(10, 10), at(10, 10))
		const again = harness(onA, null, "a")
		press(again.context, at(10, 10), at(10, 10))
		expect([first.log, again.log]).toEqual([["select:a"], ["select:none"]])
	})

	it("ignores a machine click that started elsewhere or dragged past the tolerance", () => {
		const elsewhere = harness((x) => (x < 50 ? "a" : "b"))
		press(elsewhere.context, at(80, 10), at(10, 10))
		const dragged = harness(() => "a")
		press(dragged.context, at(10, 10), at(10 + DRAG_TOLERANCE + 1, 10))
		expect([elsewhere.log, dragged.log]).toEqual([[], []])
	})

	it("clears the selection on a miss within 2 px, not on a pan", () => {
		const miss = harness(() => null)
		press(miss.context, at(80, 80), at(82, 80))
		const pan = harness(() => null)
		press(pan.context, at(80, 80), at(83, 80))
		expect([miss.log, pan.log]).toEqual([["select:none"], []])
	})

	it("quacks a clicked duck and keeps drawing for its hop instead of clearing", () => {
		const calm = harness(() => null, { alarm: false, seconds: 1 })
		press(calm.context, at(80, 80), at(80, 80))
		const alarmed = harness(() => null, { alarm: true, seconds: 0.5 })
		press(alarmed.context, at(80, 80), at(80, 80))
		expect([calm.log, alarmed.log]).toEqual([
			["quack:2", "wake:1050"],
			["quack:3", "wake:550"],
		])
	})
})
