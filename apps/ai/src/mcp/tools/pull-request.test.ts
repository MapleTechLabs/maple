/**
 * The diff the reviewer reads. The line numbers it prints are the ones a finding cites and GitHub
 * anchors a comment on, so they have to be the new side's, hunk by hunk.
 */
import { assert, describe, it } from "vitest"
import {
	annotatePatch,
	classifyChangedFile,
	renderChangedFiles,
	renderFileDiffs,
	renderPullRequestContext,
	reviewCallBudget,
} from "./pull-request"

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
		assert.include(text, "Files to review: 3.")
		assert.include(text, `${reviewCallBudget(3)} tool calls`)
	})

	it("keeps the budget between a floor and a ceiling", () => {
		assert.equal(reviewCallBudget(0), 8)
		assert.equal(reviewCallBudget(3), 15)
		assert.equal(reviewCallBudget(100), 60)
	})
})

describe("renderFileDiffs", () => {
	const file = (path: string, size = 10) => ({
		path,
		previousPath: null,
		status: "modified" as const,
		additions: size,
		deletions: 0,
		patch: ["@@ -1,0 +1," + size + " @@", ...Array.from({ length: size }, (_, i) => `+line ${i}`)].join(
			"\n",
		),
	})

	it("returns several files in one answer", () => {
		const text = renderFileDiffs([file("a.ts"), file("b.ts")], ["a.ts", "b.ts"]).content[0]?.text ?? ""
		assert.include(text, "## a.ts")
		assert.include(text, "## b.ts")
		assert.notInclude(text, "Not included")
	})

	it("names what did not fit instead of cutting a diff in half", () => {
		const paths = ["a.ts", "b.ts", "c.ts", "d.ts"]
		const text =
			renderFileDiffs(
				paths.map((path) => file(path, 3_000)),
				paths,
			).content[0]?.text ?? ""
		assert.include(text, "## a.ts")
		assert.include(text, "Not included")
		assert.match(text, /request them in one more call: .*d\.ts/)
		assert.isAtMost(text.length, 90_000)
	})

	it("reports a path the pull request does not change, and keeps going", () => {
		const text = renderFileDiffs([file("a.ts")], ["nope.ts", "a.ts"]).content[0]?.text ?? ""
		assert.include(text, "'nope.ts' is not a file this pull request changes")
		assert.include(text, "## a.ts")
	})
})

describe("renderPullRequestContext", () => {
	it("lists failing checks first and clips long comments", () => {
		const result = renderPullRequestContext(7, {
			commits: [{ sha: "abcdef1234567890", message: "feat: add orders\n\nbody" }],
			comments: [{ author: "octo", path: "src/a.ts", line: 3, body: "x".repeat(1_000) }],
			checks: [
				{ name: "lint", status: "completed", conclusion: "success", title: null },
				{ name: "typecheck", status: "completed", conclusion: "failure", title: "2 errors" },
			],
		})
		const text = result.content[0]?.text ?? ""
		assert.include(text, "- abcdef1 feat: add orders")
		assert.include(text, "- @octo on src/a.ts:3: ")
		assert.notInclude(text, "x".repeat(500))
		assert.isBelow(text.indexOf("typecheck: failure · 2 errors"), text.indexOf("lint: success"))
	})
})
