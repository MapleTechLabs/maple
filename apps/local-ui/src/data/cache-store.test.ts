import { DateTime, Option } from "effect"
import { describe, expect, test } from "vitest"
import {
	type CacheEntry,
	type CacheValue,
	hashKey,
	MAX_AGE_MS,
	newestOlderWindow,
	parseSaved,
	serialize,
} from "./cache-store"

const NOW = Date.parse("2026-10-01T12:00:00Z")
const entry = (key: ReadonlyArray<unknown>, updatedAtMs: number, data: CacheValue = []): CacheEntry => ({
	key,
	data,
	updatedAtMs,
})
const mapOf = (...entries: ReadonlyArray<CacheEntry>) =>
	new Map(entries.map((item) => [hashKey(item.key), item]))

describe("hashKey", () => {
	test("ignores object key order and undefined fields", () => {
		expect(hashKey(["local", { b: 1, a: undefined, c: "x" }])).toBe(hashKey(["local", { c: "x", b: 1 }]))
	})
})

describe("newestOlderWindow", () => {
	const filters = { errorsOnly: false }
	const current = ["local", "traces", filters, "2026-10-01 11:00:00/2026-10-01 12:00:00"]

	test("picks the newest earlier window of the same length for the same view", () => {
		const older = entry(
			["local", "traces", filters, "2026-10-01 09:00:00/2026-10-01 10:00:00"],
			NOW - 7_200_000,
		)
		const newer = entry(
			["local", "traces", filters, "2026-10-01 10:00:00/2026-10-01 11:00:00"],
			NOW - 3_600_000,
		)
		expect(newestOlderWindow(mapOf(older, newer), current)).toEqual(Option.some(newer))
	})

	test("skips other views, other lengths and later windows", () => {
		const otherFilters = entry(
			["local", "traces", { errorsOnly: true }, "2026-10-01 10:00:00/2026-10-01 11:00:00"],
			NOW,
		)
		const longer = entry(["local", "traces", filters, "2026-10-01 05:00:00/2026-10-01 11:00:00"], NOW)
		const later = entry(["local", "traces", filters, "2026-10-01 11:30:00/2026-10-01 12:30:00"], NOW)
		expect(newestOlderWindow(mapOf(otherFilters, longer, later), current)).toEqual(Option.none())
	})

	test("a key without a window has no stand-in", () => {
		expect(
			newestOlderWindow(mapOf(entry(["local", "trace", "a"], NOW)), ["local", "trace", "b"]),
		).toEqual(Option.none())
	})
})

describe("saved form", () => {
	test("round-trips Effect values and drops entries older than a day", () => {
		const startTime = DateTime.makeUnsafe(NOW - 1_000)
		const fresh = entry(["local", "trace", "t1"], NOW - 60_000, {
			rows: [{ startTime, maybe: Option.some(1) }],
		})
		const stale = entry(["local", "trace", "t2"], NOW - MAX_AGE_MS - 1)
		const restored = parseSaved(serialize(mapOf(fresh, stale)), NOW)
		expect([...restored.keys()]).toEqual([hashKey(fresh.key)])
		expect(restored.get(hashKey(fresh.key))?.data).toEqual(fresh.data)
	})

	test("unreadable text restores nothing", () => {
		expect(parseSaved("{not json", NOW).size).toBe(0)
	})
})
