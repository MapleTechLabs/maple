import type { Attributes } from "@opentelemetry/api"
import { describe, expect, it } from "vitest"
import { addAttribute, cleanAttributes } from "./attributes"

describe("attribute values", () => {
	it("keeps a plain object whose own key is named constructor", () => {
		const value = { constructor: "Widget", count: 1 }
		const { attributes, dropped } = cleanAttributes({ widget: value })
		expect(dropped).toBe(0)
		expect(attributes["widget"]).toEqual({ constructor: "Widget", count: 1 })
	})

	it("drops a class instance and keeps a null-prototype object", () => {
		const bare: Record<string, number> = Object.create(null)
		bare["n"] = 1
		const { attributes, dropped } = cleanAttributes({ date: new Date(0), bare })
		expect(dropped).toBe(1)
		expect(Object.keys(attributes)).toEqual(["bare"])
	})
})

describe("an attribute key named __proto__", () => {
	it("is stored as an own attribute, not through the prototype setter", () => {
		const target: Attributes = {}
		expect(addAttribute(target, 0, "__proto__", "value")).toBe("added")
		expect(Object.keys(target)).toEqual(["__proto__"])
		expect(Object.getPrototypeOf(target)).toBe(Object.prototype)
	})

	it("survives cleaning input parsed from JSON", () => {
		const parsed: Attributes = JSON.parse('{"__proto__":"value","other":1}')
		const { attributes } = cleanAttributes(parsed)
		expect(Object.entries(attributes)).toEqual([
			["__proto__", "value"],
			["other", 1],
		])
	})
})
