import { describe, expect, it } from "vitest"
import { ratioToPercent, samplingDraftFromPolicy, validateSamplingDraft } from "./sampling-draft"

describe("samplingDraftFromPolicy", () => {
	it("shows the ratio as a percentage and an unset threshold as empty", () => {
		expect(samplingDraftFromPolicy({ trace_sample_ratio: 1, always_keep_slow_spans_ms: null })).toEqual({
			keepPercent: "100",
			slowMs: "",
		})
		expect(
			samplingDraftFromPolicy({ trace_sample_ratio: 0.25, always_keep_slow_spans_ms: 2000 }),
		).toEqual({
			keepPercent: "25",
			slowMs: "2000",
		})
	})

	it("hides float noise", () => {
		expect(ratioToPercent(0.07)).toBe("7")
		expect(ratioToPercent(0.000001)).toBe("0.0001")
	})
})

describe("validateSamplingDraft", () => {
	it("turns a percentage into a ratio and an empty threshold into null", () => {
		expect(validateSamplingDraft({ keepPercent: " 25 ", slowMs: "" })).toEqual({
			ok: true,
			payload: { trace_sample_ratio: 0.25, always_keep_slow_spans_ms: null },
		})
		expect(validateSamplingDraft({ keepPercent: "100", slowMs: "1500" })).toEqual({
			ok: true,
			payload: { trace_sample_ratio: 1, always_keep_slow_spans_ms: 1500 },
		})
	})

	it("accepts the smallest ratio the gateway allows", () => {
		const result = validateSamplingDraft({ keepPercent: "0.0001", slowMs: "" })
		expect(result.ok && result.payload.trace_sample_ratio).toBe(0.000001)
	})

	it.each(["0", "0.00001", "101", "-5", "abc", "", "1e2"])("rejects keep percentage %j", (keepPercent) => {
		const result = validateSamplingDraft({ keepPercent, slowMs: "" })
		expect(result.ok).toBe(false)
		expect(!result.ok && result.errors.keepPercent).toBeTruthy()
	})

	it.each(["0", "1.5", "-1", "2147483648", "fast"])("rejects slow threshold %j", (slowMs) => {
		const result = validateSamplingDraft({ keepPercent: "50", slowMs })
		expect(!result.ok && result.errors.slowMs).toBeTruthy()
		expect(!result.ok && result.errors.keepPercent).toBeUndefined()
	})
})
