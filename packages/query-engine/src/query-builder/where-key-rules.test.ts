import type { QueryBuilderQueryDraftPayload } from "@maple/domain/http"
import type { QueryBuilderDataSource } from "@maple/query-model"
import { describe, expect, it } from "vitest"
import { Operator } from "@maple/domain/where-clause"
import {
	buildTimeseriesQuerySpec,
	WHERE_DIMENSIONS,
	WHERE_OPERATORS,
	whereKeyMatchesAnyOf,
	whereOperatorsOf,
} from "./model"
import { Array as Arr, Option, Order, Record as Rec } from "effect"

// The key rules against the clause handlers: every allowlisted operator is applied without a
// warning, and every other operator on a dimension warns, so the table cannot drift.

const draft = (dataSource: QueryBuilderDataSource, whereClause: string): QueryBuilderQueryDraftPayload => ({
	id: "q1",
	name: "A",
	enabled: true,
	hidden: false,
	dataSource,
	aggregation: dataSource === "metrics" ? "avg" : "count",
	whereClause,
	stepInterval: "",
	orderByDirection: "desc",
	addOns: { groupBy: false, having: false, orderBy: false, limit: false, legend: false },
	groupBy: [],
	having: "",
	orderBy: "",
	limit: "",
	legend: "",
	...(dataSource === "metrics"
		? {
				metricName: "system.cpu.utilization",
				metricType: "gauge",
				isMonotonic: false,
				signalSource: "default",
			}
		: undefined),
})

/** A value each key's handler reads as valid, so only the operator decides. */
const VALID_VALUES: ReadonlyArray<readonly [key: string, value: string]> = [
	["root_only", "true"],
	["has_error", "true"],
	["min_duration_ms", "5"],
	["max_duration_ms", "5"],
	["metric.type", "gauge"],
	["visitor.type", "new"],
	["visitor_type", "new"],
]

const validValueOf = (key: string): string =>
	Option.match(
		Arr.findFirst(VALID_VALUES, ([candidate]) => candidate === key),
		{ onNone: () => "x", onSome: ([, value]) => value },
	)

const clauseOf = (key: string, operator: string): string =>
	operator === "exists" || operator === "!exists"
		? `${key} ${operator}`
		: `${key} ${operator} "${validValueOf(key)}"`

const warningsOf = (dataSource: QueryBuilderDataSource, whereClause: string) =>
	buildTimeseriesQuerySpec(draft(dataSource, whereClause)).warnings

const sources: ReadonlyArray<QueryBuilderDataSource> = ["traces", "logs", "metrics", "product_events"]

describe("where key rules", () => {
	const dimensionCases = Arr.flatMap(sources, (dataSource) =>
		Arr.flatMap(Rec.keys(WHERE_DIMENSIONS[dataSource]), (key) =>
			Arr.map(WHERE_OPERATORS, (operator) => ({
				dataSource,
				key,
				operator,
				isAllowed: whereOperatorsOf(dataSource, key).includes(operator),
			})),
		),
	)

	it.each(dimensionCases)(
		"$dataSource $key $operator: allowed=$isAllowed",
		({ dataSource, key, operator, isAllowed }) => {
			expect(warningsOf(dataSource, clauseOf(key, operator)).length === 0).toBe(isAllowed)
		},
	)

	const attributeCases = Arr.flatMap(sources, (dataSource) =>
		Arr.map(WHERE_OPERATORS, (operator) => ({ dataSource, operator })),
	)

	it.each(attributeCases)("$dataSource attr.* takes $operator", ({ dataSource, operator }) => {
		expect(whereOperatorsOf(dataSource, "attr.http.route")).toContain(operator)
		expect(warningsOf(dataSource, clauseOf("attr.http.route", operator))).toEqual([])
	})

	const resourceSources: ReadonlyArray<QueryBuilderDataSource> = ["traces", "logs", "metrics"]
	const resourceCases = Arr.flatMap(resourceSources, (dataSource) =>
		Arr.map(WHERE_OPERATORS, (operator) => ({ dataSource, operator })),
	)

	it.each(resourceCases)("$dataSource resource.* takes $operator", ({ dataSource, operator }) => {
		expect(whereOperatorsOf(dataSource, "resource.host.name")).toContain(operator)
		expect(warningsOf(dataSource, clauseOf("resource.host.name", operator))).toEqual([])
	})

	it("product events offer no operator on resource.*, which they would read as a prop of that name", () => {
		expect(whereOperatorsOf("product_events", "resource.host.name")).toEqual([])
	})

	it("the operator list is the grammar's: an operator added there is one an attribute key takes", () => {
		expect(Arr.sort(WHERE_OPERATORS, Order.String)).toEqual(Arr.sort(Operator.literals, Order.String))
	})

	const anyOfSources: ReadonlyArray<QueryBuilderDataSource> = [
		"traces",
		"logs",
		"metrics",
		"product_events",
	]
	const anyOfCases = Arr.flatMap(anyOfSources, (dataSource) =>
		Arr.map(["attr.http.route", "resource.host.name", "service.name"], (key) => ({ dataSource, key })),
	)

	it.each(anyOfCases)("$dataSource applies an OR group on $key exactly when the rule says so", (each) => {
		const warnings = warningsOf(each.dataSource, `(${each.key} = "a" OR ${each.key} = "b")`)
		expect(warnings.length === 0).toBe(whereKeyMatchesAnyOf(each.dataSource, each.key))
	})

	it("a bare unknown key is an attribute on traces and dropped on logs and metrics", () => {
		expect(whereOperatorsOf("traces", "db.system")).toEqual(WHERE_OPERATORS)
		expect(whereOperatorsOf("logs", "db.system")).toEqual([])
		expect(warningsOf("logs", 'db.system = "x"').length).toBeGreaterThan(0)
		expect(whereOperatorsOf("metrics", "db.system")).toEqual([])
		expect(warningsOf("metrics", 'db.system = "x"').length).toBeGreaterThan(0)
	})
})
