import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { boundedStringify, formatArgs } from "./console"

interface Cyclic {
	inner: unknown
	self?: Cyclic
}

/** Values a page might log, getters and throwing proxies included. */
const hostile: fc.Arbitrary<unknown> = fc.letrec<{ value: unknown }>((tie) => ({
	value: fc.oneof(
		{ depthSize: "small" },
		fc.anything({
			withBigInt: true,
			withDate: true,
			withMap: true,
			withSet: true,
			withTypedArray: true,
			withSparseArray: true,
		}),
		fc.dictionary(fc.string(), tie("value"), { maxKeys: 8 }),
		fc.array(tie("value"), { maxLength: 8 }),
		tie("value").map((inner) => {
			const withGetter = { inner }
			Object.defineProperty(withGetter, "boom", {
				enumerable: true,
				get: () => {
					throw new Error("getter ran")
				},
			})
			return withGetter
		}),
		fc.constant(
			new Proxy(
				{},
				{
					ownKeys: () => {
						throw new Error("trap")
					},
				},
			),
		),
		tie("value").map((inner) => {
			const cyclic: Cyclic = { inner }
			cyclic.self = cyclic
			return cyclic
		}),
	),
})).value

describe("console formatting", () => {
	it("never throws, never runs a getter, and stays within the message cap", () => {
		fc.assert(
			fc.property(fc.array(hostile, { maxLength: 6 }), (args) => {
				const message = formatArgs(args)
				expect(message.length).toBeLessThanOrEqual(2_001)
				expect(message).not.toContain("getter ran")
			}),
			{ numRuns: 300 },
		)
	})

	it("stops near its budget however large the value", () => {
		fc.assert(
			fc.property(hostile, fc.integer({ min: 0, max: 500 }), (value, budget) => {
				// Past the budget only the brackets of the containers still open are written.
				expect(boundedStringify(value, budget).length).toBeLessThanOrEqual(budget + 40)
			}),
			{ numRuns: 300 },
		)
	})

	it("bounds a very wide or very long value", () => {
		const wide = Object.fromEntries(Array.from({ length: 100_000 }, (_, index) => [`key${index}`, index]))
		expect(
			formatArgs([wide, Array.from({ length: 100_000 }, () => "x".repeat(50))]).length,
		).toBeLessThanOrEqual(2_001)
	})
})
