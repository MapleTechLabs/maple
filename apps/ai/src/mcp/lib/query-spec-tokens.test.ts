import { describe, expect, it } from "vitest"
import { Schema, Array as Arr } from "effect"
import { QuerySpec } from "@maple/domain/query-engine"
import {
	describeInvalidQuerySpec,
	resolveTokenAliases,
	tokensFor,
	type QuerySpecKind,
	type QuerySpecSource,
} from "./query-spec-tokens"

const decode = Schema.decodeUnknownSync(QuerySpec)

/**
 * Probe the real schema rather than its AST: build a minimal spec and see whether
 * `QuerySpec` accepts it. Structural introspection would break whenever Effect
 * changes its AST; decoding is the contract we actually care about.
 */
const accepts = (spec: Record<string, unknown>): boolean => {
	try {
		decode(spec)
		return true
	} catch {
		return false
	}
}

const baseFilters = (source: QuerySpecSource): Record<string, unknown> =>
	source === "metrics" ? { filters: { metricName: "http.server.duration", metricType: "histogram" } } : {}

const specFor = (
	source: QuerySpecSource,
	kind: QuerySpecKind,
	over: Record<string, unknown>,
): Record<string, unknown> => ({
	kind,
	source,
	...baseFilters(source),
	// timeseries takes an array of groupBy tokens; breakdown takes exactly one.
	...over,
})

const COMBOS: ReadonlyArray<readonly [QuerySpecSource, QuerySpecKind]> = [
	["traces", "timeseries"],
	["traces", "breakdown"],
	["logs", "timeseries"],
	["logs", "breakdown"],
	["metrics", "timeseries"],
	["metrics", "breakdown"],
	["product_events", "timeseries"],
	["product_events", "breakdown"],
]

describe("query-spec token table matches the domain schemas", () => {
	for (const [source, kind] of COMBOS) {
		const { metrics, groupBys } = tokensFor(source, kind)

		it(`${source}/${kind}: every listed metric is accepted`, () => {
			for (const metric of metrics) {
				const groupBy = kind === "timeseries" ? { groupBy: [groupBys[0]] } : { groupBy: groupBys[0] }
				expect(accepts(specFor(source, kind, { metric, ...groupBy })), `metric=${metric}`).toBe(true)
			}
		})

		it(`${source}/${kind}: every listed group_by is accepted`, () => {
			for (const g of groupBys) {
				const groupBy = kind === "timeseries" ? { groupBy: [g] } : { groupBy: g }
				expect(
					accepts(specFor(source, kind, { metric: metrics[0], ...groupBy })),
					`groupBy=${g}`,
				).toBe(true)
			}
		})

		it(`${source}/${kind}: the table is not missing a token the schema accepts`, () => {
			// Union of every token used anywhere, so a widened schema shows up as a
			// value this combination now accepts but the table does not list.
			const allMetrics = new Set(Arr.flatMap(COMBOS, ([s, k]) => tokensFor(s, k).metrics))
			for (const metric of allMetrics) {
				if (metrics.includes(metric)) continue
				const groupBy = kind === "timeseries" ? { groupBy: [groupBys[0]] } : { groupBy: groupBys[0] }
				expect(
					accepts(specFor(source, kind, { metric, ...groupBy })),
					`unlisted metric=${metric}`,
				).toBe(false)
			}
		})
	}
})

describe("describeInvalidQuerySpec", () => {
	it("returns undefined when both tokens are valid", () => {
		expect(
			describeInvalidQuerySpec({
				source: "traces",
				kind: "breakdown",
				metric: "count",
				groupBy: "service",
			}),
		).toBeUndefined()
	})

	it("accepts every metrics aggregation for a breakdown", () => {
		for (const metric of ["min", "max", "rate", "increase"]) {
			expect(
				describeInvalidQuerySpec({
					source: "metrics",
					kind: "breakdown",
					metric,
					groupBy: undefined,
				}),
			).toBeUndefined()
		}
	})

	it("names the narrowing when the token is valid for the other kind", () => {
		const result = describeInvalidQuerySpec({
			source: "metrics",
			kind: "breakdown",
			metric: "avg",
			groupBy: "none",
		})
		expect(result?.message).toContain('valid for kind="timeseries"')
		expect(result?.message).toContain('"service", "attribute", "resource_attribute"')
	})

	it("lists the valid group_by values for the chosen combination", () => {
		const result = describeInvalidQuerySpec({
			source: "logs",
			kind: "breakdown",
			metric: "count",
			groupBy: "http_method",
		})
		expect(result?.message).toContain('"service", "severity"')
		expect(result?.example).toContain('group_by="service"')
	})

	it("reports the metric before the group_by when both are wrong", () => {
		const result = describeInvalidQuerySpec({
			source: "logs",
			kind: "breakdown",
			metric: "p95_duration",
			groupBy: "http_method",
		})
		expect(result?.message).toContain("Invalid metric")
	})
})

describe("resolveTokenAliases", () => {
	it("never rewrites a token the source and kind already accept", () => {
		const resolved = resolveTokenAliases({ source: "traces", kind: "breakdown", group_by: "span_name" })
		expect(resolved).toMatchObject({ group_by: "span_name", errorsOnly: false, decisions: [] })
	})

	it("keeps an explicit attribute_key rather than replacing it with the token", () => {
		const resolved = resolveTokenAliases({
			source: "traces",
			kind: "breakdown",
			group_by: "http.route",
			attribute_key: "user.id",
		})
		expect(resolved).toMatchObject({ group_by: "http.route", attribute_key: "user.id" })
	})

	it("leaves a dotted group_by alone where no attribute grouping exists, so validation names the options", () => {
		const resolved = resolveTokenAliases({ source: "logs", kind: "timeseries", group_by: "http.route" })
		expect(resolved.group_by).toBe("http.route")
		const invalid = describeInvalidQuerySpec({
			source: "logs",
			kind: "timeseries",
			metric: undefined,
			groupBy: resolved.group_by,
		})
		expect(invalid?.message).toContain('Invalid group_by "http.route"')
	})

	it("reads error_count as a count of error spans on traces only", () => {
		expect(
			resolveTokenAliases({ source: "traces", kind: "timeseries", metric: "error_count" }),
		).toMatchObject({
			metric: "count",
			errorsOnly: true,
		})
		expect(
			resolveTokenAliases({ source: "logs", kind: "timeseries", metric: "error_count" }),
		).toMatchObject({
			metric: "error_count",
			errorsOnly: false,
		})
	})
})
