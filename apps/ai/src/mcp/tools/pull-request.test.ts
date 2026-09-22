/**
 * The diff the reviewer reads. The line numbers it prints are the ones a finding cites and GitHub
 * anchors a comment on, so they have to be the new side's, hunk by hunk.
 */
import { assert, describe, it } from "vitest"
import { annotatePatch, classifyChangedFile, renderChangedFiles, reviewCallBudget } from "./pull-request"

describe("annotatePatch", () => {
	it("numbers additions and context on the new side and leaves deletions unnumbered", () => {
		const patch = [
			"@@ -10,3 +10,4 @@ export const handler",
			" const a = 1",
			"-const b = 2",
			"+const b = 3",
			"+const c = 4",
			" return a",
		].join("\n")
		const { lines, truncated } = annotatePatch(patch)
		assert.isFalse(truncated)
		assert.deepEqual(lines, [
			"      @@ -10,3 +10,4 @@ export const handler",
			"   10   const a = 1",
			"      - const b = 2",
			"   11 + const b = 3",
			"   12 + const c = 4",
			"   13   return a",
		])
	})

	it("restarts numbering at every hunk header", () => {
		const patch = ["@@ -1,1 +1,1 @@", "+first", "@@ -40,1 +50,2 @@", "+second", " ctx"].join("\n")
		const { lines } = annotatePatch(patch)
		assert.include(lines, "    1 + first")
		assert.include(lines, "   50 + second")
		assert.include(lines, "   51   ctx")
	})

	it("handles a hunk header without a count", () => {
		const { lines } = annotatePatch("@@ -0,0 +1 @@\n+only")
		assert.include(lines, "    1 + only")
	})

	it("cuts a diff past the line bound and says so", () => {
		const patch = ["@@ -1,0 +1,2000 @@", ...Array.from({ length: 2_000 }, (_, i) => `+line ${i}`)].join(
			"\n",
		)
		const { lines, truncated } = annotatePatch(patch)
		assert.isTrue(truncated)
		assert.isAtMost(lines.length, 1_500)
	})
})

describe("classifyChangedFile", () => {
	it("keeps tests, generated files, docs and lockfiles out of the review", () => {
		assert.equal(classifyChangedFile("apps/api/src/routes/orders.test.ts"), "test")
		assert.equal(classifyChangedFile("packages/domain/src/__tests__/x.ts"), "test")
		assert.equal(classifyChangedFile("apps/web/src/routeTree.gen.ts"), "generated")
		assert.equal(classifyChangedFile("bun.lock"), "lockfile")
		assert.equal(classifyChangedFile("docs/api-v2.md"), "docs")
		assert.equal(classifyChangedFile("README.md"), "docs")
	})

	it("keeps developer tooling out of the review", () => {
		assert.equal(classifyChangedFile("apps/ai/scripts/pr-review-local.ts"), "tooling")
		assert.equal(classifyChangedFile("scripts/oxlint-plugins/maple.mjs"), "tooling")
		assert.equal(classifyChangedFile("apps/web/vite.config.ts"), "tooling")
		assert.equal(classifyChangedFile("apps/ai/src/chat/prompts.ts"), "source")
	})

	it("tells infra and config from source", () => {
		assert.equal(classifyChangedFile(".github/workflows/deploy.yml"), "infra")
		assert.equal(classifyChangedFile("apps/api/alchemy.run.ts"), "infra")
		assert.equal(classifyChangedFile("apps/api/package.json"), "config")
		assert.equal(classifyChangedFile("apps/api/src/routes/orders.ts"), "source")
		assert.equal(classifyChangedFile("apps/ingest/src/main.rs"), "source")
	})
})

describe("renderChangedFiles", () => {
	const file = (path: string) => ({
		path,
		previousPath: null,
		status: "modified" as const,
		additions: 3,
		deletions: 1,
		patch: "@@ -1 +1 @@\n+x",
	})

	it("states a call budget from the files that are actually reviewed", () => {
		const result = renderChangedFiles("octo/shop", 7, [
			file("src/orders.ts"),
			file("src/orders.test.ts"),
			file("docs/orders.md"),
			file("infra/alchemy.run.ts"),
		])
		const text = result.content[0]?.text ?? ""
		assert.include(text, "Files to review: 2.")
		assert.include(text, `${reviewCallBudget(2)} tool calls`)
	})

	it("keeps the budget between a floor and a ceiling", () => {
		assert.equal(reviewCallBudget(0), 6)
		assert.equal(reviewCallBudget(3), 10)
		assert.equal(reviewCallBudget(100), 40)
	})
})
