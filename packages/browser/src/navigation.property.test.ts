import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { parseTraceparent } from "./navigation"

const hex = (length: number) =>
	fc.string({ unit: fc.constantFrom(..."0123456789abcdef"), minLength: length, maxLength: length })
const traceId = hex(32).filter((id) => !/^0+$/.test(id))
const spanId = hex(16).filter((id) => !/^0+$/.test(id))
const flags = hex(2)
/** Any version but the invalid `ff`. */
const version = hex(2).filter((v) => v !== "ff")

describe("parseTraceparent", () => {
	it("accepts every well-formed version-00 header, carrying its ids and flags", () => {
		fc.assert(
			fc.property(traceId, spanId, flags, (trace, span, flag) => {
				expect(parseTraceparent(`00-${trace}-${span}-${flag}`)).toEqual({
					traceId: trace,
					spanId: span,
					traceFlags: Number.parseInt(flag, 16),
					isRemote: true,
				})
			}),
		)
	})

	it("accepts a future version with trailing fields, and rejects them on version 00", () => {
		fc.assert(
			fc.property(
				version,
				traceId,
				spanId,
				flags,
				fc.string({ maxLength: 20 }),
				(v, trace, span, flag, rest) => {
					fc.pre(!rest.includes("\n"))
					const header = `${v}-${trace}-${span}-${flag}-${rest}`
					const parsed = parseTraceparent(header)
					if (v === "00") expect(parsed).toBeUndefined()
					else expect(parsed?.traceId).toBe(trace)
				},
			),
		)
	})

	it("rejects version ff, all-zero ids, uppercase hex and wrong field lengths", () => {
		fc.assert(
			fc.property(traceId, spanId, flags, (trace, span, flag) => {
				expect(parseTraceparent(`ff-${trace}-${span}-${flag}`)).toBeUndefined()
				expect(parseTraceparent(`00-${"0".repeat(32)}-${span}-${flag}`)).toBeUndefined()
				expect(parseTraceparent(`00-${trace}-${"0".repeat(16)}-${flag}`)).toBeUndefined()
				if (/[a-f]/.test(trace))
					expect(parseTraceparent(`00-${trace.toUpperCase()}-${span}-${flag}`)).toBeUndefined()
				expect(parseTraceparent(`00-${trace.slice(1)}-${span}-${flag}`)).toBeUndefined()
				expect(parseTraceparent(`00-${trace}-${span}0-${flag}`)).toBeUndefined()
			}),
		)
	})

	it("never throws, and anything it accepts has valid ids", () => {
		fc.assert(
			fc.property(fc.option(fc.string(), { nil: undefined }), (value) => {
				const parsed = parseTraceparent(value)
				if (parsed === undefined) return
				expect(parsed.traceId).toMatch(/^(?!0{32})[0-9a-f]{32}$/)
				expect(parsed.spanId).toMatch(/^(?!0{16})[0-9a-f]{16}$/)
			}),
		)
	})
})
