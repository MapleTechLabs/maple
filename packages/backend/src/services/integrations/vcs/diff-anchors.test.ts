import { assert, describe, it } from "vitest"
import { anchorComments, commentableLines } from "./diff-anchors"

const PATCH = [
	"@@ -1,3 +1,4 @@",
	" one",
	"-two",
	"+two!",
	"+two and a half",
	" three",
	"@@ -20,2 +21,2 @@",
	" twenty",
	"-old",
	"+new",
	"\\ No newline at end of file",
].join("\n")

describe("commentableLines", () => {
	it("maps added and context lines to their hunk, skipping deletions", () => {
		const lines = commentableLines(PATCH)
		assert.deepEqual(
			[...lines.entries()],
			[
				[1, 0],
				[2, 0],
				[3, 0],
				[4, 0],
				[21, 1],
				[22, 1],
			],
		)
	})
})

describe("anchorComments", () => {
	const patches = new Map<string, string | undefined>([
		["a.ts", PATCH],
		["logo.png", undefined],
	])

	it("keeps comments on diff lines and drops the rest", () => {
		const { anchored, dropped } = anchorComments(
			[
				{ path: "a.ts", line: 2 },
				{ path: "a.ts", line: 10 },
				{ path: "b.ts", line: 1 },
				{ path: "logo.png", line: 1 },
			],
			patches,
		)
		assert.deepEqual(
			anchored.map((c) => c.line),
			[2],
		)
		assert.lengthOf(dropped, 3)
	})

	it("keeps a range inside one hunk and drops one that spans two", () => {
		const { anchored, dropped } = anchorComments(
			[
				{ path: "a.ts", startLine: 2, line: 4 },
				{ path: "a.ts", startLine: 3, line: 21 },
				{ path: "a.ts", startLine: 4, line: 2 },
			],
			patches,
		)
		assert.lengthOf(anchored, 1)
		assert.lengthOf(dropped, 2)
	})
})
