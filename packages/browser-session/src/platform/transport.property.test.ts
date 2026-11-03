import fc from "fast-check"
import { beforeEach, describe, expect, it } from "vitest"
import {
	keepaliveRoom,
	OTLP_KEEPALIVE_BYTES,
	otlpKeepaliveRoom,
	reserveKeepalive,
	resetKeepaliveBudgetForTests,
} from "./transport"

const BUDGET = 48 * 1024

type Op =
	| { kind: "reserve"; bytes: number; otlp: boolean; requested: boolean }
	| { kind: "release"; pick: number }

const op: fc.Arbitrary<Op> = fc.oneof(
	fc.record({
		kind: fc.constant("reserve" as const),
		bytes: fc.oneof(fc.nat(2_048), fc.nat(70 * 1024)),
		otlp: fc.boolean(),
		requested: fc.boolean(),
	}),
	fc.record({ kind: fc.constant("release" as const), pick: fc.nat() }),
)

describe("reserveKeepalive", () => {
	beforeEach(() => resetKeepaliveBudgetForTests())

	it("never lets outstanding bytes pass the budget or OTLP's share, never goes negative, and releases once", () => {
		fc.assert(
			fc.property(fc.array(op, { maxLength: 80 }), (ops) => {
				resetKeepaliveBudgetForTests()
				const held: Array<{ bytes: number; otlp: boolean; release: () => void; released: boolean }> =
					[]
				for (const current of ops) {
					if (current.kind === "reserve") {
						const release = reserveKeepalive(current.requested, current.bytes, current.otlp)
						if (!current.requested) expect(release).toBeUndefined()
						if (release)
							held.push({ bytes: current.bytes, otlp: current.otlp, release, released: false })
					} else if (held.length > 0) {
						// Any reservation, released or not: a second release must change nothing.
						const entry = held[current.pick % held.length]!
						entry.release()
						entry.released = true
					}
					const live = held.filter((entry) => !entry.released)
					const total = live.reduce((sum, entry) => sum + entry.bytes, 0)
					const otlp = live
						.filter((entry) => entry.otlp)
						.reduce((sum, entry) => sum + entry.bytes, 0)
					expect(total).toBeLessThanOrEqual(BUDGET)
					expect(otlp).toBeLessThanOrEqual(OTLP_KEEPALIVE_BYTES)
					expect(keepaliveRoom()).toBe(BUDGET - total)
					expect(otlpKeepaliveRoom()).toBe(Math.min(OTLP_KEEPALIVE_BYTES - otlp, BUDGET - total))
				}
			}),
			{ numRuns: 300 },
		)
	})
})
