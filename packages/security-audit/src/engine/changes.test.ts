import { describe, expect, it } from "vitest"
import { changedMatcher, EVERYTHING_CHANGED } from "./changes"

describe("changedMatcher", () => {
	const changed = changedMatcher(["src/a/y.ts", "README.md"])

	it("counts a directory as changed when a file under it changed", () => {
		expect([changed(["src/a"]), changed(["src/a/"]), changed(["src/ab"])]).toEqual([true, true, false])
	})

	it("matches files exactly", () => {
		expect([changed(["README.md"]), changed(["src/a/x.ts"])]).toEqual([true, false])
	})

	it("treats an unreadable diff as everything changed", () => {
		expect(changedMatcher([EVERYTHING_CHANGED])(["anything.ts"])).toBe(true)
	})
})
