import { describe, expect, it } from "vitest"
import { describeSpanEvent, formatEventOffset } from "./span-events"

const event = (name: string, attributes: Record<string, string>) => ({
	name,
	timestamp: "2026-03-20T08:00:00.000Z",
	offsetMs: 0,
	attributes,
})

describe("describeSpanEvent", () => {
	it("pulls the semconv fields out of an exception event", () => {
		const described = describeSpanEvent(
			event("exception", {
				"exception.type": "TypeError",
				"exception.message": "x is undefined",
				"exception.stacktrace": "TypeError: x is undefined\n    at f (a.js:1:1)",
				"exception.escaped": "true",
			}),
		)
		expect(described).toEqual({
			kind: "exception",
			type: "TypeError",
			message: "x is undefined",
			stacktrace: "TypeError: x is undefined\n    at f (a.js:1:1)",
			attributes: { "exception.escaped": "true" },
		})
	})

	it("treats blank exception fields as absent", () => {
		const described = describeSpanEvent(event("exception", { "exception.message": "" }))
		expect(described).toMatchObject({ kind: "exception", message: undefined, stacktrace: undefined })
	})

	it("passes other events through with all attributes", () => {
		expect(describeSpanEvent(event("cache.miss", { "exception.type": "kept" }))).toEqual({
			kind: "event",
			attributes: { "exception.type": "kept" },
		})
	})
})

describe("formatEventOffset", () => {
	it("signs the offset and keeps microsecond precision", () => {
		expect(formatEventOffset(12.4)).toBe("+12.400ms")
		expect(formatEventOffset(0.25)).toBe("+250μs")
		expect(formatEventOffset(-1.5)).toBe("-1.500ms")
		expect(formatEventOffset(2500)).toBe("+2.500s")
		expect(formatEventOffset(1000)).toBe("+1.000s")
		expect(formatEventOffset(1000.123)).toBe("+1.000123s")
		expect(formatEventOffset(-61_000.5)).toBe("-61.0005s")
	})
})
