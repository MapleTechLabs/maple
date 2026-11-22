import { describe, expect, it } from "vitest"
import { Effect, Exit, Option, Result, Schema, Array as Arr } from "effect"
import { QuerySpec } from "@maple/domain/query-engine"
import {
	buildRawSpec,
	engineAttributeFilters,
	isEmptyResult,
	renderQueryData,
	type ResolvedQuery,
} from "./query-data"
import { renderToolDoc } from "../lib/tool-doc"
import { logAttributeKeys, pickAttributeScope } from "../lib/attribute-scope"

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
			params({
				source: "logs",
				attribute_key: "code.file",
				attribute_value: "a.ts",
				environments: ["prod"],
			}),
			resolved({ groupBy: "service" }),
		)
		expect(logs).toMatchObject({
			filters: { environments: ["prod"], attributeFilters: [{ key: "code.file", value: "a.ts" }] },
		})
		expect(() => decode(logs)).not.toThrow()
	})
})

describe("attribute_filters", () => {
	it("ANDs several conditions with attribute_key, each on the map it resolved to", () => {
		const spec = buildRawSpec(
			params({ group_by: "service", attribute_key: "http.route", attribute_value: "/checkout" }),
			resolved({
				groupBy: "service",
				attributeFilters: [
					{
						scope: "span",
						filter: { key: "http.response.status_code", mode: "gte", value: "500" },
					},
					{
						scope: "resource",
						filter: { key: "k8s.pod.name", mode: "in", values: ["api-0", "api-1"] },
					},
				],
			}),
		)
		expect(spec).toMatchObject({
			filters: {
				attributeFilters: [
					{ key: "http.route", value: "/checkout", mode: "equals" },
					{ key: "http.response.status_code", mode: "gte", value: "500" },
				],
				resourceAttributeFilters: [{ key: "k8s.pod.name", mode: "in", values: ["api-0", "api-1"] }],
			},
		})
		expect(Exit.isSuccess(Schema.decodeUnknownExit(QuerySpec)(spec))).toBe(true)
	})

	it("keeps a product event filter on the one map events have, whatever scope was asked", () => {
		const spec = buildRawSpec(
			params({
				source: "product_events",
				group_by: "event_name",
				attribute_key: "plan",
				attribute_value: "pro",
				attribute_scope: "resource",
			}),
			resolved({ groupBy: "event_name", attributeScope: "resource" }),
		)
		expect(Schema.decodeUnknownSync(QuerySpec)(spec)).toMatchObject({
			filters: { attributeFilters: [{ key: "plan", value: "pro", mode: "equals" }] },
		})
	})

	it("reads the mode from what was sent", () => {
		const filters = engineAttributeFilters([
			{ key: "http.route", value: "/checkout" },
			{ key: "http.response.status_code", value: 500, mode: "gte", negated: true },
			{ key: "plan", values: ["pro", "team"] },
			{ key: " user.id ", scope: "resource" },
		])
		expect(Result.getOrThrow(filters)).toEqual([
			{ filter: { key: "http.route", mode: "equals", value: "/checkout" } },
			{ filter: { key: "http.response.status_code", mode: "gte", value: "500", negated: true } },
			{ filter: { key: "plan", mode: "in", values: ["pro", "team"] } },
			{ scope: "resource", filter: { key: "user.id", mode: "exists" } },
		])
	})

	it.each([
		[[{ key: "http.route", mode: "contains" as const }], "mode=contains needs a `value`"],
		[[{ key: "plan", mode: "in" as const }], "mode=in needs a non-empty `values` array"],
		[[{ key: "plan", values: [] }], "mode=in needs a non-empty `values` array"],
		[[{ key: "plan", value: "pro", values: ["team"] }], "not both"],
		[[{ key: "plan", mode: "exists" as const, value: "pro" }], "mode=exists takes no `value`"],
		[[{ key: "plan", mode: "contains" as const, values: ["pro"] }], "`values` is for mode=in"],
		[[{ key: "http.response.status_code", mode: "gte" as const, value: "5xx" }], "is not one"],
		[[{ key: "  ", value: "x" }], "empty `key`"],
		[Array.from({ length: 9 }, (_, index) => ({ key: `k${index}`, value: "v" })), "at most 8 conditions"],
	])("refuses a condition that cannot run", (filters, reason) => {
		const result = engineAttributeFilters(filters)
		expect(Result.isFailure(result) ? result.failure : "accepted").toContain(reason)
	})

	it("names the applied conditions in the result", () => {
		const text = renderToolDoc(
			renderQueryData({
				timeRange: { start: "2026-11-20 00:00:00", end: "2026-11-20 06:00:00" },
				kind: "breakdown",
				metric: "count",
				queryContext: {
					source: "traces",
					attributeFilters: [
						{ key: "http.route", value: "/checkout", mode: "equals" },
						{ key: "http.response.status_code", value: "500", mode: "gte" },
						{ key: "user.id", mode: "exists", negated: true },
					],
				},
				unit: "number",
				result: { kind: "breakdown", data: [{ name: "api", value: 12 }] },
			}),
		)
		expect(text).toContain(
			"http.route = /checkout AND http.response.status_code >= 500 AND NOT user.id exists",
		)
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

	it("puts every other key on the resource once the primary map's keys are all known", () => {
		expect(pickAttributeScope("k8s.pod.name", ["mountpoint"], "others")).toBe("resource")
		expect(pickAttributeScope("mountpoint", ["mountpoint"], "others")).toBe("span")
	})
})

describe("logAttributeKeys", () => {
	const scopeOf = (
		key: string,
		recordKeys: Option.Option<ReadonlyArray<string>>,
		traceResourceKeys: ReadonlyArray<string>,
	) => {
		const known = Effect.runSync(logAttributeKeys(recordKeys, Effect.succeed(traceResourceKeys)))
		return pickAttributeScope(key, known.primary, known.resource)
	}

	it("puts a key the log records lack on the resource, for a service that sends no traces", () => {
		expect(scopeOf("host.name", Option.some(["http.route", "user.id"]), [])).toBe("resource")
		expect(scopeOf("http.route", Option.some(["http.route", "user.id"]), [])).toBe("span")
	})

	it("does the same when the logs carry no record attributes at all", () => {
		expect(scopeOf("host.name", Option.some([]), [])).toBe("resource")
	})

	it("asks the trace resource keys once the record catalogue is cut at its cap", () => {
		const many = Option.some(Arr.makeBy(500, (index) => `key.${index}`))
		expect(scopeOf("host.name", many, ["host.name"])).toBe("resource")
		// Past the cap an absent key may be a rare record key: it stays on the record map.
		expect(scopeOf("rare.key", many, ["host.name"])).toBe("span")
	})

	it("asks the trace resource keys when the record catalogue could not be read", () => {
		expect(scopeOf("host.name", Option.none(), ["host.name"])).toBe("resource")
		expect(scopeOf("http.route", Option.none(), ["host.name"])).toBe("span")
	})
})
