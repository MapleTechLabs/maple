import { describe, expect, it } from "vitest"
import { Exit, Schema } from "effect"
import { V2TraceSamplingPolicyUpdateParams } from "./v2/trace-sampling"

const decode = Schema.decodeUnknownExit(V2TraceSamplingPolicyUpdateParams)

describe("V2TraceSamplingPolicyUpdateParams", () => {
	it("accepts the ratio bounds the gateway applies", () => {
		expect(Exit.isSuccess(decode({ trace_sample_ratio: 0.000001 }))).toBe(true)
		expect(Exit.isSuccess(decode({ trace_sample_ratio: 1 }))).toBe(true)
	})

	it("refuses ratios outside 0.000001..1", () => {
		expect(Exit.isFailure(decode({ trace_sample_ratio: 0 }))).toBe(true)
		expect(Exit.isFailure(decode({ trace_sample_ratio: 1.5 }))).toBe(true)
		expect(Exit.isFailure(decode({ trace_sample_ratio: Number.NaN }))).toBe(true)
	})

	it("takes a positive whole slow-span threshold or null to turn it off", () => {
		expect(Exit.isSuccess(decode({ always_keep_slow_spans_ms: 2000 }))).toBe(true)
		expect(Exit.isSuccess(decode({ always_keep_slow_spans_ms: null }))).toBe(true)
		expect(Exit.isFailure(decode({ always_keep_slow_spans_ms: 0 }))).toBe(true)
		expect(Exit.isFailure(decode({ always_keep_slow_spans_ms: 12.5 }))).toBe(true)
		expect(Exit.isFailure(decode({ always_keep_slow_spans_ms: 2 ** 31 }))).toBe(true)
	})

	it("leaves omitted fields out of the decoded patch", () => {
		const exit = decode({ always_keep_error_spans: false })
		expect(Exit.isSuccess(exit) ? exit.value : undefined).toEqual({ always_keep_error_spans: false })
	})
})
