import { describe, expect, it } from "vitest"
import { asError, stackWithCauses } from "./errors"

const withStack = (error: Error, frames: string): Error => {
	error.stack = `${error.name}: ${error.message}\n${frames}`
	return error
}

describe("stackWithCauses", () => {
	it("returns the stack untouched when nothing is linked", () => {
		const error = withStack(new Error("top"), "    at a (https://app.test/a.js:1:1)")
		expect(stackWithCauses(error)).toBe(error.stack)
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

	it("never throws on a cause that cannot be turned into a string", () => {
		const hostile = Object.create(null)
		const throwing = {
			toString() {
				throw new Error("nope")
			},
		}
		expect(stackWithCauses(new Error("a", { cause: hostile }))).toContain("Caused by: [object Object]")
		expect(stackWithCauses(new Error("b", { cause: throwing }))).toContain("Caused by: [object Object]")
	})

	it("renders plain members of an errors list by their message, and ignores non-error objects' lists", () => {
		// A GraphQL-style error: `errors` holds plain `{ message }` objects.
		const graphql = Object.assign(new Error("query failed"), { errors: [{ message: "field missing" }] })
		expect(stackWithCauses(graphql)).toContain("Caused by: field missing")
		const notAnError = { errors: [new Error("hidden")] }
		expect(stackWithCauses(new Error("outer", { cause: notAnError }))).not.toContain("hidden")
	})

	it("walks copies that are Error-shaped but not Error instances", () => {
		// Effect's pretty errors are plain Errors carrying copied fields: no AggregateError prototype.
		const copy = Object.assign(new Error("all failed"), {
			name: "AggregateError",
			errors: [new Error("one")],
		})
		const outer = new Error("outer", { cause: copy })
		const stack = stackWithCauses(outer) ?? ""
		expect(stack).toContain("Caused by: AggregateError: all failed")
		expect(stack).toContain("Caused by: Error: one")
	})
})

describe("asError", () => {
	it("narrows whatever was thrown without throwing itself", () => {
		const error = new TypeError("x")
		expect(asError(error)).toBe(error)
		expect(asError("boom").message).toBe("boom")
		expect(asError({ message: "shaped" }).message).toBe("shaped")
		expect(asError(42).message).toBe("42")
		expect(asError(Object.create(null)).message).toBe("Unknown error")
	})
})
