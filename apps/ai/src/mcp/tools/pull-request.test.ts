/**
 * The diff the reviewer reads. The line numbers it prints are the ones a finding cites and GitHub
 * anchors a comment on, so they have to be the new side's, hunk by hunk.
 */
import { assert, describe, it } from "vitest"
import {
	annotatePatch,
	changedFilesOutput,
	classifyChangedFile,
	fileDiffsDoc,
	fileDiffsOutput,
	pathsInDiffAnswer,
	renderChangedFiles,
	renderFileDiffs,
	renderPullRequestContext,
	reviewablePathsInListing,
} from "./pull-request"
import { Schema } from "effect"
import { PrChangedFilesOutput, PrFileDiffOutput } from "@maple/domain/mcp-outputs"

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

	it("counts the files that are actually reviewed, with no call budget to pace against", () => {
		const result = renderChangedFiles("octo/shop", 7, [
			file("src/orders.ts"),
			file("src/orders.test.ts"),
			file("docs/orders.md"),
			file("infra/alchemy.run.ts"),
		])
		const text = result.content[0]?.text ?? ""
		assert.include(text, "Files to review: 3.")
		assert.notInclude(text, "tool calls")
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
		const text =
			renderFileDiffs("octo/shop", 7, [file("a.ts"), file("b.ts")], ["a.ts", "b.ts"]).content[0]
				?.text ?? ""
		assert.include(text, "## a.ts")
		assert.include(text, "## b.ts")
		assert.notInclude(text, "Not included")
	})

	it("names what did not fit instead of cutting a diff in half", () => {
		const paths = ["a.ts", "b.ts", "c.ts", "d.ts"]
		const text =
			renderFileDiffs(
				"octo/shop",
				7,
				paths.map((path) => file(path, 3_000)),
				paths,
			).content[0]?.text ?? ""
		assert.include(text, "## a.ts")
		assert.include(text, "Not included")
		assert.match(text, /request them in one more call: .*d\.ts/)
		assert.isAtMost(text.length, 90_000)
	})

	it("reports a path the pull request does not change, and keeps going", () => {
		const text =
			renderFileDiffs("octo/shop", 7, [file("a.ts")], ["nope.ts", "a.ts"]).content[0]?.text ?? ""
		assert.include(text, "'nope.ts' is not a file this pull request changes")
		assert.include(text, "## a.ts")
	})
})

describe("renderPullRequestContext", () => {
	it("lists failing checks first and clips long comments", () => {
		const result = renderPullRequestContext("octo/shop", 7, {
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

/** Coverage reads these answers back, so the parsers are tested against the renderers themselves. */
describe("reading the answers back", () => {
	const file = (path: string, overrides: Partial<{ previousPath: string; patch: null }> = {}) => ({
		path,
		previousPath: overrides.previousPath ?? null,
		status: "modified" as const,
		additions: 2,
		deletions: 1,
		patch: overrides.patch === null ? null : "@@ -1 +1,2 @@\n+x\n+y",
	})

	it("finds the reviewed files that have a patch in a pr_changed_files answer", () => {
		const answer = renderChangedFiles("octo/shop", 7, [
			file("src/orders.ts"),
			file("src/orders.test.ts"),
			file("src/moved.ts", { previousPath: "src/old.ts" }),
			file("infra/alchemy.run.ts"),
			file("package.json"),
			file("docs/orders.md"),
			file("bun.lock"),
			file("assets/logo.ts", { patch: null }),
		]).content[0]!.text
		assert.deepEqual(reviewablePathsInListing(answer), [
			"src/orders.ts",
			"src/orders.test.ts",
			"src/moved.ts",
			"infra/alchemy.run.ts",
			"package.json",
		])
	})

	it("finds only the files whose diff a pr_file_diff answer showed", () => {
		const big = {
			...file("src/big.ts"),
			patch: `@@ -1,0 +1,1400 @@\n${`+${"x".repeat(60)}\n`.repeat(1400)}`,
		}
		const answer = renderFileDiffs(
			"octo/shop",
			7,
			[file("src/a.ts"), big, file("src/c.ts")],
			["src/a.ts", "src/missing.ts", "src/big.ts", "src/c.ts"],
		).content[0]!.text
		assert.include(answer, "Not included")
		const shown = pathsInDiffAnswer(answer)
		// The unknown path shows nothing, and the deferred one is named without its diff.
		assert.deepEqual(shown, ["src/a.ts", "src/c.ts"])
		assert.include(answer, "request them in one more call: src/big.ts")
	})
})

describe("the typed outputs", () => {
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

	it("encode through their schemas", () => {
		const listing = changedFilesOutput("octo/shop", 7, [file("src/a.ts"), file("bun.lock")])
		const decoded = Schema.decodeUnknownSync(PrChangedFilesOutput)(
			Schema.encodeUnknownSync(PrChangedFilesOutput)(listing),
		)
		assert.deepEqual(
			decoded.files.map((entry) => entry.kind),
			["source", "lockfile"],
		)
		const diffs = fileDiffsOutput("octo/shop", 7, [file("src/a.ts")], ["src/a.ts", "nope.ts"])
		const decodedDiffs = Schema.decodeUnknownSync(PrFileDiffOutput)(
			Schema.encodeUnknownSync(PrFileDiffOutput)(diffs),
		)
		assert.deepEqual(decodedDiffs.notChanged, ["nope.ts"])
	})

	it("offers the deferred diffs as one typed next call", () => {
		const paths = ["a.ts", "b.ts", "c.ts", "d.ts"]
		const rendered = fileDiffsDoc(
			fileDiffsOutput(
				"octo/shop",
				7,
				paths.map((path) => file(path, 3_000)),
				paths,
			),
		)
		const next = rendered.next?.[0]
		assert.equal(next?.tool, "pr_file_diff")
		assert.deepEqual(next?.args, { repository: "octo/shop", number: 7, paths: ["c.ts", "d.ts"] })
	})
})
