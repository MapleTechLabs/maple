import { describe, expect, it } from "vitest"

import {
	addLogAttributeFilter,
	decodeLogAttributeFilter,
	decodeLogAttributeFilters,
	encodeLogAttributeFilter,
	logAttributeQueryFilters,
	matchesLogAttributeFilters,
	type LogAttributeFilter,
} from "./log-attribute-filters"

const route: LogAttributeFilter = { source: "log", key: "http.route", value: "/api/orders", negated: false }

describe("log attribute filter encoding", () => {
	it("spells the scope and polarity in a readable prefix", () => {
		expect(encodeLogAttributeFilter(route)).toBe("log:http.route=/api/orders")
		expect(
			encodeLogAttributeFilter({
				source: "resource",
				key: "k8s.pod.name",
				value: "api-1",
				negated: true,
			}),
		).toBe("!res:k8s.pod.name=api-1")
	})

	it("round-trips `=` in values and `=` / `%` in keys", () => {
		const filters: LogAttributeFilter[] = [
			{ source: "log", key: "query", value: "a=1&b==2", negated: false },
			{ source: "resource", key: "odd=key%3D", value: "", negated: true },
			{ source: "log", key: "multi", value: "line one\nline two", negated: false },
		]
		for (const filter of filters) {
			expect(decodeLogAttributeFilter(encodeLogAttributeFilter(filter))).toEqual(filter)
		}
	})

	it("drops entries that are not in the `attrs` spelling", () => {
		expect(decodeLogAttributeFilters(["http.route=/a", "log:=x", "span:k=v", "log:k=v"])).toEqual([
			{ source: "log", key: "k", value: "v", negated: false },
		])
	})
})

describe("addLogAttributeFilter", () => {
	it("replaces the opposite polarity of the same value instead of keeping both", () => {
		const included = addLogAttributeFilter(undefined, route)
		expect(addLogAttributeFilter(included, { ...route, negated: true })).toEqual([
			"!log:http.route=/api/orders",
		])
	})

	it("does not add the same filter twice", () => {
		const once = addLogAttributeFilter(undefined, route)
		expect(addLogAttributeFilter(once, route)).toEqual(once)
	})
})

describe("logAttributeQueryFilters", () => {
	it("splits log and resource filters into the two request fields", () => {
		expect(logAttributeQueryFilters(["log:http.route=/a", "!res:k8s.pod.name=p1"])).toEqual({
			attributeFilters: [{ key: "http.route", value: "/a", mode: "equals" }],
			resourceAttributeFilters: [{ key: "k8s.pod.name", value: "p1", mode: "equals", negated: true }],
		})
	})

	it("leaves both fields undefined when nothing is filtered", () => {
		expect(logAttributeQueryFilters(undefined)).toEqual({
			attributeFilters: undefined,
			resourceAttributeFilters: undefined,
		})
	})
})

describe("matchesLogAttributeFilters", () => {
	it("treats a missing key as an empty value, so an exclusion keeps the row", () => {
		const attributes = { log: { "http.route": "/b" }, resource: {} }
		expect(matchesLogAttributeFilters([route], attributes)).toBe(false)
		expect(matchesLogAttributeFilters([{ ...route, negated: true }], attributes)).toBe(true)
		expect(
			matchesLogAttributeFilters(
				[{ source: "resource", key: "host", value: "h", negated: true }],
				attributes,
			),
		).toBe(true)
	})
})
