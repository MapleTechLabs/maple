import { DateTime } from "effect"
import { describe, expect, it } from "vitest"
import type { TraceListPositionOutput } from "../ch/queries/traces"
import {
	byPosition,
	CANDIDATE_LIMIT,
	mergedPage,
	pageIsExact,
	rootlessCandidates,
	type TraceListSort,
} from "./trace-list-page"

const newest: TraceListSort = { sortBy: "timestamp", sortDir: "desc" }
const at = (traceId: string, second: number, d = 0): TraceListPositionOutput => ({
	traceId,
	ts: DateTime.makeUnsafe(Date.UTC(2024, 0, 1, 12, 0, second)),
	d,
})
const ids = (rows: ReadonlyArray<TraceListPositionOutput>) => rows.map((row) => row.traceId)

describe("byPosition", () => {
	it("orders as stage 1 does: start time in the sort direction, then TraceId descending", () => {
		const rows = [at("a", 10), at("b", 20), at("c", 10)]
		expect(ids([...rows].sort(byPosition(newest)))).toEqual(["b", "c", "a"])
		expect(ids([...rows].sort(byPosition({ sortBy: "timestamp", sortDir: "asc" })))).toEqual([
			"c",
			"a",
			"b",
		])
	})

	it("puts the row's own duration first when sorting by it", () => {
		const rows = [at("a", 10, 5), at("b", 20, 1), at("c", 30, 5)]
		expect(ids([...rows].sort(byPosition({ sortBy: "durationMs", sortDir: "desc" })))).toEqual([
			"c",
			"a",
			"b",
		])
	})
})

describe("rootlessCandidates", () => {
	// Two page slots; roots at 30s and 20s fill them, so the page ends at 20s.
	const roots = [at("r1", 30), at("r2", 20)]

	it("keeps each trace once, at its first entry span in page order", () => {
		const entries = [at("x", 40), at("y", 35), at("x", 33), at("y", 25)]
		const { candidates, completeThrough } = rootlessCandidates(newest, entries, 100, roots, 2)
		expect(candidates).toEqual([at("x", 40), at("y", 35)])
		expect(completeThrough).toBeUndefined()
	})

	it("drops traces the page cannot reach: those first seen after its last root", () => {
		const entries = [at("x", 40), at("z", 15), at("x", 10)]
		expect(ids(rootlessCandidates(newest, entries, 100, roots, 2).candidates)).toEqual(["x"])
	})

	it("reaches to the end of the window when the roots run out before the page does", () => {
		const entries = [at("x", 40), at("z", 15)]
		expect(ids(rootlessCandidates(newest, entries, 100, [at("r1", 30)], 2).candidates)).toEqual([
			"x",
			"z",
		])
		expect(ids(rootlessCandidates(newest, entries, 100, [], 2).candidates)).toEqual(["x", "z"])
	})

	it("reports how far a read got when it filled up before reaching the page's last root", () => {
		const entries = [at("x", 40), at("y", 35)]
		// Full at two rows, the last still above the page's end: more may follow it.
		expect(rootlessCandidates(newest, entries, 2, roots, 2).completeThrough).toEqual(at("y", 35))
		// Full, but it already passed the last root: nothing reachable was missed.
		expect(
			rootlessCandidates(newest, [at("x", 40), at("z", 15)], 2, roots, 2).completeThrough,
		).toBeUndefined()
		// Not full: the entry spans ran out.
		expect(rootlessCandidates(newest, entries, 3, roots, 2).completeThrough).toBeUndefined()
		// Full with no root to stop at: the window may hold more.
		expect(rootlessCandidates(newest, entries, 2, [], 2).completeThrough).toEqual(at("y", 35))
	})

	it("checks no more candidates than one read may name", () => {
		const entries = Array.from({ length: CANDIDATE_LIMIT + 1 }, (_, i) =>
			at(`t${String(i).padStart(5, "0")}`, 59),
		)
		const { candidates, completeThrough } = rootlessCandidates(newest, entries, entries.length + 1, [], 1)
		expect(candidates).toHaveLength(CANDIDATE_LIMIT)
		expect(completeThrough).toEqual(candidates.at(-1))
	})
})

describe("pageIsExact", () => {
	const page = [at("r1", 30), at("x", 25)]

	it("holds for any page cut from complete candidates", () => {
		expect(pageIsExact(newest, page, 2, undefined)).toBe(true)
		expect(pageIsExact(newest, [], 2, undefined)).toBe(true)
	})

	it("holds for a full page that ends where the candidates are still complete", () => {
		expect(pageIsExact(newest, page, 2, at("x", 25))).toBe(true)
		expect(pageIsExact(newest, page, 2, at("y", 10))).toBe(true)
	})

	it("fails for a page that runs past them, or stops short of its limit", () => {
		expect(pageIsExact(newest, page, 2, at("y", 28))).toBe(false)
		expect(pageIsExact(newest, page, 3, at("y", 10))).toBe(false)
	})
})

describe("mergedPage", () => {
	const roots = [at("r1", 30), at("r2", 20), at("r3", 10)]
	const rootless = [at("x", 25), at("y", 5)]

	it("cuts each page from the two lists merged by position, without repeating or skipping", () => {
		const pages = [0, 2, 4].map((offset) => ids(mergedPage(newest, roots, rootless, offset, 2)))
		expect(pages).toEqual([["r1", "x"], ["r2", "r3"], ["y"]])
	})
})
