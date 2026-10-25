import { describe, expect, it } from "vitest"
import { rawBreakdownSpanVerdict, spanBudgetApplies } from "./breakdown-span-budget"

const DAY = 86_400
const rows = [
	{ serviceName: "checkout-api", spanCount: 120 },
	{ serviceName: "checkout-worker", spanCount: 100 },
	{ serviceName: "ingest", spanCount: 1_000 },
	{ serviceName: "", spanCount: 7 },
]
const estimate = (filter: Parameters<typeof rawBreakdownSpanVerdict>[1]) =>
	rawBreakdownSpanVerdict(rows, filter, DAY, 1e9).estimatedSpans

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

	it("passes at the budget and refuses above it", () => {
		expect(rawBreakdownSpanVerdict(rows, {}, DAY, 1_227).exceeded).toBeUndefined()
		expect(rawBreakdownSpanVerdict(rows, {}, DAY, 1_226).exceeded).toBeDefined()
	})

	it("suggests the widest window that fits at the observed rate", () => {
		// 1,000 spans over 10 days = 100/day; a 250 budget fits 2.5 days -> 60 hours.
		const verdict = rawBreakdownSpanVerdict(
			[{ serviceName: "ingest", spanCount: 1_000 }],
			{},
			10 * DAY,
			250,
		)
		expect(verdict.exceeded?.details.join("\n")).toContain("Narrow the time range to 60 hours or less")
	})

	it("suggests under an hour when even one hour is over budget", () => {
		const verdict = rawBreakdownSpanVerdict(
			[{ serviceName: "ingest", spanCount: 1_000 }],
			{},
			4 * 3600,
			100,
		)
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
