import { describe, expect, test } from "vitest"
import { DEFAULT_GESTURES, type FlowLimits, followLimits, limitsAttribute, windowDrag } from "./attach"

const limits = (translateExtent: FlowLimits["gestures"]["translateExtent"]): FlowLimits => ({
	minZoom: 0.5,
	maxZoom: 2,
	gestures: { ...DEFAULT_GESTURES, translateExtent },
})

describe("flow limits", () => {
	test("a changed translate extent on the renderer is applied once", () => {
		const small = limitsAttribute(
			limits([
				[0, 0],
				[100, 100],
			]),
		)
		const large = limitsAttribute(
			limits([
				[0, 0],
				[100, 900],
			]),
		)
		const applied: Array<FlowLimits> = []
		const next = followLimits(large, small, (value) => applied.push(value))
		expect(next).toBe(large)
		expect(applied.map((value) => value.gestures.translateExtent)).toEqual([
			[
				[0, 0],
				[100, 900],
			],
		])
		expect(followLimits(large, next, (value) => applied.push(value))).toBe(large)
		expect(applied).toHaveLength(1)
	})

	test("a missing or undecodable attribute keeps the applied limits", () => {
		const small = limitsAttribute(limits(null))
		const applied: Array<FlowLimits> = []
		expect(followLimits(null, small, (value) => applied.push(value))).toBe(small)
		expect(followLimits("{", small, (value) => applied.push(value))).toBe(small)
		expect(applied).toEqual([])
	})
})

describe("node drag window listeners", () => {
	test("stopping mid-drag drops the drag's move and up listeners", () => {
		const target = new EventTarget()
		const seen: Array<string> = []
		const drag = windowDrag(target)
		drag.start(
			() => seen.push("move"),
			() => seen.push("up"),
		)
		target.dispatchEvent(new Event("mousemove"))
		drag.stop()
		target.dispatchEvent(new Event("mousemove"))
		target.dispatchEvent(new Event("mouseup"))
		expect(seen).toEqual(["move"])
	})

	test("a new drag replaces the previous one's listeners", () => {
		const target = new EventTarget()
		const seen: Array<string> = []
		const drag = windowDrag(target)
		drag.start(
			() => seen.push("first"),
			() => {},
		)
		drag.start(
			() => seen.push("second"),
			() => {},
		)
		target.dispatchEvent(new Event("mousemove"))
		expect(seen).toEqual(["second"])
	})
})
