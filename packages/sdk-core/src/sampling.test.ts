import { describe, expect, it } from "vitest"
import {
	randomnessValue,
	rejectionThreshold,
	resolveSampleRate,
	sampleSession,
	sessionRoll,
} from "./sampling"

/** The weight ingest derives from `th`: inverse of the acceptance probability. */
const weightOf = (hex: string): number => 1 / (1 - Number.parseInt(hex, 16) / 16 ** hex.length)

describe("rejectionThreshold", () => {
	it("encodes the probability so ingest reads back its inverse as the weight", () => {
		expect(weightOf(rejectionThreshold(0.1))).toBeCloseTo(10, 6)
		expect(weightOf(rejectionThreshold(0.25))).toBeCloseTo(4, 6)
		expect(rejectionThreshold(0.5)).toBe("8")
		expect(rejectionThreshold(1)).toBe("0")
	})
})

describe("randomnessValue", () => {
	it("maps a roll onto 56 bits so that rv >= th exactly when the roll is under the rate", () => {
		const threshold = Math.round((1 - 0.25) * 2 ** 56)
		expect(randomnessValue(0.2)).toBeGreaterThanOrEqual(threshold)
		expect(randomnessValue(0.3)).toBeLessThan(threshold)
		expect(randomnessValue(0)).toBe(2 ** 56 - 1)
	})
})

describe("sessionRoll", () => {
	it("is stable per session and within [0, 1)", () => {
		const roll = sessionRoll("3b0e7f4c-5a8e-4d0a-9b61-0c5a5d1e2f3a")
		expect(roll).toBe(sessionRoll("3b0e7f4c-5a8e-4d0a-9b61-0c5a5d1e2f3a"))
		expect(roll).toBeGreaterThanOrEqual(0)
		expect(roll).toBeLessThan(1)
	})
})

describe("sampleSession", () => {
	it("samples a whole session or none of it, and marks sampled roots with th and rv", () => {
		const ids = Array.from({ length: 40 }, (_, i) => `session-${i}`)
		for (const id of ids) {
			const decision = sampleSession(id, 0.5)
			expect(sampleSession(id, 0.5)).toEqual(decision)
			expect(decision.sampled).toBe(sessionRoll(id) < 0.5)
			if (decision.sampled) {
				expect(decision.traceState).toMatch(/^ot=th:8;rv:[0-9a-f]{14}$/)
				expect(
					Number.parseInt(decision.traceState?.split("rv:")[1] ?? "", 16),
				).toBeGreaterThanOrEqual(2 ** 55)
			}
		}
		expect(ids.some((id) => sampleSession(id, 0.5).sampled)).toBe(true)
		expect(ids.every((id) => sampleSession(id, 0.5).sampled)).toBe(false)
	})

	it("adds no tracestate at rate 1 and keeps nothing at 0", () => {
		expect(sampleSession("any", 1)).toEqual({ sampled: true })
		expect(sampleSession("any", 0)).toEqual({ sampled: false })
	})
})

describe("resolveSampleRate", () => {
	it("defaults, clamps and rejects non-numbers", () => {
		expect(resolveSampleRate("x", undefined)).toBe(1)
		expect(resolveSampleRate("x", undefined, 0)).toBe(0)
		expect(resolveSampleRate("x", 0.3)).toBe(0.3)
		expect(resolveSampleRate("x", 2)).toBe(1)
		expect(resolveSampleRate("x", Number.NaN)).toBe(1)
	})
})
