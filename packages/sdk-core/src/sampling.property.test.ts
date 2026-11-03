import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { randomnessValue, rejectionThreshold, sampleSession, sessionRoll } from "./sampling"

const MAX_56 = 2 ** 56
const rate = fc.double({ min: 0, max: 1, noNaN: true })
const sessionId = fc.string({ minLength: 1 })

describe("sampleSession", () => {
	it("keeps every session at rate 1 and none at rate 0, with no tracestate at 1", () => {
		fc.assert(
			fc.property(fc.option(sessionId, { nil: undefined }), (id) => {
				expect(sampleSession(id, 1)).toEqual({ sampled: true })
				expect(sampleSession(id, 0)).toEqual({ sampled: false })
			}),
		)
	})

	it("decides the same way for the same session every time", () => {
		fc.assert(
			fc.property(sessionId, rate, (id, r) => {
				expect(sampleSession(id, r)).toEqual(sampleSession(id, r))
			}),
		)
	})

	it("is monotone in the rate: a session kept at one rate is kept at every higher rate", () => {
		fc.assert(
			fc.property(sessionId, rate, rate, (id, a, b) => {
				const [low, high] = a <= b ? [a, b] : [b, a]
				if (sampleSession(id, low).sampled) expect(sampleSession(id, high).sampled).toBe(true)
			}),
		)
	})

	it("stamps a kept session below rate 1 with the threshold and randomness it was decided on", () => {
		fc.assert(
			fc.property(sessionId, fc.double({ min: 0, max: 1, noNaN: true, maxExcluded: true }), (id, r) => {
				const decision = sampleSession(id, r)
				if (!decision.sampled) return
				const match = decision.traceState?.match(/^ot=th:([0-9a-f]+);rv:([0-9a-f]{14})$/)
				expect(match).not.toBeNull()
				expect(match?.[1]).toBe(rejectionThreshold(r))
				// The W3C rule a downstream sampler applies: kept when rv >= th.
				const threshold = Number.parseInt((match?.[1] ?? "").padEnd(14, "0"), 16)
				expect(Number.parseInt(match?.[2] ?? "", 16)).toBeGreaterThanOrEqual(threshold)
			}),
		)
	})
})

describe("rejectionThreshold", () => {
	it("is 56 bits of hex with no trailing zeros, falling as the rate rises", () => {
		fc.assert(
			fc.property(rate, rate, (a, b) => {
				const th = rejectionThreshold(a)
				expect(th).toMatch(/^(0|[0-9a-f]{0,13}[1-9a-f])$/)
				const value = (t: string) => Number.parseInt(t.padEnd(14, "0"), 16)
				if (a <= b)
					expect(value(rejectionThreshold(a))).toBeGreaterThanOrEqual(value(rejectionThreshold(b)))
			}),
		)
		expect(rejectionThreshold(1)).toBe("0")
	})
})

describe("randomnessValue", () => {
	it("maps every roll in [0, 1) into the 56-bit range, falling as the roll rises", () => {
		const roll = fc.double({ min: 0, max: 1, noNaN: true, maxExcluded: true })
		fc.assert(
			fc.property(roll, roll, (a, b) => {
				const rv = randomnessValue(a)
				expect(Number.isInteger(rv)).toBe(true)
				expect(rv).toBeGreaterThanOrEqual(0)
				expect(rv).toBeLessThan(MAX_56)
				if (a <= b) expect(randomnessValue(a)).toBeGreaterThanOrEqual(randomnessValue(b))
			}),
		)
	})

	it("rolls every session id into [0, 1)", () => {
		fc.assert(
			fc.property(fc.string({ unit: "binary" }), (id) => {
				const roll = sessionRoll(id)
				expect(roll).toBeGreaterThanOrEqual(0)
				expect(roll).toBeLessThan(1)
			}),
		)
	})
})
