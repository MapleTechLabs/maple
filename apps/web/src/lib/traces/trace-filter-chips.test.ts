import { describe, expect, it } from "vitest"

import { removeTraceFilterChips, traceFilterChips } from "./trace-filter-chips"

describe("traceFilterChips", () => {
	it("is empty when nothing is filtered", () => {
		expect(traceFilterChips({})).toEqual([])
	})

	it("puts exclusions ahead of inclusions", () => {
		// An inclusion explains itself — the results are what came back. An exclusion is only
		// visible as absence, so it reads first.
		const chips = traceFilterChips({
			services: ["api"],
			excludedSpanNames: ["GET /health"],
		})
		expect(chips.map((c) => [c.label, c.negated])).toEqual([
			["Root Span", true],
			["Service", false],
		])
	})

	it("clears the param a facet chip owns", () => {
		const [chip] = traceFilterChips({ excludedNamespaces: ["internal"] })
		expect(chip).toMatchObject({
			id: "excludedNamespaces",
			label: "Namespace",
			values: ["internal"],
			negated: true,
		})
		expect(chip.remove({ excludedNamespaces: ["internal"], services: ["api"] })).toEqual({
			excludedNamespaces: undefined,
			services: ["api"],
		})
	})

	it("shows one chip per attribute filter, and removes only that entry", () => {
		const search = {
			attributeFilters: [
				{ key: "request.id", value: "req_1" },
				{ key: "http.route", value: "/health", negated: true },
			],
			resourceAttributeFilters: [{ key: "service.version", value: "1.2.3" }],
		}
		const chips = traceFilterChips(search)
		expect(chips.map((c) => [c.label, c.values, c.negated])).toEqual([
			["http.route", ["/health"], true],
			["request.id", ["req_1"], false],
			["resource.service.version", ["1.2.3"], false],
		])
		expect(chips[1].remove(search).attributeFilters).toEqual([
			{ key: "http.route", value: "/health", negated: true },
		])
		expect(removeTraceFilterChips(search, chips)).toEqual({
			attributeFilters: undefined,
			resourceAttributeFilters: undefined,
		})
	})

	it("ignores params present but empty", () => {
		expect(traceFilterChips({ services: [], excludedServices: [] })).toEqual([])
	})

	it("keeps sidebar order within each polarity", () => {
		const chips = traceFilterChips({
			httpMethods: ["GET"],
			services: ["api"],
			deploymentEnvs: ["prod"],
		})
		expect(chips.map((c) => c.label)).toEqual(["Environment", "Service", "HTTP Method"])
	})
})
