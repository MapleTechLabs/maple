import { assert, describe, it } from "vitest"
import { type FileChange, rangeDiffPaths } from "./range-diff"

const file = (path: string, patch: string | undefined, overrides: Partial<FileChange> = {}): FileChange => ({
	path,
	status: "modified",
	patch,
	...overrides,
})

describe("rangeDiffPaths", () => {
	it("ignores a file whose change only moved, as a rebase onto a newer base does", () => {
		const before = [file("src/a.ts", "@@ -10,3 +10,4 @@ fn\n ctx\n+added\n ctx")]
		const after = [file("src/a.ts", "@@ -42,3 +42,4 @@ fn\n ctx\n+added\n ctx")]
		assert.deepEqual(rangeDiffPaths(before, after), [])
	})

	it("reports files whose change differs, joined, or left the pull request", () => {
		const before = [
			file("src/a.ts", "@@ -1 +1 @@\n-x\n+y"),
			file("src/gone.ts", "@@ -1 +1 @@\n-x\n+z"),
			file("src/same.ts", "@@ -1 +1 @@\n-q\n+r"),
		]
		const after = [
			file("src/a.ts", "@@ -1 +1 @@\n-x\n+w"),
			file("src/new.ts", "@@ -0,0 +1 @@\n+n", { status: "added" }),
			file("src/same.ts", "@@ -1 +1 @@\n-q\n+r"),
		]
		assert.deepEqual(rangeDiffPaths(before, after), ["src/a.ts", "src/new.ts", "src/gone.ts"])
	})

	it("counts a file with no inline patch, or a new rename source, as changed", () => {
		assert.deepEqual(rangeDiffPaths([file("logo.png", undefined)], [file("logo.png", undefined)]), [
			"logo.png",
		])
		assert.deepEqual(
			rangeDiffPaths(
				[file("b.ts", "", { status: "renamed", previousPath: "a.ts" })],
				[file("b.ts", "", { status: "renamed", previousPath: "c.ts" })],
			),
			["b.ts"],
		)
	})
})
