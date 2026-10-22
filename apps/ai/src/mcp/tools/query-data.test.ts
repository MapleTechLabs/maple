import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { QuerySpec } from "@maple/query-engine"
import { buildRawSpec, isEmptyResult, type ResolvedQuery } from "./query-data"
import { pickAttributeScope } from "../lib/attribute-scope"

type Params = Parameters<typeof buildRawSpec>[0]

const params = (overrides: Partial<Params>): Params => ({
	source: "traces",
	kind: "breakdown",
	limit: 10,
	...overrides,
})

const resolved = (overrides: Partial<ResolvedQuery> = {}): ResolvedQuery => ({
	metric: "count",
	groupBy: "attribute",
	attributeScope: "span",
	...overrides,
})

const decode = (raw: Record<string, unknown>) => Schema.decodeUnknownSync(QuerySpec)(raw)

describe("buildRawSpec", () => {
	it("groups traces by a resource attribute on the resource map", () => {
		const spec = buildRawSpec(
			params({ group_by: "resource_attribute", attribute_key: "deployment.environment" }),
			resolved({ attributeScope: "resource" }),
		)
		expect(spec).toMatchObject({
			groupBy: "attribute",
			filters: { groupByResourceAttributeKey: "deployment.environment" },
		})
		expect(() => decode(spec)).not.toThrow()
	})

	it("filters traces on a resource attribute when the key resolved to resource", () => {
		const spec = buildRawSpec(
			params({ group_by: "service", attribute_key: "k8s.pod.name", attribute_value: "api-0" }),
			resolved({ groupBy: "service", attributeScope: "resource" }),
		)
		expect(spec).toMatchObject({
			filters: { resourceAttributeFilters: [{ key: "k8s.pod.name", value: "api-0", mode: "equals" }] },
		})
		expect(spec).not.toHaveProperty("filters.attributeFilters")
	})

	it("keeps the value filter when grouping metrics by the same label", () => {
		const spec = buildRawSpec(
			params({
				source: "metrics",
				metric_name: "system.filesystem.usage",
				metric_type: "gauge",
				group_by: "attribute",
				attribute_key: "mountpoint",
				attribute_value: "/var/lib/scylla",
			}),
			resolved({ metric: "avg" }),
		)
		expect(spec).toMatchObject({
			groupBy: "attribute",
			filters: {
				groupByAttributeKey: "mountpoint",
				attributeFilters: [{ key: "mountpoint", value: "/var/lib/scylla", mode: "equals" }],
			},
		})
		expect(() => decode(spec)).not.toThrow()
	})

	it("breaks metrics down by a resource attribute instead of falling back to service", () => {
		const spec = buildRawSpec(
			params({
				source: "metrics",
				metric_name: "k8s.pod.cpu.usage",
				metric_type: "gauge",
				group_by: "resource_attribute",
				attribute_key: "deployment.environment.name",
			}),
			resolved({ metric: "avg", groupBy: "resource_attribute", attributeScope: "resource" }),
		)
		expect(spec).toMatchObject({
			groupBy: "resource_attribute",
			filters: { groupByResourceAttributeKey: "deployment.environment.name" },
		})
		expect(() => decode(spec)).not.toThrow()
	})

	it("adds no exists filter when grouping without a value", () => {
		const spec = buildRawSpec(params({ group_by: "attribute", attribute_key: "http.route" }), resolved())
		expect(spec).toMatchObject({ filters: { groupByAttributeKeys: ["http.route"] } })
		expect(spec).not.toHaveProperty("filters.attributeFilters")
	})

	it("matches span_name as a substring when asked, and filters logs by attribute and environment", () => {
		expect(
			buildRawSpec(
				params({ group_by: "service", span_name: "reset" }),
				resolved({ groupBy: "service", spanNameContains: true }),
			),
		).toMatchObject({ filters: { spanName: "reset", matchModes: { spanName: "contains" } } })
		const logs = buildRawSpec(
			params({ source: "logs", attribute_key: "code.file", attribute_value: "a.ts", environments: ["prod"] }),
			resolved({ groupBy: "service" }),
		)
		expect(logs).toMatchObject({
			filters: { environments: ["prod"], attributeFilters: [{ key: "code.file", value: "a.ts" }] },
		})
		expect(() => decode(logs)).not.toThrow()
	})
})

describe("isEmptyResult", () => {
	it("treats no rows and all-zero series as empty", () => {
		expect(isEmptyResult({ kind: "breakdown", data: [] })).toBe(true)
		expect(isEmptyResult({ kind: "timeseries", data: [{ bucket: "b", series: { all: 0 } }] })).toBe(true)
		expect(isEmptyResult({ kind: "timeseries", data: [{ bucket: "b", series: { all: 2 } }] })).toBe(false)
	})
})

describe("pickAttributeScope", () => {
	it("prefers the primary map, then a known resource key", () => {
		expect(pickAttributeScope("http.route", ["http.route"], ["http.route"])).toBe("span")
		expect(pickAttributeScope("deployment.environment", ["http.route"], ["deployment.environment"])).toBe(
			"resource",
		)
		expect(pickAttributeScope("nope", ["http.route"], ["service.version"])).toBe("span")
	})

	it("treats a key missing from a metric's own labels as a resource attribute", () => {
		expect(pickAttributeScope("k8s.pod.name", ["mountpoint"], "unknown")).toBe("resource")
		expect(pickAttributeScope("k8s.pod.name", [], "unknown")).toBe("span")
	})
})
