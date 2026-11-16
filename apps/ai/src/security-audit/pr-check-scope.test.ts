import { describe, expect, it } from "@effect/vitest"
import type { PullRequestFile } from "@maple/domain/http"
import { prScope } from "./pr-check-scope"

const file = (path: string, status: PullRequestFile["status"] = "modified"): PullRequestFile => ({
	path,
	previousPath: null,
	status,
	additions: 1,
	deletions: 0,
	patch: null,
})

describe("prScope", () => {
	it("audits the files a pull request adds or changes, not the ones it removes", () => {
		expect(
			prScope([
				file("src/api/keys.ts"),
				file("src/api/new.ts", "added"),
				file("src/old.ts", "removed"),
				file("src/api/keys.ts"),
			]),
		).toEqual({ kind: "paths", paths: ["src/api/keys.ts", "src/api/new.ts"] })
	})

	it("folds a path the audit refuses into its nearest accepted directory, never dropping it", () => {
		expect(prScope([file("src/aux/handler.ts"), file("src/ok.ts")])).toEqual({
			kind: "paths",
			paths: ["src", "src/ok.ts"],
		})
		// No accepted directory above it: the whole repository is audited instead.
		expect(prScope([file("con.ts"), file("src/ok.ts")])).toEqual({ kind: "repository" })
		expect(prScope([file("../escape.ts")])).toEqual({ kind: "repository" })
	})

	it("folds a large diff into the deepest directories that fit, keeping root files whole", () => {
		const files = [
			file("README.md"),
			...Array.from({ length: 4 }, (_, i) => file(`apps/web/src/page/p${i}.ts`)),
			...Array.from({ length: 4 }, (_, i) => file(`apps/api/src/routes/r${i}.ts`)),
		]

		expect(prScope(files, 3)).toEqual({
			kind: "paths",
			paths: ["README.md", "apps/web/src/page", "apps/api/src/routes"],
		})
		expect(prScope(files, 2)).toEqual({ kind: "paths", paths: ["README.md", "apps"] })
	})

	it("audits the whole repository when even top-level directories do not fit", () => {
		expect(prScope([file("a/x.ts"), file("b/x.ts"), file("c/x.ts")], 2)).toEqual({ kind: "repository" })
	})

	it("answers empty for a pull request that only removes files", () => {
		expect(prScope([file("src/old.ts", "removed")])).toEqual({ kind: "empty" })
	})
})
