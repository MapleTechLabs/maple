import { describe, expect, it } from "vitest"
import { exceptionOf, stackWithCauses } from "./error-causes"

const withStack = (error: Error, frames: string): Error => {
	error.stack = `${error.name}: ${error.message}\n${frames}`
	return error
}

describe("stackWithCauses", () => {
	it("returns the stack untouched when nothing is linked", () => {
		const error = withStack(new Error("top"), "    at a (https://app.test/a.js:1:1)")
		expect(stackWithCauses(error)).toBe(error.stack)
		expect(exceptionOf(error)).toBe(error)
	})

	it("appends the cause chain after the error's own frames", () => {
		const root = withStack(new TypeError("socket closed"), "    at read (https://app.test/net.js:5:1)")
		const error = withStack(
			new Error("load failed", { cause: root }),
			"    at load (https://app.test/a.js:1:1)",
		)
		expect(stackWithCauses(error)).toBe(
			[
				"Error: load failed",
				"    at load (https://app.test/a.js:1:1)",
				"Caused by: TypeError: socket closed",
				"    at read (https://app.test/net.js:5:1)",
			].join("\n"),
		)
	})

	it("renders a non-Error cause and the members of an AggregateError", () => {
		const aggregate = new AggregateError([new Error("one"), "two"], "all failed")
		aggregate.stack = "AggregateError: all failed"
		const stack = stackWithCauses(new Error("outer", { cause: aggregate })) ?? ""
		expect(stack).toContain("Caused by: AggregateError: all failed")
		expect(stack).toContain("Caused by: Error: one")
		expect(stack).toContain("Caused by: two")
	})

	it("stops at a cycle and at five linked errors", () => {
		const a = new Error("a")
		const b = new Error("b", { cause: a })
		Object.defineProperty(a, "cause", { value: b })
		expect(stackWithCauses(a)?.match(/Caused by/g)).toHaveLength(1)

		let deep = new Error("0")
		for (let i = 1; i <= 10; i++) deep = new Error(String(i), { cause: deep })
		expect(stackWithCauses(deep)?.match(/Caused by/g)).toHaveLength(5)
	})

	it("keeps a DOMException-style code, which OTel uses as exception.type", () => {
		const error = Object.assign(new Error("gone", { cause: new Error("why") }), { code: 20 })
		expect(exceptionOf(error)).toMatchObject({ code: 20, name: "Error", message: "gone" })
	})
})
