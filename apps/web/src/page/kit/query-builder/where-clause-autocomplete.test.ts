import { describe, expect, it } from "vitest"

import { applyWhereClauseSuggestion, getWhereClauseAutocomplete } from "./where-clause-autocomplete"
import { Array as Arr, String as Str } from "effect"

describe("where clause autocomplete", () => {
	it("suggests keys at an empty query", () => {
		const result = getWhereClauseAutocomplete({
			expression: "",
			cursor: 0,
			dataSource: "traces",
		})

		expect(result.context).toBe("key")
		expect(Arr.some(result.suggestions, (item) => item.insertText === "service.name")).toBe(true)
	})

	it("suggests operator after a key", () => {
		const expression = "service.name "
		const result = getWhereClauseAutocomplete({
			expression,
			cursor: expression.length,
			dataSource: "logs",
			maxSuggestions: 20,
		})

		expect(result.context).toBe("operator")
		expect(Arr.map(result.suggestions, (item) => item.insertText)).toEqual([
			"=",
			"!=",
			">",
			"<",
			">=",
			"<=",
			"contains",
			"!contains",
			"exists",
			"!exists",
		])
	})

	it("treats != as an operator and parses value context after it", () => {
		const expression = 'service.name != "chec'
		const result = getWhereClauseAutocomplete({
			expression,
			cursor: expression.length,
			dataSource: "traces",
			values: {
				services: ["checkout", "cart"],
			},
		})

		expect(result.context).toBe("value")
		expect(Arr.some(result.suggestions, (item) => Str.includes("checkout")(item.insertText))).toBe(true)
	})

	it("treats !exists as a no-value operator and routes to conjunction context", () => {
		const expression = "attr.user_id !exists "
		const result = getWhereClauseAutocomplete({
			expression,
			cursor: expression.length,
			dataSource: "traces",
		})

		expect(result.context).toBe("conjunction")
	})

	it("suggests values for the active key", () => {
		const expression = 'service.name = "chec'
		const result = getWhereClauseAutocomplete({
			expression,
			cursor: expression.length,
			dataSource: "traces",
			values: {
				services: ["checkout", "cart"],
			},
		})

		expect(result.context).toBe("value")
		expect(result.key).toBe("service.name")
		expect(result.suggestions[0]?.label).toBe("checkout")
		expect(result.suggestions[0]?.insertText).toBe('"checkout"')
	})

	it("escapes every quote and backslash in a suggested value", () => {
		const expression = "service.name = "
		const result = getWhereClauseAutocomplete({
			expression,
			cursor: expression.length,
			dataSource: "traces",
			values: { services: ['a"b\\c"\\'] },
		})

		expect(result.suggestions[0]?.insertText).toBe('"a\\"b\\\\c\\"\\\\"')
	})

	it("suggests conjunction after a finished value", () => {
		const expression = 'service.name = "checkout" '
		const result = getWhereClauseAutocomplete({
			expression,
			cursor: expression.length,
			dataSource: "traces",
		})

		expect(result.context).toBe("conjunction")
		expect(Arr.map(result.suggestions, (item) => item.insertText)).toEqual(["AND"])
	})

	it("applies operator suggestion with normalized spacing", () => {
		const expression = "service.name "
		const autocomplete = getWhereClauseAutocomplete({
			expression,
			cursor: expression.length,
			dataSource: "logs",
		})

		const applied = applyWhereClauseSuggestion({
			expression,
			context: autocomplete.context,
			replaceStart: autocomplete.replaceStart,
			replaceEnd: autocomplete.replaceEnd,
			suggestion: Arr.getUnsafe(autocomplete.suggestions, 0),
		})

		expect(applied.expression).toBe("service.name = ")
	})

	it("applies value suggestion with quotes and trailing space", () => {
		const expression = "service.name = che"
		const autocomplete = getWhereClauseAutocomplete({
			expression,
			cursor: expression.length,
			dataSource: "traces",
			values: {
				services: ["checkout"],
			},
		})

		const applied = applyWhereClauseSuggestion({
			expression,
			context: autocomplete.context,
			replaceStart: autocomplete.replaceStart,
			replaceEnd: autocomplete.replaceEnd,
			suggestion: Arr.getUnsafe(autocomplete.suggestions, 0),
		})

		expect(applied.expression).toBe('service.name = "checkout" ')
	})

	it("applies conjunction suggestion with single spacing", () => {
		const expression = 'service.name = "checkout" '
		const autocomplete = getWhereClauseAutocomplete({
			expression,
			cursor: expression.length,
			dataSource: "logs",
		})

		const applied = applyWhereClauseSuggestion({
			expression,
			context: autocomplete.context,
			replaceStart: autocomplete.replaceStart,
			replaceEnd: autocomplete.replaceEnd,
			suggestion: Arr.getUnsafe(autocomplete.suggestions, 0),
		})

		expect(applied.expression).toBe('service.name = "checkout" AND ')
	})

	it("supports trace_search key suggestions without changing default traces scope", () => {
		const defaultScope = getWhereClauseAutocomplete({
			expression: "http",
			cursor: 4,
			dataSource: "traces",
		})
		const traceScope = getWhereClauseAutocomplete({
			expression: "http",
			cursor: 4,
			dataSource: "traces",
			scope: "trace_search",
		})

		expect(Arr.some(defaultScope.suggestions, (item) => item.insertText === "http.method")).toBe(false)
		expect(Arr.some(traceScope.suggestions, (item) => item.insertText === "http.method")).toBe(true)
	})

	it("suggests resource attribute keys when typing resource. prefix", () => {
		const result = getWhereClauseAutocomplete({
			expression: "resource.",
			cursor: "resource.".length,
			dataSource: "traces",
			scope: "trace_search",
			values: {
				resourceAttributeKeys: ["service.version", "telemetry.sdk.name"],
			},
		})

		expect(result.context).toBe("key")
		expect(Arr.some(result.suggestions, (item) => item.insertText === "resource.service.version")).toBe(
			true,
		)
		expect(
			Arr.some(result.suggestions, (item) => item.insertText === "resource.telemetry.sdk.name"),
		).toBe(true)
	})

	it("suggests resource attribute values after resource.<key> =", () => {
		const result = getWhereClauseAutocomplete({
			expression: 'resource.service.version = "1.',
			cursor: 'resource.service.version = "1.'.length,
			dataSource: "traces",
			scope: "trace_search",
			values: {
				resourceAttributeValues: ["1.0.0", "1.2.3", "2.0.0"],
			},
		})

		expect(result.context).toBe("value")
		expect(result.key).toBe("resource.service.version")
		expect(result.suggestions[0]?.label).toBe("1.0.0")
		expect(result.suggestions[1]?.label).toBe("1.2.3")
	})

	it("suggests trace_search values for HTTP and booleans", () => {
		const method = getWhereClauseAutocomplete({
			expression: "http.method = ge",
			cursor: "http.method = ge".length,
			dataSource: "traces",
			scope: "trace_search",
			values: {
				httpMethods: ["GET", "POST"],
			},
		})
		const hasError = getWhereClauseAutocomplete({
			expression: "has_error = ",
			cursor: "has_error = ".length,
			dataSource: "traces",
			scope: "trace_search",
		})

		expect(method.context).toBe("value")
		expect(method.suggestions[0]?.label).toBe("GET")
		expect(method.suggestions[0]?.insertText).toBe('"GET"')
		expect(Arr.map(hasError.suggestions, (item) => item.insertText)).toEqual(["true", "false"])
	})

	it("suggests attr keys for logs data source", () => {
		const result = getWhereClauseAutocomplete({
			expression: "attr.",
			cursor: "attr.".length,
			dataSource: "logs",
			values: {
				attributeKeys: ["http.method", "user.id"],
			},
		})

		expect(result.context).toBe("key")
		expect(Arr.some(result.suggestions, (item) => item.insertText === "attr.http.method")).toBe(true)
		expect(Arr.some(result.suggestions, (item) => item.insertText === "attr.user.id")).toBe(true)
	})

	it("shows attr.<key> hint in logs key suggestions", () => {
		const result = getWhereClauseAutocomplete({
			expression: "",
			cursor: 0,
			dataSource: "logs",
		})

		expect(Arr.some(result.suggestions, (item) => item.insertText === "attr.")).toBe(true)
		expect(Arr.some(result.suggestions, (item) => item.insertText === "resource.")).toBe(true)
	})

	it("suggests dashboard variables first in value position", () => {
		const expression = "service.name = "
		const result = getWhereClauseAutocomplete({
			expression,
			cursor: expression.length,
			dataSource: "traces",
			values: { services: ["api", "web"], variables: ["service", "env"] },
		})

		expect(result.context).toBe("value")
		expect(result.suggestions[0]).toMatchObject({
			label: "$service",
			insertText: '"$service"',
			description: "Dashboard variable",
		})
		expect(Arr.some(result.suggestions, (item) => item.insertText === '"api"')).toBe(true)
	})

	it("matches variables when typing $", () => {
		const expression = "service.name = $en"
		const result = getWhereClauseAutocomplete({
			expression,
			cursor: expression.length,
			dataSource: "traces",
			values: { variables: ["service", "env"] },
		})

		expect(Arr.map(result.suggestions, (item) => item.label)).toContain("$env")
		expect(Arr.map(result.suggestions, (item) => item.label)).not.toContain("$service")
	})

	it("suggests no variables when none are defined", () => {
		const expression = "service.name = "
		const result = getWhereClauseAutocomplete({
			expression,
			cursor: expression.length,
			dataSource: "traces",
			values: { services: ["api"] },
		})

		expect(Arr.every(result.suggestions, (item) => item.description !== "Dashboard variable")).toBe(true)
	})
})

describe("where clause autocomplete: funnel scopes", () => {
	it("offers the population-filter vocabulary under product_events, whatever the data source", () => {
		const result = getWhereClauseAutocomplete({
			expression: "",
			cursor: 0,
			dataSource: "traces",
			scope: "product_events",
			maxSuggestions: 20,
		})
		const keys = Arr.map(result.suggestions, (item) => item.insertText)
		expect(keys).toContain("country")
		expect(keys).toContain("utm.source")
		expect(keys).toContain("visitor_type")
		expect(keys).not.toContain("service.name")
	})

	it("completes values from the facets and only offers =", () => {
		const values = getWhereClauseAutocomplete({
			expression: "country = ",
			cursor: "country = ".length,
			dataSource: "traces",
			scope: "product_events",
			values: { productEventFacets: { country: ["DE", "US"] } },
		})
		expect(Arr.map(values.suggestions, (item) => item.label)).toEqual(["DE", "US"])

		const operators = getWhereClauseAutocomplete({
			expression: "country ",
			cursor: "country ".length,
			dataSource: "traces",
			scope: "product_events",
		})
		expect(operators.context).toBe("operator")
		expect(Arr.map(operators.suggestions, (item) => item.insertText)).toEqual(["="])
	})

	it("suggests no keys for a step's attribute filter — they are the customer's own", () => {
		const result = getWhereClauseAutocomplete({
			expression: "",
			cursor: 0,
			dataSource: "traces",
			scope: "product_event_attributes",
			values: { attributeKeys: ["http.route"] },
		})
		expect(result.suggestions).toEqual([])
	})
})
