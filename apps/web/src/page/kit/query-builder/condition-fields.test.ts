import { describe, expect, test } from "vitest"
import {
	canMatchAnyOf,
	fieldOf,
	fieldPickerItems,
	fieldsOf,
	isPickable,
	operatorsOf,
	sharesLabel,
} from "./condition-fields"
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

describe("sharesLabel", () => {
	const fields = fieldsOf("traces", {
		attributeKeys: ["service.version", "http.route"],
		resourceAttributeKeys: ["service.version", "host.name"],
	})

	test("only a key that two groups hold needs its group named", () => {
		expect(sharesLabel(fieldOf("resource.service.version", "traces"), fields)).toBe(true)
		expect(sharesLabel(fieldOf("attr.service.version", "traces"), fields)).toBe(true)
		expect(sharesLabel(fieldOf("attr.http.route", "traces"), fields)).toBe(false)
		expect(sharesLabel(fieldOf("service.name", "traces"), fields)).toBe(false)
	})
})

// What the picker offers is what the source applies: a key it drops is not listed and cannot be typed in.
describe("fields the source drops", () => {
	const vocabulary = { attributeKeys: ["plan", "http.route"], resourceAttributeKeys: ["host.name"] }
	const offered = (
		dataSource: "traces" | "logs" | "metrics" | "product_events",
		drill: "all" | "resource" | "attribute",
		search: string,
	) => fieldPickerItems(fieldsOf(dataSource, vocabulary), drill, search, dataSource)
	const keysOf = (items: ReturnType<typeof offered>) =>
		Arr.flatMap(items, (item) =>
			item._tag === "Field" ? [item.field.key] : item._tag === "Custom" ? [item.key] : [],
		)

	test("product events list no resource attributes", () => {
		expect(
			Arr.filter(fieldsOf("product_events", vocabulary), (field) => field.group === "resource"),
		).toEqual([])
		expect(Arr.map(offered("product_events", "all", ""), (item) => item.value)).not.toContain(
			"@group:resource",
		)
		expect(Arr.map(offered("traces", "all", ""), (item) => item.value)).toContain("@group:resource")
	})

	test("product events take no typed resource.* key, in the list or inside a stale resource drill", () => {
		expect(offered("product_events", "all", "resource.host.name")).toEqual([])
		expect(offered("product_events", "all", "host.name")).toEqual([
			{ _tag: "Custom", value: "@custom:attr.host.name", key: "attr.host.name" },
		])
		expect(keysOf(offered("product_events", "resource", "region"))).toEqual([])
		expect(keysOf(offered("traces", "all", "resource.cloud.region"))).toEqual(["resource.cloud.region"])
	})

	test.each(["logs", "metrics"] as const)(
		"%s never offer a bare unknown key: what is typed becomes an attribute",
		(dataSource) => {
			expect(isPickable("db.system", dataSource)).toBe(false)
			expect(keysOf(offered(dataSource, "all", "db.system"))).toEqual(["attr.db.system"])
			expect(keysOf(offered(dataSource, "attribute", "db.system"))).toEqual(["attr.db.system"])
			expect(keysOf(offered(dataSource, "resource", "db.system"))).toEqual(["resource.db.system"])
		},
	)
})
