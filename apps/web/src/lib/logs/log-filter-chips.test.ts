import { describe, expect, it } from "vitest"

import { logFilterChips, withoutChips } from "./log-filter-chips"

describe("logFilterChips", () => {
	it("is empty when nothing is filtered", () => {
		expect(logFilterChips({})).toEqual([])
	})

	it("puts exclusions ahead of inclusions", () => {
		const chips = logFilterChips({ services: ["api"], excludedSeverities: ["DEBUG"] })
		expect(chips.map((c) => [c.label, c.negated])).toEqual([
			["Severity", true],
			["Service", false],
		])
	})

	it("names the param each chip clears", () => {
		expect(logFilterChips({ excludedServices: ["noisy"] })).toEqual([
			{ param: "excludedServices", label: "Service", values: ["noisy"], negated: true },
		])
	})

	it("ignores params present but empty", () => {
		expect(logFilterChips({ services: [], excludedServices: [] })).toEqual([])
	})

	it("gives each attribute filter its own chip, in the exclusion or inclusion group", () => {
		const chips = logFilterChips({
			services: ["api"],
			attrs: ["log:http.route=/a", "!res:k8s.pod.name=p1", "not-an-entry"],
		})
		expect(chips).toEqual([
			{
				param: "attrs",
				label: "k8s.pod.name",
				values: ["p1"],
				negated: true,
				attr: "!res:k8s.pod.name=p1",
			},
			{ param: "services", label: "Service", values: ["api"], negated: false },
			{
				param: "attrs",
				label: "http.route",
				values: ["/a"],
				negated: false,
				attr: "log:http.route=/a",
			},
		])
	})

	it("removes one attribute entry per chip and leaves the rest", () => {
		const search = { services: ["api"], attrs: ["log:a=1", "!log:b=2"] }
		const [excludedAttr] = logFilterChips(search)
		expect(withoutChips(search, [excludedAttr])).toEqual({ services: ["api"], attrs: ["log:a=1"] })
		expect(withoutChips(search, logFilterChips(search))).toEqual({
			services: undefined,
			attrs: undefined,
		})
	})

	it("puts the trace scope ahead of everything, exclusions included", () => {
		const traceId = "0af7651916cd43dd8448eb211c80319c"
		const chips = logFilterChips({ traceId, excludedSeverities: ["DEBUG"], services: ["api"] })
		expect(chips.map((c) => [c.label, c.negated])).toEqual([
			["Trace", false],
			["Severity", true],
			["Service", false],
		])
		expect(chips[0]).toEqual({ param: "traceId", label: "Trace", values: [traceId], negated: false })
	})
})
