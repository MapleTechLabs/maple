import { DateTime, Option } from "effect"
import { describe, expect, it } from "vitest"
import { decodeCacheValue, encodeCacheValue } from "./cache-codec"

const roundTrip = (value: unknown) =>
	Option.map(encodeCacheValue(value), (encoded) => decodeCacheValue(JSON.parse(JSON.stringify(encoded))))

describe("cache codec", () => {
	it("rebuilds Effect timestamps and options inside paged results", () => {
		const startTime = DateTime.makeUnsafe(1_791_991_835_525)
		const page = {
			pages: [[{ traceId: "abc", startTime, parent: Option.none(), root: Option.some("GET /") }]],
			pageParams: [undefined, { timestamp: startTime, traceId: "abc" }],
		}
		const restored = Option.getOrThrow(roundTrip(page))
		expect(restored).toEqual(page)
		const row = Option.getOrThrow(roundTrip([{ startTime }]))
		expect(DateTime.isDateTime(Array.isArray(row) ? row[0].startTime : null)).toBe(true)
	})

	it("keeps values plain JSON would lose", () => {
		const value = {
			nan: Number.NaN,
			inf: Number.POSITIVE_INFINITY,
			big: 2n ** 70n,
			missing: undefined,
			when: new Date(5),
			byName: new Map([["a", 1]]),
			names: new Set(["x"]),
		}
		expect(Option.getOrThrow(roundTrip(value))).toEqual(value)
	})

	it("does not mistake a real field named like the tag for an encoded value", () => {
		const value = { $t: "utc", v: 3 }
		expect(Option.getOrThrow(roundTrip(value))).toEqual(value)
	})

	it("refuses results holding values it cannot rebuild", () => {
		class Row {
			constructor(readonly id: string) {}
		}
		expect(Option.isNone(encodeCacheValue([new Row("a")]))).toBe(true)
		expect(
			Option.isNone(
				encodeCacheValue({ zoned: DateTime.makeZonedUnsafe(0, { timeZone: "Europe/Berlin" }) }),
			),
		).toBe(true)
		const cyclic: Record<string, unknown> = {}
		cyclic.self = cyclic
		expect(Option.isNone(encodeCacheValue(cyclic))).toBe(true)
	})
})
