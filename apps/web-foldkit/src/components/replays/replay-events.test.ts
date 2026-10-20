import { describe, it, expect } from "vitest"
import { normalizeEvents } from "./replay-events"

const ev = (timestamp: number, tag: string) => ({ timestamp, tag })

describe("normalizeEvents", () => {
	it("leaves an already-ordered stream untouched", () => {
		const events = [ev(1000, "a"), ev(2000, "b"), ev(3000, "c")]
		expect(normalizeEvents(events)).toEqual(events)
	})

	it("sorts a scrambled stream by timestamp", () => {
		const events = [ev(3000, "c"), ev(1000, "a"), ev(2000, "b")]
		expect(normalizeEvents(events)).toEqual([ev(1000, "a"), ev(2000, "b"), ev(3000, "c")])
	})

	it("drops exact duplicates from overwritten/re-presigned chunks", () => {
		const events = [ev(1000, "a"), ev(1000, "a"), ev(2000, "b")]
		expect(normalizeEvents(events)).toEqual([ev(1000, "a"), ev(2000, "b")])
	})

	it("keeps distinct events that share a timestamp, in original order", () => {
		const events = [ev(1000, "a"), ev(1000, "b")]
		expect(normalizeEvents(events)).toEqual([ev(1000, "a"), ev(1000, "b")])
	})

	it("collapses a corrupted span back to its real range", () => {
		// A scrambled stream where late chunks (t=12_465_000 ≈ 207min) interleave
		// with early ones — the bug that inflated rrweb's totalTime. After
		// normalization the first/last timestamps frame the true ordered span.
		const events = [
			ev(12_465_000, "stale"),
			ev(1000, "start"),
			ev(12_465_000, "stale"), // duplicate
			ev(42_000, "end"),
		]
		const out = normalizeEvents(events) as Array<{ timestamp: number }>
		expect(out.map((e) => e.timestamp)).toEqual([1000, 42_000, 12_465_000])
		expect(out.at(-1)!.timestamp - out[0]!.timestamp).toBe(12_464_000)
	})
})
