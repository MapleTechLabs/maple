import { Array as Arr } from "effect"
import { describe, expect, it } from "vitest"
import { buildHeatmapModel, timeColumnLabeler, timeTickColumns, timeTooltipLabel } from "./heatmap-model"

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

	it("tick at an even clock step that fits, never cut off at the right edge", () => {
		// An hour of minute columns: 61 columns, 14:00 to 15:00.
		const hour = Arr.makeBy(61, (i) => new Date(Date.UTC(2026, 10, 22, 14, i)).toISOString())
		const label = timeColumnLabeler(hour, "UTC")
		const ticks = (width: number) =>
			Arr.map(
				Arr.filter(hour, (x) => timeTickColumns(hour, width, label, "UTC").has(x)),
				label,
			)
		// Wide: every 5 minutes; 15:00 sits on the edge, where its text would run off the plot.
		expect(ticks(1400)).toEqual([
			"14:00",
			"14:05",
			"14:10",
			"14:15",
			"14:20",
			"14:25",
			"14:30",
			"14:35",
			"14:40",
			"14:45",
			"14:50",
			"14:55",
		])
		// Narrow: a coarser step, still on round times.
		expect(ticks(400)).toEqual(["14:00", "14:10", "14:20", "14:30", "14:40", "14:50"])
	})

	it("tick on round times in the viewer's zone", () => {
		const columns = Arr.makeBy(13, (i) => new Date(Date.UTC(2026, 10, 22, 13, 15 + i * 15)).toISOString())
		const label = timeColumnLabeler(columns, "Asia/Kolkata")
		const picked = Arr.filter(columns, (x) => timeTickColumns(columns, 260, label, "Asia/Kolkata").has(x))
		// UTC+5:30: on-the-hour local times fall on :30 UTC.
		expect(Arr.map(picked, label)).toEqual(["19:00", "20:00", "21:00"])
	})

	it("label nothing before the plot is measured", () => {
		const columns = ["2026-11-22T14:00:00.000Z", "2026-11-22T14:01:00.000Z"]
		expect(timeTickColumns(columns, 0, (x) => x, "UTC").size).toBe(0)
	})
})
