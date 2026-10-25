import { describe, expect, it } from "vitest"
import { rawBreakdownSpanVerdict, spanBudgetApplies } from "./breakdown-span-budget"

const DAY = 86_400
const HOUR_MS = 3_600_000
const T0 = Date.UTC(2026, 0, 1)
/** An hour-aligned window `hours` long; its end hour sits wholly outside it. */
const windowOf = (hours: number) => ({ startMs: T0, endMs: T0 + hours * HOUR_MS })
const row = (serviceName: string, spanCount: number, firstHourSpanCount = 0, lastHourSpanCount = 0) => ({
	serviceName,
	spanCount,
	firstHourSpanCount,
	lastHourSpanCount,
})
const rows = [row("checkout-api", 120), row("checkout-worker", 100), row("ingest", 1_000), row("", 7)]
const estimate = (filter: Parameters<typeof rawBreakdownSpanVerdict>[1]) =>
	rawBreakdownSpanVerdict(rows, filter, windowOf(24), 1e9).estimatedSpans

describe("rawBreakdownSpanVerdict", () => {
	it("counts every service when no service filter is set", () => {
		expect(estimate({})).toBe(1_227)
	})

	it("matches services the way the breakdown's WHERE does", () => {
		expect(estimate({ serviceName: "checkout-api" })).toBe(120)
		// The list wins over the scalar.
		expect(estimate({ serviceName: "ingest", serviceNames: ["checkout-api"] })).toBe(120)
		// `contains` is a case-insensitive substring for one value...
		expect(estimate({ serviceName: "CHECKOUT", matchModes: { serviceName: "contains" } })).toBe(220)
		// ...and exact set membership for several.
		expect(
			estimate({ serviceNames: ["checkout", "ingest"], matchModes: { serviceName: "contains" } }),
		).toBe(1_000)
		expect(estimate({ serviceNames: [""] })).toBe(7)
		expect(estimate({ excludedServiceNames: ["ingest"] })).toBe(227)
	})

	it("drops the parts of the boundary hours outside the window", () => {
		// 31M/hour; the hourly rows run 10:00..16:00 inclusive, so they hold 7 hours.
		const hourly = [row("api", 7 * 31e6, 31e6, 31e6)]
		const tenToFour = { startMs: T0 + 10 * HOUR_MS, endMs: T0 + 16 * HOUR_MS }
		expect(rawBreakdownSpanVerdict(hourly, {}, tenToFour, 200e6)).toEqual({ estimatedSpans: 186e6 })
		// 10:30..16:15 drops half the 10:00 hour and three quarters of the 16:00 hour.
		const partial = { startMs: T0 + 10.5 * HOUR_MS, endMs: T0 + 16.25 * HOUR_MS }
		expect(rawBreakdownSpanVerdict(hourly, {}, partial, 200e6).estimatedSpans).toBe(178_250_000)
	})

	it("passes at the budget and refuses above it", () => {
		expect(rawBreakdownSpanVerdict(rows, {}, windowOf(24), 1_227).exceeded).toBeUndefined()
		expect(rawBreakdownSpanVerdict(rows, {}, windowOf(24), 1_226).exceeded).toBeDefined()
	})

	it("suggests the widest window that fits at the observed rate", () => {
		// 1,000 spans over 10 days = 100/day; a 250 budget fits 2.5 days -> 60 hours.
		const verdict = rawBreakdownSpanVerdict([row("ingest", 1_000)], {}, windowOf(240), 250)
		expect(verdict.exceeded?.details.join("\n")).toContain("Narrow the time range to 60 hours or less")
	})

	it("suggests under an hour when even one hour is over budget", () => {
		const verdict = rawBreakdownSpanVerdict([row("ingest", 1_000)], {}, windowOf(4), 100)
		expect(verdict.exceeded?.details.join("\n")).toContain("under an hour")
	})
})

describe("spanBudgetApplies", () => {
	it("skips short windows", () => {
		expect(spanBudgetApplies({}, 3 * 3600)).toBe(false)
		expect(spanBudgetApplies({}, 4 * 3600)).toBe(true)
	})

	it("skips a positive attribute match the bloom index may prune, but not a negated one", () => {
		expect(
			spanBudgetApplies({ attributeFilters: [{ key: "user.id", value: "u1", mode: "equals" }] }, DAY),
		).toBe(false)
		expect(
			spanBudgetApplies(
				{ attributeFilters: [{ key: "user.id", value: "u1", mode: "equals", negated: true }] },
				DAY,
			),
		).toBe(true)
		expect(spanBudgetApplies({ attributeFilters: [{ key: "user.id", mode: "exists" }] }, DAY)).toBe(true)
		expect(
			spanBudgetApplies(
				{ resourceAttributeFilters: [{ key: "k8s.pod.name", value: "api-1", mode: "equals" }] },
				DAY,
			),
		).toBe(false)
	})
})
