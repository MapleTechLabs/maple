import { describe, expect, it } from "vitest"
import { normalizeIdentity } from "./identity"

describe("normalizeIdentity", () => {
	it("accepts the legacy bare user id", () => {
		// Every existing caller passes a string; this is what lets the richer
		// identity ship without touching them.
		expect(normalizeIdentity("user_123")).toEqual({
			id: "user_123",
			traits: {},
		})
	})

	it("clears on null, undefined, and empty input", () => {
		expect(normalizeIdentity(null)).toBeUndefined()
		expect(normalizeIdentity(undefined)).toBeUndefined()
		expect(normalizeIdentity("   ")).toBeUndefined()
		// An object with nothing usable reads the same as clearing.
		expect(normalizeIdentity({})).toBeUndefined()
		expect(normalizeIdentity({ id: "", email: undefined })).toBeUndefined()
	})

	it("keeps the full Better Stack-shaped identity", () => {
		expect(
			normalizeIdentity({
				id: "user_123",
				email: "user@example.com",
				username: "John Doe",
				groupId: "org_456",
				groupName: "Acme Inc.",
				traits: { plan: "premium" },
			}),
		).toEqual({
			id: "user_123",
			email: "user@example.com",
			username: "John Doe",
			groupId: "org_456",
			groupName: "Acme Inc.",
			traits: { plan: "premium" },
		})
	})

	it("coerces trait values and drops the unusable ones", () => {
		const resolved = normalizeIdentity({
			id: "u",
			traits: { seats: 12, trial: false, missing: null, absent: undefined },
		})
		// The column is Map(_, String), and a stored "undefined" is worse than an
		// absent key.
		expect(resolved?.traits).toEqual({ seats: "12", trial: "false" })
	})

	it("caps trait count, key length and value length", () => {
		const traits: Record<string, string> = {}
		for (let i = 0; i < 100; i++) traits[`k${i}`] = "v"
		traits["x".repeat(200)] = "y".repeat(1000)

		const resolved = normalizeIdentity({ id: "u", traits })
		// Trait keys share a ClickHouse LowCardinality dictionary, so an unbounded
		// key space degrades every query on the table.
		expect(Object.keys(resolved?.traits ?? {})).toHaveLength(24)
		for (const [key, value] of Object.entries(resolved?.traits ?? {})) {
			expect(key.length).toBeLessThanOrEqual(64)
			expect(value.length).toBeLessThanOrEqual(256)
		}
	})

	it("trims surrounding whitespace", () => {
		expect(normalizeIdentity({ id: "  user_123  ", groupId: " org_1 " })).toMatchObject({
			id: "user_123",
			groupId: "org_1",
		})
	})

	it("keeps numeric ids from untyped callers and ignores other non-strings", () => {
		// `identify({ id: 42 })` used to throw "trim is not a function" into the host app.
		expect(normalizeIdentity({ id: 42 } as never)).toEqual({ id: "42", traits: {} })
		expect(normalizeIdentity({ id: 9007199254740993n, email: { at: "x" } } as never)).toEqual({
			id: "9007199254740993",
			traits: {},
		})
		expect(normalizeIdentity(42 as never)).toEqual({ id: "42", traits: {} })
		expect(normalizeIdentity({ id: Number.NaN, username: ["x"] } as never)).toBeUndefined()
	})

	it("caps id lengths without splitting a surrogate pair", () => {
		const resolved = normalizeIdentity({ id: `${"a".repeat(255)}😀tail` })
		expect(resolved?.id).toBe("a".repeat(255))
	})

	it("keeps a __proto__ trait as data, leaving every prototype alone", () => {
		const traits = JSON.parse('{"__proto__": "admin", "plan": "pro"}')
		const resolved = normalizeIdentity({ id: "u", traits })
		expect(Object.entries(resolved?.traits ?? {})).toEqual([
			["__proto__", "admin"],
			["plan", "pro"],
		])
		expect(Object.getPrototypeOf(resolved?.traits)).toBe(Object.prototype)
	})

	it("keeps the first of two trait keys that collide once truncated", () => {
		const prefix = "k".repeat(64)
		const resolved = normalizeIdentity({
			id: "u",
			traits: { [`${prefix}1`]: "first", [`${prefix}2`]: "second" },
		})
		expect(resolved?.traits).toEqual({ [prefix]: "first" })
	})
})
