import { describe, expect, it } from "vitest"
import { PLOT_HEIGHT, type ChartPoint } from "@maple/widgets/chart/static-chart"
import { chatRankedCard, chatTimeseriesCard, CHAT_CARD_WIDTH, legendRows } from "./chat-chart-card"

const at = (i: number): number => Date.UTC(2026, 8, 11, 10, 0) + i * 60_000
const series = (name: string, values: ReadonlyArray<number>) => ({
	name,
	points: values.map((v, i) => [at(i), v] as ChartPoint),
})

describe("chatTimeseriesCard", () => {
	it("is wide enough for the plot and tall enough for its rows", () => {
		const card = chatTimeseriesCard({
			kind: "line",
			title: "p95 latency",
			unit: "duration_ms",
			series: [series("checkout-api", [142, 388])],
		})

		expect(card.width).toBe(CHAT_CARD_WIDTH)
		expect(card.height).toBeGreaterThan(PLOT_HEIGHT)
	})

	it("grows when the legend wraps, so the footer stays on the card", () => {
		const short = chatTimeseriesCard({
			kind: "line",
			title: "p95 latency",
			unit: "duration_ms",
			series: [series("a", [1, 2]), series("b", [3, 4])],
		})
		const long = chatTimeseriesCard({
			kind: "line",
			title: "p95 latency",
			unit: "duration_ms",
			series: [
				series("checkout-api-production-eu-west-1", [1, 2]),
				series("cart-api-production-us-east-1", [3, 4]),
				series("inventory-worker-staging-ap-southeast-2", [5, 6]),
				series("search-api-production-sa-east-1", [7, 8]),
				series("notifications-dispatcher-production", [9, 10]),
			],
		})

		expect(long.height).toBeGreaterThan(short.height)
	})
})

describe("legendRows", () => {
	const entry = (length: number) => ({ color: "#4a9eff", text: "x".repeat(length) })

	it("keeps a legend that fits on one row", () => {
		expect(legendRows([entry(12), entry(12), entry(12)])).toBe(1)
	})

	it("wraps once the entries stop fitting", () => {
		expect(legendRows([entry(44), entry(44), entry(44)])).toBeGreaterThan(1)
	})

	it("counts one row for a legend with nothing in it", () => {
		expect(legendRows([])).toBe(1)
	})
})

describe("chatRankedCard", () => {
	it("is sized to the bars it draws", () => {
		const bar = { name: "TimeoutError", value: 412 }
		const three = chatRankedCard({ title: "errors", unit: "number", points: [bar, bar, bar] })
		const one = chatRankedCard({ title: "errors", unit: "number", points: [bar] })

		expect(three.height).toBeGreaterThan(one.height)
		expect(one.width).toBe(CHAT_CARD_WIDTH)
	})

	it("draws a ranking of zeroes without dividing by its own maximum", () => {
		expect(() =>
			chatRankedCard({
				title: "errors",
				unit: "number",
				points: [
					{ name: "a", value: 0 },
					{ name: "b", value: 0 },
				],
			}),
		).not.toThrow()
	})
})
