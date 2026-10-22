import { describe, expect, test } from "vitest"
import { combineRangeMetas, deriveRangeMeta } from "./replay-meta"

const ORIGIN = 1_000_000
const click = (ms: number) => ({ type: 3, timestamp: ORIGIN + ms, data: { source: 2, type: 2 } })
const page = (ms: number, href: string) => ({
	type: 4,
	timestamp: ORIGIN + ms,
	data: { width: 1280, height: 720, href },
})

describe("recording meta across loaded ranges", () => {
	test("a later range's clicks are marked at their place in the whole recording", () => {
		const first = deriveRangeMeta(
			{ fromChunkSeq: 0, toChunkSeq: 3 },
			[page(0, "/a"), click(1_000)],
			ORIGIN,
		)
		const second = deriveRangeMeta(
			{ fromChunkSeq: 4, toChunkSeq: 7 },
			[click(600_000), click(601_000)],
			ORIGIN,
		)
		const meta = combineRangeMetas(ORIGIN, [second, first])
		expect(meta.actionMarkers.map((marker) => marker.ms)).toEqual([1_000, 600_000, 601_000])
	})

	test("the silence between two adjacent ranges is idle, so skip-idle jumps it", () => {
		const first = deriveRangeMeta(
			{ fromChunkSeq: 0, toChunkSeq: 3 },
			[page(0, "/a"), click(40_000)],
			ORIGIN,
		)
		const second = deriveRangeMeta({ fromChunkSeq: 4, toChunkSeq: 7 }, [click(300_000)], ORIGIN)
		expect(combineRangeMetas(ORIGIN, [first, second]).inactiveIntervals).toEqual([
			{ start: 0, end: 40_000 },
			{ start: 40_000, end: 300_000 },
		])
	})

	test("an unloaded stretch between two ranges is not idle", () => {
		const first = deriveRangeMeta({ fromChunkSeq: 0, toChunkSeq: 3 }, [click(0), click(1_000)], ORIGIN)
		const later = deriveRangeMeta({ fromChunkSeq: 8, toChunkSeq: 11 }, [click(500_000)], ORIGIN)
		expect(combineRangeMetas(ORIGIN, [first, later]).inactiveIntervals).toEqual([])
	})

	test("a page change at a range boundary is a navigation marker", () => {
		const first = deriveRangeMeta({ fromChunkSeq: 0, toChunkSeq: 3 }, [page(0, "/a")], ORIGIN)
		const second = deriveRangeMeta({ fromChunkSeq: 4, toChunkSeq: 7 }, [page(1_500, "/b")], ORIGIN)
		expect(combineRangeMetas(ORIGIN, [first, second]).actionMarkers).toEqual([{ ms: 1_500, kind: "nav" }])
	})
})
