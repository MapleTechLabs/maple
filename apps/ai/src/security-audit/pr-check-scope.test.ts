import { describe, expect, it } from "@effect/vitest"
import type { PullRequestFile } from "@maple/domain/http"
import { prScopePaths } from "./pr-check-scope"

const file = (path: string, status: PullRequestFile["status"] = "modified"): PullRequestFile => ({
	path,
	previousPath: null,
	status,
	additions: 1,
	deletions: 0,
	patch: null,
})

describe("prScopePaths", () => {
	it("audits the files a pull request adds or changes, not the ones it removes or unsafe paths", () => {
		expect(
			prScopePaths([
				file("src/api/keys.ts"),
				file("src/api/new.ts", "added"),
				file("src/old.ts", "removed"),
				file("../escape.ts"),
				file("src/api/keys.ts"),
			]),
		).toEqual(["src/api/keys.ts", "src/api/new.ts"])
	})

	it("folds a large diff into the deepest directories that fit, keeping root files whole", () => {
		const files = [
			file("README.md"),
			...Array.from({ length: 4 }, (_, i) => file(`apps/web/src/page/p${i}.ts`)),
			...Array.from({ length: 4 }, (_, i) => file(`apps/api/src/routes/r${i}.ts`)),
		]

		expect(prScopePaths(files, 3)).toEqual(["README.md", "apps/web/src/page", "apps/api/src/routes"])
		expect(prScopePaths(files, 2)).toEqual(["README.md", "apps"])
	})

	it("refuses a diff that cannot fit even by top-level directory", () => {
		expect(prScopePaths([file("a/x.ts"), file("b/x.ts"), file("c/x.ts")], 2)).toBeNull()
	})

	it("answers no paths for a pull request that only removes files", () => {
		expect(prScopePaths([file("src/old.ts", "removed")])).toEqual([])
	})
})
