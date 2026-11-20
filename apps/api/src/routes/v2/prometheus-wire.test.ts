import { describe, expect, it } from "@effect/vitest"
import { Effect, String as Str } from "effect"
import type { QueryResult } from "@maple/promql"
import {
	checkResultSize,
	formatValue,
	MAX_RESPONSE_SAMPLES,
	parseStep,
	parseTime,
	parseTimeout,
} from "./prometheus-wire"

const matrix = (series: number, points: number): QueryResult => ({
	resultType: "matrix",
	result: Array.from({ length: series }, (_, i) => ({
		labels: { i: String(i) },
		points: Array.from({ length: points }, (_, t) => ({ t: t * 1000, v: 1 })),
	})),
})

describe("Prometheus wire format", () => {
	it("formats floats as Go's FormatFloat(v, 'f', -1, 64)", () => {
		expect(formatValue(1)).toBe("1")
		expect(formatValue(-0)).toBe("-0")
		expect(formatValue(1.5e-7)).toBe("0.00000015")
		expect(formatValue(-2.5e22)).toBe("-25000000000000000000000")
		expect(formatValue(1.7976931348623157e308)).toMatch(/^179769313486231570+$/)
		expect(formatValue(5e-324)).toBe(`0.${Str.repeat(323)("0")}5`)
	})

	it.effect("parses Prometheus timestamps and steps to epoch ms", () =>
		Effect.gen(function* () {
			expect(yield* parseTime("time", "1752580800.123")).toBe(1752580800123)
			expect(yield* parseTime("time", "2026-07-15T12:00:00.25+02:00")).toBe(
				Date.UTC(2026, 6, 15, 10, 0, 0, 250),
			)
			expect(yield* parseStep("1m30s")).toBe(90_000)
			expect(yield* parseStep("0.25")).toBe(250)
			const invalid = yield* Effect.flip(parseTime("start", "2026-07-15"))
			expect(invalid.message).toBe(
				'invalid parameter "start": cannot parse "2026-07-15" to a valid timestamp',
			)
			// Past what a Date renders (nanoseconds sent as seconds): a 400, not a 500 downstream.
			const huge = yield* Effect.flip(parseTime("time", "1752580800123456789"))
			expect(huge.message).toMatch(/cannot parse/)
			// A clock or calendar field Date would roll over is refused, as Go's time.Parse refuses it.
			for (const text of [
				"2026-07-15T24:00:00Z",
				"2026-02-30T00:00:00Z",
				"2026-07-15T12:60:00Z",
				"2026-13-01T00:00:00Z",
			]) {
				expect((yield* Effect.flip(parseTime("time", text))).message).toMatch(/cannot parse/)
			}
			expect(yield* parseTime("time", "2028-02-29T23:59:59Z")).toBe(Date.UTC(2028, 1, 29, 23, 59, 59))
			// Year 0000 is a leap year; Date.UTC would read it as 1900.
			expect(Number.isFinite(yield* parseTime("time", "0000-02-29T00:00:00Z"))).toBe(true)
			expect((yield* Effect.flip(parseTime("time", "1900-02-29T00:00:00Z"))).message).toMatch(
				/cannot parse/,
			)
		}),
	)

	it.effect("refuses a result past the sample cap before encoding it, counting points across series", () =>
		Effect.gen(function* () {
			const fits = matrix(50, MAX_RESPONSE_SAMPLES / 50)
			expect(yield* checkResultSize(fits)).toBe(fits)
			const over = yield* Effect.flip(checkResultSize(matrix(51, MAX_RESPONSE_SAMPLES / 50)))
			expect(over._tag).toBe("@maple/backend/promql/PromqlExecutionError")
			expect(over.message).toMatch(/result too large.*larger step/)
		}),
	)

	it.effect("parses a timeout as a positive duration or float seconds", () =>
		Effect.gen(function* () {
			expect(yield* parseTimeout("30s")).toBe(30_000)
			expect(yield* parseTimeout("1.5")).toBe(1500)
			expect((yield* Effect.flip(parseTimeout("0"))).message).toMatch(/"timeout"/)
			expect((yield* Effect.flip(parseTimeout("soon"))).message).toMatch(/"timeout"/)
		}),
	)
})
