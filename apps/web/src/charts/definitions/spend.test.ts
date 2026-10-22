import { Option } from "effect"
import { describe, expect, test } from "vitest"
import { buildSpendCumulative } from "./spend"

const DAY = 86_400_000
const day = (
	index: number,
	bands: Record<string, number | null>,
	future: boolean,
	projected: number | null,
) => ({
	date: new Date(Date.UTC(2026, 9, 1 + index)).toISOString().slice(0, 10),
	dayMs: Date.UTC(2026, 9, 1) + index * DAY,
	bands,
	projected,
	future,
})

// Day 0 and 1 happened ($20 then $30 spent); days 2 to 5 are to come, landing at $80.
const built = buildSpendCumulative({
	_tag: "SpendCumulative",
	points: [
		day(0, { base: 10, logs: 10 }, false, null),
		day(1, { base: 10, logs: 20 }, false, 30),
		day(2, { base: null, logs: null }, true, null),
		day(3, { base: null, logs: null }, true, null),
		day(4, { base: null, logs: null }, true, null),
		day(5, { base: null, logs: null }, true, 80),
	],
	bands: [
		{ key: "base", label: "Base plan", color: "#555" },
		{ key: "logs", label: "Logs", color: "#0af" },
	],
	primary: "#f80",
	chrome: { border: "#ccc", background: "#fff" },
	projected: 80,
	yMax: 100,
	currency: "usd",
})

const hover = (point: ReturnType<typeof day>) => {
	const tooltip = Option.getOrUndefined(
		built.tooltipOf([
			{
				key: "projected",
				markId: "projected",
				group: null,
				groupLabel: "",
				datum: point,
				datumIndex: 0,
				xValue: new Date(point.dayMs),
				yValue: 0,
				x: 0,
				y: 0,
				color: "#f80",
			},
		]),
	)
	return tooltip?._tag === "Bucket" ? tooltip : undefined
}

describe("spend chart tooltip", () => {
	test("a day to come reads its point on the projection line", () => {
		const tooltip = hover(day(3, { base: null, logs: null }, true, null))
		expect(tooltip?.rows.map((row) => [row.label, row.value])).toEqual([["Projected", "$55.00"]])
	})

	test("a day that happened lists each band and the total", () => {
		const tooltip = hover(day(1, { base: 10, logs: 20 }, false, 30))
		expect(tooltip?.rows.map((row) => row.value)).toEqual(["$10.00", "$20.00"])
		expect(tooltip?.total).toBe("$30.00")
	})
})
