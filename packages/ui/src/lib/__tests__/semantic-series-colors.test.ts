import { describe, expect, it } from "vitest"

import { getServiceColor } from "../colors"
import { HTTP_METHOD_HEX } from "../http"
import { getSemanticSeriesColor, resolveSeriesColors } from "../semantic-series-colors"

describe("getSemanticSeriesColor", () => {
	it("resolves every HTTP status class, including 1xx", () => {
		const classes = ["1xx", "2xx", "3xx", "4xx", "5xx"]
		// Each class is visually distinct — 1xx must not read as 2xx green or 3xx blue.
		const colors = classes.map((key) => getSemanticSeriesColor(key))
		expect(new Set(colors).size).toBe(classes.length)
	})

	it("resolves individual 1xx codes", () => {
		expect(getSemanticSeriesColor("101")).toMatch(/^oklch\(/)
	})

	it("gives each latency percentile its own color", () => {
		const colors = ["p50", "p95", "p99"].map((key) => getSemanticSeriesColor(key))
		for (const color of colors) expect(color).toEqual(expect.any(String))
		expect(new Set(colors).size).toBe(3)
	})

	it("resolves every log severity, treating warning as warn", () => {
		const keys = ["trace", "debug", "info", "warn", "error", "fatal"]
		const colors = keys.map((key) => getSemanticSeriesColor(key))
		for (const color of colors) expect(color).toEqual(expect.any(String))
		expect(new Set(colors).size).toBe(keys.length)
		expect(getSemanticSeriesColor("warning")).toBe(getSemanticSeriesColor("warn"))
	})

	it("colors CI run results like the span statuses they stand for", () => {
		expect(getSemanticSeriesColor("Succeeded")).toBe(getSemanticSeriesColor("ok"))
		expect(getSemanticSeriesColor("Failed")).toBe(getSemanticSeriesColor("error"))
		expect(getSemanticSeriesColor("Cancelled")).toBe(getSemanticSeriesColor("unset"))
	})

	it("resolves HTTP methods to the shared hex palette", () => {
		expect(getSemanticSeriesColor("get")).toBe(HTTP_METHOD_HEX.GET)
		expect(getSemanticSeriesColor("DELETE")).toBe(HTTP_METHOD_HEX.DELETE)
	})
})

describe("resolveSeriesColors", () => {
	it("keeps a series' color when the set of series changes", () => {
		// The bug this exists to prevent: widening the time range pulls in more
		// services, and every color used to shift by one.
		const narrow = resolveSeriesColors(["api", "web"])
		const wide = resolveSeriesColors(["api", "web", "worker", "cron", "billing"])
		expect(wide.get("api")).toBe(narrow.get("api"))
		expect(wide.get("web")).toBe(narrow.get("web"))
	})

	it("ignores the order the series arrive in", () => {
		const names = ["api", "web", "worker", "cron"]
		const forward = resolveSeriesColors(names)
		const reversed = resolveSeriesColors([...names].reverse())
		for (const name of names) expect(reversed.get(name)).toBe(forward.get(name))
	})

	it("matches the service color used by ServiceDot and the service map", () => {
		const colors = resolveSeriesColors(["checkout-service", "cart-service"])
		expect(colors.get("checkout-service")).toBe(getServiceColor("checkout-service"))
		expect(colors.get("cart-service")).toBe(getServiceColor("cart-service"))
	})

	it("gives semantic names their meaningful color without consuming a slot", () => {
		const withSemantic = resolveSeriesColors(["error", "api", "web"])
		const without = resolveSeriesColors(["api", "web"])
		expect(withSemantic.get("error")).toBe(getSemanticSeriesColor("error"))
		expect(withSemantic.get("api")).toBe(without.get("api"))
		expect(withSemantic.get("web")).toBe(without.get("web"))
	})

	it("uses the default chart color for a generic placeholder series", () => {
		expect(resolveSeriesColors(["value"]).get("value")).toBe("var(--chart-1)")
		expect(resolveSeriesColors(["all"]).get("all")).toBe("var(--chart-1)")
	})

	it("hashes a lone real series instead of defaulting it", () => {
		// A group-by that returns one service at 1h and three at 24h must not
		// recolor that service when the others appear.
		expect(resolveSeriesColors(["api"]).get("api")).toBe(getServiceColor("api"))
	})

	it("never assigns two series in one chart the same color", () => {
		const names = Array.from({ length: 40 }, (_, i) => `service-${i}`)
		const colors = resolveSeriesColors(names)
		expect(colors.size).toBe(names.length)
		expect(new Set(colors.values()).size).toBe(names.length)
	})

	it("resolves duplicate names once", () => {
		const colors = resolveSeriesColors(["api", "api", "web"])
		expect(colors.size).toBe(2)
	})
})
