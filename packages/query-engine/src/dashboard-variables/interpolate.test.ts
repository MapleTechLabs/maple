import { parseWhereClause } from "@maple/domain/where-clause"
import { describe, expect, it } from "vitest"

import {
	ALL_VALUE,
	collectVariableRefs,
	collectWhereClauses,
	hasUnresolvedVariableRefs,
	interpolateDisplayText,
	interpolateWidgetParams,
	keepsWhereClausePredicates,
	type VariableValues,
} from "./interpolate"
import { Array as Arr } from "effect"

const single = (value: string): VariableValues[string] => ({ value, isAll: false, options: [] })
const all = (options: string[]): VariableValues[string] => ({
	value: ALL_VALUE,
	isAll: true,
	options,
})

describe("collectVariableRefs", () => {
	it("collects bare and braced references", () => {
		expect(collectVariableRefs('service.name = "$service" AND env = "${env}"')).toEqual([
			"service",
			"env",
		])
	})

	it("never matches built-in $__ macros", () => {
		expect(collectVariableRefs("WHERE $__orgFilter AND $__timeFilter(Timestamp)")).toEqual([])
	})

	it("dedupes repeated references", () => {
		expect(collectVariableRefs("$a + $a + ${a}")).toEqual(["a"])
	})
})

describe("interpolateWidgetParams — plain strings", () => {
	it("substitutes values in plain params", () => {
		const result = interpolateWidgetParams({ service_name: "$service" }, { service: single("api") })
		expect(result).toEqual({ service_name: "api" })
	})

	it("substitutes braced references adjacent to text", () => {
		const result = interpolateWidgetParams({ title: "svc-${env}-suffix" }, { env: single("prod") })
		expect(result).toEqual({ title: "svc-prod-suffix" })
	})

	it("leaves unknown references literal", () => {
		const result = interpolateWidgetParams({ service_name: "$ghost" }, { service: single("api") })
		expect(result).toEqual({ service_name: "$ghost" })
	})

	it("leaves $__startTime/$__endTime untouched", () => {
		const result = interpolateWidgetParams(
			{ startTime: "$__startTime", endTime: "$__endTime" },
			{ service: single("api") },
		)
		expect(result).toEqual({ startTime: "$__startTime", endTime: "$__endTime" })
	})

	it("recurses through nested objects and arrays", () => {
		const result = interpolateWidgetParams(
			{
				queries: [{ label: "$service", nested: { deep: "${service}" } }],
				plain: 42,
				flag: true,
			},
			{ service: single("api") },
		)
		expect(result).toEqual({
			queries: [{ label: "api", nested: { deep: "api" } }],
			plain: 42,
			flag: true,
		})
	})

	it("joins All selections with commas in plain params", () => {
		const result = interpolateWidgetParams({ service_name: "$service" }, { service: all(["a", "b"]) })
		expect(result).toEqual({ service_name: "a,b" })
	})
})

describe("interpolateWidgetParams — sql", () => {
	it("substitutes quoted escaped literals in sql params", () => {
		const result = interpolateWidgetParams(
			{ sql: "SELECT 1 WHERE $__orgFilter AND ServiceName IN ($service)" },
			{ service: single("api") },
		)
		expect(result).toEqual({ sql: "SELECT 1 WHERE $__orgFilter AND ServiceName IN ('api')" })
	})

	it("escapes single quotes and backslashes against literal breakout", () => {
		const result = interpolateWidgetParams(
			{ sql: "SELECT 1 WHERE x = $v" },
			{ v: single("a' OR '1'='1") },
		)
		expect(result).toEqual({ sql: "SELECT 1 WHERE x = 'a\\' OR \\'1\\'=\\'1'" })

		const backslash = interpolateWidgetParams({ sql: "x = $v" }, { v: single("a\\'b") })
		expect(backslash).toEqual({ sql: "x = 'a\\\\\\'b'" })
	})

	it("expands All to a quoted CSV of every option", () => {
		const result = interpolateWidgetParams(
			{ sql: "ServiceName IN ($service)" },
			{ service: all(["a", "b'c"]) },
		)
		expect(result).toEqual({ sql: "ServiceName IN ('a','b\\'c')" })
	})

	it("expands All with no options to an empty literal", () => {
		const result = interpolateWidgetParams({ sql: "x IN ($v)" }, { v: all([]) })
		expect(result).toEqual({ sql: "x IN ('')" })
	})

	it("applies sql formatting to nested sql keys", () => {
		const result = interpolateWidgetParams({ queries: [{ sql: "x = $v" }] }, { v: single("it's") })
		expect(result).toEqual({ queries: [{ sql: "x = 'it\\'s'" }] })
	})
})

describe("interpolateWidgetParams — whereClause", () => {
	it("substitutes raw values inside clause strings", () => {
		const result = interpolateWidgetParams(
			{ whereClause: 'service.name = "$service" AND status = "Error"' },
			{ service: single("api") },
		)
		expect(result).toEqual({ whereClause: 'service.name = "api" AND status = "Error"' })
	})

	it("drops the clause referencing an All selection", () => {
		const result = interpolateWidgetParams(
			{ whereClause: 'service.name = "$service" AND status = "Error"' },
			{ service: all(["a", "b"]) },
		)
		expect(result).toEqual({ whereClause: 'status = "Error"' })
	})

	it("returns an empty whereClause when every clause is dropped", () => {
		const result = interpolateWidgetParams(
			{ whereClause: 'service.name = "$service"' },
			{ service: all(["a"]) },
		)
		expect(result).toEqual({ whereClause: "" })
	})

	it("recurses into queries[i].whereClause", () => {
		const result = interpolateWidgetParams(
			{ queries: [{ whereClause: 'service.name = "$service"' }] },
			{ service: single("api") },
		)
		expect(result).toEqual({ queries: [{ whereClause: 'service.name = "api"' }] })
	})

	it('does not mis-split quoted values containing " and "', () => {
		const result = interpolateWidgetParams(
			{ whereClause: 'span.name = "buy and sell" AND service.name = "$service"' },
			{ service: single("api") },
		)
		expect(result).toEqual({
			whereClause: 'span.name = "buy and sell" AND service.name = "api"',
		})
	})

	it('drops only the All clause when a sibling quoted value contains " and "', () => {
		const result = interpolateWidgetParams(
			{ whereClause: 'span.name = "buy and sell" AND service.name = "$service"' },
			{ service: all(["a", "b"]) },
		)
		expect(result).toEqual({ whereClause: 'span.name = "buy and sell"' })
	})

	it("treats listWhereClause like a whereClause", () => {
		const result = interpolateWidgetParams(
			{ listWhereClause: 'service.name = "$service" AND kind = "server"' },
			{ service: all(["a"]) },
		)
		expect(result).toEqual({ listWhereClause: 'kind = "server"' })
	})
})

describe("interpolateWidgetParams: values that would reshape a clause", () => {
	const PINNED = 'service.name = "$service" AND deployment.environment = "prod" AND has_error = "true"'

	/** The predicates the engine would apply to the interpolated clause. */
	const predicates = (whereClause: string) => {
		const parsed = parseWhereClause(whereClause, { orGroups: true })
		return {
			clauses: Arr.map(parsed.clauses, (clause) => `${clause.key} ${clause.operator} ${clause.value}`),
			groups: parsed.groups.length,
			warnings: parsed.warnings.length,
		}
	}

	const interpolatedClause = (template: string, value: string) => {
		const result = interpolateWidgetParams({ whereClause: template }, { service: single(value) })
		return String(result.whereClause)
	}

	it.each([['a"'], ['a" OR has_error = "false'], ['a" AND x = "'], ['a" OR (x = "']])(
		"keeps every pinned clause for %j",
		(value) => {
			expect(predicates(interpolatedClause(PINNED, value))).toEqual({
				clauses: ["service.name = $service", "deployment.environment = prod", "has_error = true"],
				groups: 0,
				warnings: 0,
			})
		},
	)

	it.each([["a'"], ["a(b"], ["a) OR (x"], ['a"']])(
		"keeps every pinned clause for %j in an unquoted position",
		(value) => {
			const unquoted =
				'service.name = $service AND deployment.environment = "prod" AND has_error = "true"'
			expect(predicates(interpolatedClause(unquoted, value))).toEqual({
				clauses: ["service.name = $service", "deployment.environment = prod", "has_error = true"],
				groups: 0,
				warnings: 0,
			})
		},
	)

	it("substitutes quotes and parentheses that sit inside the template's own quotes", () => {
		expect(interpolatedClause('span.name = "$service"', "a'(b")).toBe(`span.name = "a'(b"`)
	})

	it("keeps the reference literal in an unquoted value position", () => {
		expect(interpolatedClause('service.name = $service AND has_error = "true"', "a AND b = c")).toBe(
			'service.name = $service AND has_error = "true"',
		)
	})

	it("keeps an OR group's members when a value would break out of it", () => {
		const template = '(service.name = "$service" OR service.name = "api") AND has_error = "true"'
		const parsed = parseWhereClause(interpolatedClause(template, 'a" OR x = "y'), { orGroups: true })
		expect(Arr.map(parsed.groups, (group) => Arr.map(group, (clause) => clause.value))).toEqual([
			["$service", "api"],
		])
		expect(Arr.map(parsed.clauses, (clause) => clause.key)).toEqual(["has_error"])
	})

	it("still substitutes values that keep the clause's shape", () => {
		expect(interpolatedClause(PINNED, "payments-api")).toBe(
			'service.name = "payments-api" AND deployment.environment = "prod" AND has_error = "true"',
		)
		expect(interpolatedClause('span.name = "$service"', "GET /users and more")).toBe(
			'span.name = "GET /users and more"',
		)
	})

	it("refuses a value that imitates the clause check", () => {
		const result = interpolateWidgetParams(
			{ whereClause: '$filter AND service.name = "prod"' },
			{ filter: single('maple.next exists AND x = "') },
		)
		expect(result).toEqual({ whereClause: '$filter AND service.name = "prod"' })
	})

	it("substitutes a variable that is the whole clause, unless it leaves a quote open", () => {
		const whole = (value: string) =>
			interpolateWidgetParams(
				{ whereClause: '$filter AND has_error = "true"' },
				{ filter: single(value) },
			)
		expect(whole('service.name = "api"')).toEqual({
			whereClause: 'service.name = "api" AND has_error = "true"',
		})
		expect(whole('service.name = "api')).toEqual({ whereClause: '$filter AND has_error = "true"' })
	})

	it("lets a variable choose the key it sits in", () => {
		const result = interpolateWidgetParams(
			{ whereClause: 'attr.$key = "x" AND has_error = "true"' },
			{ key: single("http.route") },
		)
		expect(result).toEqual({ whereClause: 'attr.http.route = "x" AND has_error = "true"' })
	})
})

describe("keepsWhereClausePredicates", () => {
	it("holds for values that stay one predicate", () => {
		expect(
			keepsWhereClausePredicates("service.name = '$service'", { service: single("payments-api") }),
		).toBe(true)
	})

	it("fails for a value that adds, drops or regroups predicates", () => {
		for (const value of ['a" AND status = "500', 'a"', 'a" OR (b = "c']) {
			expect(
				keepsWhereClausePredicates('service.name = "$service" AND has_error = "true"', {
					service: single(value),
				}),
				value,
			).toBe(false)
		}
	})
})

describe("collectWhereClauses", () => {
	it("finds every *whereClause string at any depth", () => {
		expect(
			collectWhereClauses({
				dataSource: { params: { queries: [{ whereClause: "a = 1" }, { whereClause: "b = 2" }] } },
				display: { listWhereClause: "c = 3", sparkline: { dataSource: { whereClause: "d = 4" } } },
				title: "e = 5",
			}),
		).toEqual(["a = 1", "b = 2", "c = 3", "d = 4"])
	})
})

describe("interpolateDisplayText", () => {
	it("substitutes values in titles", () => {
		expect(interpolateDisplayText("Latency — $service", { service: single("api") })).toBe("Latency — api")
	})

	it('renders "All" instead of the expanded value list', () => {
		expect(interpolateDisplayText("Latency — $service", { service: all(["a", "b"]) })).toBe(
			"Latency — All",
		)
	})

	it("leaves unknown references and macros literal", () => {
		expect(interpolateDisplayText("$ghost at $__startTime", { service: single("api") })).toBe(
			"$ghost at $__startTime",
		)
	})
})

describe("hasUnresolvedVariableRefs", () => {
	const defined = ["service", "env"]

	it("is false when everything referenced is resolved", () => {
		expect(
			hasUnresolvedVariableRefs({ whereClause: 'x = "$service"' }, defined, {
				service: single("api"),
			}),
		).toBe(false)
	})

	it("is true when a defined variable has no value yet", () => {
		expect(hasUnresolvedVariableRefs({ whereClause: 'x = "$service"' }, defined, {})).toBe(true)
	})

	it("ignores references to undefined names", () => {
		expect(hasUnresolvedVariableRefs({ whereClause: 'x = "$ghost"' }, defined, {})).toBe(false)
	})

	it("ignores $__ macros", () => {
		expect(hasUnresolvedVariableRefs({ sql: "WHERE $__orgFilter" }, defined, {})).toBe(false)
	})

	it("is false without params or without defined variables", () => {
		expect(hasUnresolvedVariableRefs(undefined, defined, {})).toBe(false)
		expect(hasUnresolvedVariableRefs({ whereClause: "$service" }, [], {})).toBe(false)
	})

	it("finds references nested deep in params", () => {
		expect(hasUnresolvedVariableRefs({ queries: [{ whereClause: 'x = "${env}"' }] }, defined, {})).toBe(
			true,
		)
	})
})
