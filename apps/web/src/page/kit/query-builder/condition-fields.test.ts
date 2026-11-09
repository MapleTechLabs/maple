import { describe, expect, test } from "vitest"
import { canMatchAnyOf, fieldOf, fieldsOf, operatorsOf } from "./condition-fields"
import { Array as Arr } from "effect"

// The builder offers what the source's clause handler applies (the engine's key rules).

describe("operatorsOf", () => {
	test.each([
		["logs", "service.name", ["=", "!="]],
		["logs", "severity", ["=", "!="]],
		["logs", "body", ["=", "contains"]],
		["metrics", "service.name", ["="]],
		["metrics", "deployment.environment", ["="]],
		["metrics", "metric.type", ["="]],
		["traces", "has_error", ["="]],
		["traces", "min_duration_ms", ["="]],
		["traces", "service.name", ["=", "!=", "contains"]],
		["product_events", "event.name", ["=", "!="]],
		["product_events", "user.id", ["="]],
	] as const)("%s %s", (dataSource, key, expected) => {
		expect(operatorsOf(fieldOf(key, dataSource), dataSource)).toEqual(expected)
	})

	test("a map attribute takes the operators of its kind", () => {
		expect(operatorsOf(fieldOf("attr.http.route", "traces"), "traces")).toEqual([
			"=",
			"!=",
			"contains",
			"!contains",
			"exists",
			"!exists",
		])
		expect(operatorsOf(fieldOf("attr.http.response.status_code", "logs"), "logs")).toContain(">=")
	})

	test("a row keeps its current operator on offer", () => {
		expect(operatorsOf(fieldOf("severity", "logs"), "logs", "contains")).toEqual(["=", "!=", "contains"])
	})
})

describe("canMatchAnyOf", () => {
	test("only attribute filters on sources that lower OR groups", () => {
		expect(canMatchAnyOf(fieldOf("attr.http.route", "logs"), "logs")).toBe(true)
		expect(canMatchAnyOf(fieldOf("db.system", "traces"), "traces")).toBe(true)
		expect(canMatchAnyOf(fieldOf("db.system", "logs"), "logs")).toBe(false)
		expect(canMatchAnyOf(fieldOf("service.name", "traces"), "traces")).toBe(false)
		expect(canMatchAnyOf(fieldOf("attr.plan", "product_events"), "product_events")).toBe(false)
	})
})

describe("fieldsOf", () => {
	test("traces intrinsics are named fields, and root_only is left to the span select", () => {
		const keys = Arr.map(fieldsOf("traces", {}), (field) => field.key)
		expect(keys).toEqual(
			expect.arrayContaining(["min_duration_ms", "max_duration_ms", "vcs.ref.head.revision"]),
		)
		expect(keys).not.toContain("root_only")
		expect(fieldOf("root_only", "traces")).toMatchObject({ group: "common", kind: "boolean" })
	})
})
