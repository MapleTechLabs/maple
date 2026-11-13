import { describe, expect, test } from "vitest"
import { draggedRange, zoomLabel } from "./linked-cursor"

const HOUR = 3_600_000
const axis = { domainStartMs: 0, domainEndMs: 10 * HOUR, startPx: 0, endPx: 500 }
const clock = (ms: number, withDay: boolean) => `${withDay ? "day " : ""}${ms / HOUR}h`

describe("linked zoom", () => {
	test("a drag reads as the same span whichever way it was dragged", () => {
		const leftToRight = draggedRange(axis, 200, 300, 450)
		expect(leftToRight).toEqual({ startMs: 2 * HOUR, endMs: 5 * HOUR })
		expect(draggedRange(axis, 200, 450, 300)).toEqual(leftToRight)
	})

	test("a drag that leaves the plot ends at the axis, not past it", () => {
		expect(draggedRange(axis, 200, 600, 2_000)).toEqual({ startMs: 8 * HOUR, endMs: 10 * HOUR })
	})

	test("the label gives both ends and the length, with the day once the span is half a day", () => {
		expect([
			zoomLabel({ startMs: 2 * HOUR, endMs: 5 * HOUR }, clock),
			zoomLabel({ startMs: 0, endMs: 30 * HOUR }, clock),
		]).toEqual(["2h to 5h · 3h", "day 0h to day 30h · 1d 6h"])
	})
})
