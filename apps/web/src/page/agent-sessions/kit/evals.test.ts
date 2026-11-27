import { describe, expect, it } from "vitest"
import { formatWarehouseDateTime } from "@maple/query-engine"
import { scoresWindow } from "./evals"

const NOW = Date.UTC(2026, 10, 27, 18, 7, 0)
const at = (ms: number) => formatWarehouseDateTime(ms)

describe("scoresWindow", () => {
	it("reads a window snapped a few minutes short of now to now", () => {
		const window = { startTime: at(NOW - 7 * 86_400_000), endTime: at(NOW - 7 * 60_000) }
		expect(scoresWindow(window, NOW)).toEqual({ startTime: window.startTime, endTime: at(NOW) })
	})

	it("keeps a window that ended long ago, or one that ends in the future", () => {
		const past = { startTime: at(NOW - 3 * 86_400_000), endTime: at(NOW - 2 * 86_400_000) }
		expect(scoresWindow(past, NOW)).toEqual(past)
		const future = { startTime: at(NOW - 3_600_000), endTime: at(NOW + 60_000) }
		expect(scoresWindow(future, NOW)).toEqual(future)
	})
})
