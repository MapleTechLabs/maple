import { describe, expect, it } from "vitest"
import { Effect, Exit, Schema } from "effect"
import { toInputSchema } from "../tools/registry"
import * as P from "./params"

const decode = <S extends Schema.Codec<unknown, unknown, never, unknown>>(schema: S, input: unknown) =>
	Schema.decodeUnknownExit(schema)(input)

describe("MCP parameter vocabulary", () => {
	const limited = Schema.Struct({ limit: P.limit({ default: 20, max: 200, noun: "rows" }) })

	it("defaults, clamps and accepts numeric strings for limit", () => {
		expect(Schema.decodeUnknownSync(limited)({})).toEqual({ limit: 20 })
		expect(Schema.decodeUnknownSync(limited)({ limit: "15" })).toEqual({ limit: 15 })
		expect(Schema.decodeUnknownSync(limited)({ limit: 5000 })).toEqual({ limit: 200 })
		expect(Schema.decodeUnknownSync(limited)({ limit: 0.5 })).toEqual({ limit: 1 })
		expect(Exit.isFailure(decode(limited, { limit: "soon" }))).toBe(true)
		expect(Exit.isFailure(decode(limited, { limit: "" }))).toBe(true)
	})

	it("publishes the limit's default and cap in its description, as an optional number", () => {
		const schema = toInputSchema(limited)
		expect(schema.required ?? []).not.toContain("limit")
		expect(JSON.stringify(schema)).toContain("Max rows to return (default 20, max 200)")
	})

	it("reads a blank text filter as absent and trims the rest", () => {
		const schema = Schema.Struct({ service: P.service() })
		expect(Schema.decodeUnknownSync(schema)({ service: "  " })).toEqual({})
		expect(Schema.decodeUnknownSync(schema)({ service: " api " })).toEqual({ service: "api" })
		expect(Schema.decodeUnknownSync(schema)({})).toEqual({})
		expect(JSON.stringify(toInputSchema(schema))).toContain("Only this service")
	})

	it("accepts a list as an array or a comma-separated string", () => {
		const schema = Schema.Struct({ services: P.optionalList("services") })
		expect(Schema.decodeUnknownSync(schema)({ services: "a, b,,c" })).toEqual({
			services: ["a", "b", "c"],
		})
		expect(Schema.decodeUnknownSync(schema)({ services: ["a"] })).toEqual({ services: ["a"] })
	})

	it("accepts boolean spellings", () => {
		const schema = Schema.Struct({ on: P.optionalFlag("on") })
		expect(Schema.decodeUnknownSync(schema)({ on: "true" })).toEqual({ on: true })
		expect(Schema.decodeUnknownSync(schema)({ on: "0" })).toEqual({ on: false })
		expect(Exit.isFailure(decode(schema, { on: "yes please" }))).toBe(true)
	})

	it("decodes a JSON parameter from its text or the object itself", () => {
		const Layout = Schema.Struct({ x: Schema.Number })
		const schema = Schema.Struct({ layout: P.optionalJson(Layout, "layout") })
		expect(Schema.decodeUnknownSync(schema)({ layout: '{"x":1}' })).toEqual({ layout: { x: 1 } })
		expect(Schema.decodeUnknownSync(schema)({ layout: { x: 2 } })).toEqual({ layout: { x: 2 } })
		expect(Exit.isFailure(decode(schema, { layout: '{"x":"one"}' }))).toBe(true)
	})

	describe("timeWindow", () => {
		const window = P.timeWindow({ defaultHours: 6, maxHours: 24 })
		const schema = Schema.Struct(window.fields)

		it("states the default and the cap in the published description", () => {
			const published = JSON.stringify(toInputSchema(schema))
			expect(published).toContain("Default: 6 hours before end_time.")
			expect(published).toContain("at most 1 day")
		})

		it("rejects a window wider than the cap as an input error naming the fix", async () => {
			const params = Schema.decodeUnknownSync(schema)({
				start_time: "2026-09-01 00:00:00",
				end_time: "2026-09-03 00:00:00",
			})
			const exit = await Effect.runPromiseExit(window.resolve(params, "search_traces"))
			expect(Exit.isFailure(exit)).toBe(true)
			expect(JSON.stringify(exit)).toContain("Time range too large for `search_traces`")
		})

		it("rejects an inverted window", async () => {
			const params = Schema.decodeUnknownSync(schema)({
				start_time: "2026-09-03 00:00:00",
				end_time: "2026-09-01 00:00:00",
			})
			const exit = await Effect.runPromiseExit(window.resolve(params, "find_errors"))
			expect(JSON.stringify(exit)).toContain("is after end_time")
		})

		it("accepts ISO 8601 and the warehouse format alike", async () => {
			const params = Schema.decodeUnknownSync(schema)({
				start_time: "2026-09-01T00:00:00Z",
				end_time: "2026-09-01 03:00:00",
			})
			const range = await Effect.runPromise(window.resolve(params, "find_errors"))
			expect(range).toEqual({ st: "2026-09-01 00:00:00", et: "2026-09-01 03:00:00" })
		})
	})
})
