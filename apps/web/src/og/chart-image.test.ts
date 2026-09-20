import { describe, expect, it } from "vitest"
import { PLOT_HEIGHT, type ChartPoint } from "@maple/widgets/chart/static-chart"
import { chartCard, rankedCard, CHART_CARD_WIDTH, legendRows } from "./chart-card"
import { cardFor, chartRequestFromPath } from "./chart-image"
import { ogIdFromPath } from "./share-links"

const at = (i: number): number => Date.UTC(2026, 8, 11, 10, 0) + i * 60_000
const series = (name: string, values: ReadonlyArray<number>) => ({
	name,
	points: values.map((v, i) => [at(i), v] as ChartPoint),
})

describe("chartRequestFromPath", () => {
	// A signed id is base64url + "." + signature, so unlike a share OG id it
	// legitimately contains a dot. Only the trailing `.png` is the extension.
	const ID = "eyJhIjoxfQ.s1gn4tur3"

	it("routes each prefix to the operation and cache policy that belong to it", () => {
		const alert = chartRequestFromPath(`/alerts/chart/${ID}.png`)
		expect(alert?.chartId).toBe(ID)
		expect(alert?.kind.apiPath).toBe("/v2/share/alert-chart")
		expect(alert?.kind.cacheControl).toContain("immutable")

		const chat = chartRequestFromPath(`/chat/chart/${ID}.png`)
		expect(chat?.chartId).toBe(ID)
		expect(chat?.kind.apiPath).toBe("/v2/share/chat-chart")
		// A reply's chart can be asked for mid-stream, so it is never immutable.
		expect(chat?.kind.cacheControl).not.toContain("immutable")
	})

	it("ignores the SPA's own routes under the same prefixes", () => {
		for (const path of ["/alerts", "/alerts/rule_1", "/alerts/chart/", "/chat", "/chat/tab-8f21"]) {
			expect(chartRequestFromPath(path)).toBeUndefined()
		}
	})

	it("rejects an id carrying path structure", () => {
		expect(chartRequestFromPath(`/alerts/chart/../${ID}.png`)).toBeUndefined()
		expect(chartRequestFromPath("/chat/chart/a/b.png")).toBeUndefined()
	})

	it("rejects a malformed escape rather than throwing past the handler", () => {
		// A lone `%` is a `URIError`. This runs ahead of the SPA shell, so letting
		// it out would be a 500 on an unauthenticated route.
		expect(chartRequestFromPath("/alerts/chart/%.png")).toBeUndefined()
	})

	it("requires the .png extension", () => {
		expect(chartRequestFromPath(`/alerts/chart/${ID}`)).toBeUndefined()
		expect(chartRequestFromPath(`/chat/chart/${ID}.jpg`)).toBeUndefined()
	})

	it("does not collide with the share image path", () => {
		expect(chartRequestFromPath("/share/og/abc.png")).toBeUndefined()
		expect(ogIdFromPath(`/alerts/chart/${ID}.png`)).toBeUndefined()
	})
})

describe("chartCard", () => {
	const alert = {
		kind: "area",
		unit: "percent",
		series: [series("checkout-api error rate", [0.8, 1.2, 3.9])],
		threshold: 2,
		breachSide: "above",
	} as const

	it("is wide enough for the plot and tall enough for its rows", () => {
		const card = chartCard("checkout-api error rate", alert)
		expect(card.width).toBe(CHART_CARD_WIDTH)
		expect(card.height).toBeGreaterThan(PLOT_HEIGHT)
	})

	it("draws no legend row for one series, so an alert card keeps its old height", () => {
		// 368: plot, padding, a title row, a footer row and two gaps. The height
		// the alert card had when it was its own builder.
		expect(chartCard("checkout-api error rate", alert).height).toBe(368)
	})

	it("grows for a legend, and again when that legend wraps", () => {
		const two = chartCard("p95 latency", {
			kind: "line",
			unit: "duration_ms",
			series: [series("a", [1, 2]), series("b", [3, 4])],
		})
		const long = chartCard("p95 latency", {
			kind: "line",
			unit: "duration_ms",
			series: [
				series("checkout-api-production-eu-west-1", [1, 2]),
				series("cart-api-production-us-east-1", [3, 4]),
				series("inventory-worker-staging-ap-southeast-2", [5, 6]),
				series("search-api-production-sa-east-1", [7, 8]),
				series("notifications-dispatcher-production", [9, 10]),
			],
		})

		expect(two.height).toBeGreaterThan(368)
		expect(long.height).toBeGreaterThan(two.height)
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

/**
 * api and web are separate Workers that can serve different commits at once —
 * prod ran a six-hour-old api behind a current web on 2026-09-07. An alert
 * chart image must draw whichever of the two shapes it is handed.
 */
describe("an alert response across a deploy skew", () => {
	const points = [
		[at(0), 1.2],
		[at(1), 3.9],
	] as const

	const shared = { kind: "area", title: "checkout-api error rate", unit: "percent" } as const
	const limits = { threshold: 2, breachSide: "above" } as const

	it("draws the same card from `series` and from the older flat `points`", () => {
		const current = cardFor({ ...shared, ...limits, series: [{ name: shared.title, points }] })
		const older = cardFor({ ...shared, ...limits, points })

		expect(current?.height).toBe(368)
		expect(older?.height).toBe(current?.height)
		expect(older?.width).toBe(current?.width)
	})

	it("draws nothing rather than throwing when a response carries neither", () => {
		expect(cardFor({ ...shared, ...limits })).toBeUndefined()
	})
})

describe("rankedCard", () => {
	it("is sized to the bars it draws", () => {
		const bar = { name: "TimeoutError", value: 412 }
		const three = rankedCard({ title: "errors", unit: "number", points: [bar, bar, bar] })
		const one = rankedCard({ title: "errors", unit: "number", points: [bar] })

		expect(three.height).toBeGreaterThan(one.height)
		expect(one.width).toBe(CHART_CARD_WIDTH)
	})

	it("draws a ranking of zeroes without dividing by its own maximum", () => {
		expect(() =>
			rankedCard({
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
