/**
 * What a review pass has read. Fed the real renderers' answers, since the tracker reads them back.
 */
import type { PullRequestFile } from "@maple/domain/http"
import { renderFollowUp } from "@maple/backend/services/pr-review/findings"
import { assert, describe, it } from "vitest"
import { renderChangedFiles, renderFileDiffs } from "../mcp/tools/pull-request"
import { makeReviewCoverage, unreadRefusal } from "./review-coverage"

const file = (path: string): PullRequestFile => ({
	path,
	previousPath: null,
	status: "modified",
	additions: 1,
	deletions: 0,
	patch: "@@ -1 +1 @@\n+x",
})

const FILES = [file("src/a.ts"), file("src/b.ts"), file("src/a.test.ts"), file("docs/a.md")]
const listing = renderChangedFiles("octo/shop", 7, FILES).content[0]!.text
const diffs = (...paths: Array<string>) => renderFileDiffs(FILES, paths).content[0]!.text

describe("makeReviewCoverage", () => {
	it("owes nothing before the file list is read", () => {
		assert.deepEqual(makeReviewCoverage("Review pull request #7.").unread(), [])
	})

	it("owes every reviewed file until a diff answer shows it", () => {
		const coverage = makeReviewCoverage("Review pull request #7.")
		coverage.observe("pr_changed_files", listing)
		assert.deepEqual(coverage.unread(), ["src/a.ts", "src/b.ts", "src/a.test.ts"])
		coverage.observe("pr_file_diff", diffs("src/a.ts", "src/a.test.ts"))
		assert.deepEqual(coverage.unread(), ["src/b.ts"])
		coverage.observe("pr_file_diff", diffs("src/b.ts"))
		assert.deepEqual(coverage.unread(), [])
	})

	it("counts only pr_file_diff answers as reads", () => {
		const coverage = makeReviewCoverage("Review pull request #7.")
		coverage.observe("pr_changed_files", listing)
		coverage.observe("sandbox_read_file", diffs("src/a.ts", "src/b.ts", "src/a.test.ts"))
		assert.lengthOf(coverage.unread(), 3)
	})

	it("owes a later push only the files its kickoff says changed", () => {
		const followUp = renderFollowUp({ previousSha: "abcdef1234", changedPaths: ["src/b.ts"], open: [] })
		const coverage = makeReviewCoverage(["Review pull request #7.", ...followUp].join("\n"))
		coverage.observe("pr_changed_files", listing)
		assert.deepEqual(coverage.unread(), ["src/b.ts"])

		const nothing = makeReviewCoverage(
			renderFollowUp({ previousSha: "abcdef1234", changedPaths: [], open: [] }).join("\n"),
		)
		nothing.observe("pr_changed_files", listing)
		assert.deepEqual(nothing.unread(), [])
	})
})

describe("unreadRefusal", () => {
	it("names the files and says a second call goes through", () => {
		const message = unreadRefusal(["src/b.ts"])
		assert.include(message, "1 reviewed file: src/b.ts.")
		assert.include(message, "call submit_review again now")
	})

	it("bounds a long list", () => {
		const message = unreadRefusal(Array.from({ length: 45 }, (_, i) => `src/f${i}.ts`))
		assert.include(message, "src/f29.ts, and 15 more.")
		assert.notInclude(message, "src/f30.ts")
	})
})
