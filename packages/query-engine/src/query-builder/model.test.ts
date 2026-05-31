import { describe, expect, it } from "vitest"
import type { QueryBuilderQueryDraftPayload } from "@maple/domain/http"
import { buildTimeseriesQuerySpec } from "./model"

// Minimal traces draft factory — only the fields the builder reads matter; the
// rest satisfy the payload shape.
function tracesDraft(overrides: Partial<QueryBuilderQueryDraftPayload> = {}): QueryBuilderQueryDraftPayload {
	return {
		id: "q1",
		name: "A",
		enabled: true,
		hidden: false,
		dataSource: "traces",
		aggregation: "count",
		whereClause: "",
		stepInterval: "",
		orderByDirection: "desc",
		addOns: { groupBy: false, having: false, orderBy: false, limit: false, legend: false },
		groupBy: [],
		having: "",
		orderBy: "",
		limit: "",
		legend: "",
		...overrides,
	} as QueryBuilderQueryDraftPayload
}

function attrFilters(whereClause: string) {
	const result = buildTimeseriesQuerySpec(tracesDraft({ whereClause }))
	const filters = (result.query as { filters?: { attributeFilters?: unknown[] } } | null)?.filters
	return { warnings: result.warnings, attributeFilters: filters?.attributeFilters ?? [], filters }
}

describe("buildTimeseriesQuerySpec where-clause → attribute filters", () => {
	it("auto-prefixes a bare attribute key instead of silently dropping it", () => {
		const { warnings, attributeFilters } = attrFilters('query.context = "tracesList"')
		expect(warnings).toEqual([])
		expect(attributeFilters).toEqual([{ key: "query.context", mode: "equals", value: "tracesList" }])
	})

	it("maps != to equals + negated (the negation-collapse bug fix)", () => {
		const { warnings, attributeFilters } = attrFilters('error.type != "Timeout"')
		expect(warnings).toEqual([])
		expect(attributeFilters).toEqual([
			{ key: "error.type", mode: "equals", negated: true, value: "Timeout" },
		])
	})

	it("maps !contains to contains + negated", () => {
		const { attributeFilters } = attrFilters('http.route !contains "/health"')
		expect(attributeFilters).toEqual([
			{ key: "http.route", mode: "contains", negated: true, value: "/health" },
		])
	})

	it("maps exists / !exists with no value", () => {
		expect(attrFilters("db.system exists").attributeFilters).toEqual([
			{ key: "db.system", mode: "exists" },
		])
		expect(attrFilters("db.system !exists").attributeFilters).toEqual([
			{ key: "db.system", mode: "exists", negated: true },
		])
	})

	it("still routes explicit attr.* and resource.* prefixes", () => {
		expect(attrFilters('attr.foo != "bar"').attributeFilters).toEqual([
			{ key: "foo", mode: "equals", negated: true, value: "bar" },
		])
		const resource = buildTimeseriesQuerySpec(
			tracesDraft({ whereClause: 'resource.host.name = "server-1"' }),
		)
		const resFilters = (resource.query as { filters?: { resourceAttributeFilters?: unknown[] } } | null)
			?.filters
		expect(resFilters?.resourceAttributeFilters).toEqual([
			{ key: "host.name", mode: "equals", value: "server-1" },
		])
	})

	it("keeps recognized structured keys bare (no attr prefix)", () => {
		const { attributeFilters, filters } = attrFilters('service.name = "api"')
		expect(attributeFilters).toEqual([])
		expect((filters as { serviceName?: string }).serviceName).toBe("api")
	})

	it("warns (blocking) when the 5 attr-filter cap is exceeded", () => {
		const clause = ["a = 1", "b = 2", "c = 3", "d = 4", "e = 5", "f = 6"].join(" AND ")
		const { warnings, attributeFilters } = attrFilters(clause)
		expect(attributeFilters).toHaveLength(5)
		expect(warnings.some((w) => w.includes("Maximum of 5 attr.* filters"))).toBe(true)
	})
})
