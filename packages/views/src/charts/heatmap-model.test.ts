import { Array as Arr } from "effect"
import { describe, expect, it } from "vitest"
import { buildHeatmapModel, timeColumnLabeler, timeTooltipLabel } from "./heatmap-model"

describe("heatmap time columns", () => {
	it("read as clock times within one day, and with the day once they span several", () => {
		const oneDay = ["2026-11-22T14:00:00.000Z", "2026-11-22T15:00:00.000Z"]
		expect(Arr.map(oneDay, timeColumnLabeler(oneDay, "UTC"))).toEqual(["14:00", "15:00"])
		const twoDays = ["2026-11-22T00:00:00.000Z", "2026-11-23T00:00:00.000Z"]
		expect(Arr.map(twoDays, timeColumnLabeler(twoDays, "UTC"))).toEqual(["22 Nov 00:00", "23 Nov 00:00"])
	})

	it("judge the day in the viewer's zone, not in UTC", () => {
		const columns = ["2026-11-22T22:00:00.000Z", "2026-11-22T23:30:00.000Z"]
		expect(Arr.map(columns, timeColumnLabeler(columns, "Europe/Berlin"))).toEqual([
			"22 Nov 23:00",
			"23 Nov 00:30",
		])
	})

	it("keep every column of a full time grid, the empty ones as holes", () => {
		const grid = ["2026-11-22T14:00:00.000Z", "2026-11-22T14:01:00.000Z", "2026-11-22T14:02:00.000Z"]
		const model = buildHeatmapModel(
			[
				{ x: grid[0] ?? "", y: "a", value: 2 },
				{ x: grid[2] ?? "", y: "a", value: 5 },
			],
			grid,
		)
		expect(model.xDomain).toEqual(grid)
		expect(model.holes).toEqual([{ x: grid[1], y: "a", value: null }])
		expect(model.hiddenX).toBe(0)
	})

	it("sort time columns by the instant they name, fractions after the whole second", () => {
		const model = buildHeatmapModel([
			{ x: "2026-11-22T14:40:00.500Z", y: "a", value: 1 },
			{ x: "2026-11-22T14:40:00Z", y: "a", value: 1 },
		])
		expect(model.xDomain).toEqual(["2026-11-22T14:40:00Z", "2026-11-22T14:40:00.500Z"])
	})

	it("name the day in the tooltip, and the second when the time has one", () => {
		expect(timeTooltipLabel("2026-11-22T14:40:00.000Z", "UTC")).toBe("22 Nov 14:40")
		expect(timeTooltipLabel("2026-11-22T14:40:30.000Z", "UTC")).toBe("22 Nov 14:40:30")
	})
})
