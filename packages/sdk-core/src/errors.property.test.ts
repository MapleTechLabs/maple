import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { asError, stackWithCauses } from "./errors"

/**
 * A Proxy whose traps throw: reading anything off it is an error of its own.
 * Symbol keys pass through, since fast-check probes those on every value.
 */
const hostileProxy = <T extends Error | Record<string, never>>(target: T): T =>
	new Proxy(target, {
		get: (_inner, key) => {
			if (typeof key === "symbol") return undefined
			throw new Error("get")
		},
		has: (_inner, key) => {
			if (typeof key === "symbol") return false
			throw new Error("has")
		},
		ownKeys: () => {
			throw new Error("ownKeys")
		},
		getPrototypeOf: () => {
			throw new Error("getPrototypeOf")
		},
		getOwnPropertyDescriptor: () => {
			throw new Error("getOwnPropertyDescriptor")
		},
	})

const throwingGetters = fc.constantFrom("message", "name", "stack", "cause", "errors").map((key) => {
	const value = { message: "m" }
	Object.defineProperty(value, key, {
		enumerable: true,
		get: () => {
			throw new Error(key)
		},
	})
	return value
})

/** Anything JavaScript can throw, including the hostile shapes. */
const thrown: fc.Arbitrary<unknown> = fc.oneof(
	fc.anything(),
	fc.string().map((message) => new Error(message)),
	fc.string().map((message) => ({ message })),
	fc.constant(Object.create(null)),
	fc.constant(hostileProxy({})),
	fc.constant(hostileProxy(new Error("inner"))),
	throwingGetters,
	fc.bigInt().map((n) => n),
	fc.constant(Symbol("thrown")),
)

/** An error with a chain of causes, some of them cyclic or hostile. */
const chained: fc.Arbitrary<Error> = fc
	.tuple(fc.array(thrown, { maxLength: 12 }), fc.boolean(), fc.array(thrown, { maxLength: 200 }))
	.map(([causes, cycle, aggregate]) => {
		const root = new Error("root")
		let tail: Error = root
		for (const cause of causes) {
			const next = new Error("wrap", { cause })
			Object.defineProperty(tail, "cause", { value: next, configurable: true })
			tail = next
		}
		if (cycle) Object.defineProperty(tail, "cause", { value: root, configurable: true })
		return Object.assign(root, { errors: aggregate })
	})

describe("asError", () => {
	it("is total: any thrown value becomes an Error whose fields are plain strings", () => {
		fc.assert(
			fc.property(thrown, (value) => {
				const error = asError(value)
				expect(error).toBeInstanceOf(Error)
				expect(typeof error.name).toBe("string")
				expect(typeof error.message).toBe("string")
				expect(error.stack === undefined || typeof error.stack === "string").toBe(true)
			}),
		)
	})

	it("returns a well-formed Error itself, so its identity and extra fields survive", () => {
		fc.assert(
			fc.property(fc.string(), (message) => {
				const error = new RangeError(message)
				expect(asError(error)).toBe(error)
			}),
		)
	})

	it("never gives a value thrown elsewhere a stack made inside the SDK", () => {
		fc.assert(
			fc.property(
				fc.oneof(fc.string(), fc.integer(), fc.dictionary(fc.string(), fc.jsonValue())),
				(value) => {
					expect(asError(value).stack).toBeUndefined()
				},
			),
		)
	})

	it("summarises a plain object by its fields, bounded, never as [object Object]", () => {
		fc.assert(
			fc.property(
				fc.dictionary(
					fc.string({ minLength: 1 }),
					fc.oneof(fc.string(), fc.integer(), fc.boolean()),
					{
						minKeys: 1,
					},
				),
				(value) => {
					fc.pre(!("message" in value))
					const message = asError(value).message
					expect(message).not.toBe("[object Object]")
					expect(message.length).toBeLessThanOrEqual(301)
				},
			),
		)
		expect(asError({ code: 1, reason: "busy" }).message).toBe('{"code":1,"reason":"busy"}')
	})
})

describe("stackWithCauses", () => {
	it("is total over cause cycles, hostile causes and huge aggregates, with a bounded chain", () => {
		fc.assert(
			fc.property(chained, (error) => {
				const stack = stackWithCauses(error) ?? ""
				expect((stack.match(/^Caused by:/gm) ?? []).length).toBeLessThanOrEqual(5)
			}),
		)
	})

	it("is total when the error itself is a hostile Proxy", () => {
		fc.assert(
			fc.property(fc.string(), (message) => {
				const proxy = hostileProxy(new Error(message))
				const error = asError(proxy)
				// A copy, not the Proxy (compared by identity: vitest would read the Proxy to print it).
				expect(error === proxy).toBe(false)
				expect(typeof (stackWithCauses(error) ?? "")).toBe("string")
			}),
		)
	})
})
