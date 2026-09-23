import { PrReviewFinding, type PullRequestReviewThread } from "@maple/domain/http"
import { assert, describe, it } from "vitest"
import {
	dismissedFindings,
	nextHandles,
	pathIgnored,
	renderFollowUp,
	resolvedByHandle,
	type TrackedFinding,
	withoutRepeats,
} from "./findings"

const tracked = (overrides: Partial<TrackedFinding> = {}): TrackedFinding => ({
	id: "row-1",
	handle: "F1",
	path: "src/a.ts",
	line: 10,
	category: "correctness",
	severity: "warn",
	title: "off by one",
	status: "open",
	commentId: "100",
	...overrides,
})

const thread = (overrides: Partial<PullRequestReviewThread> = {}): PullRequestReviewThread => ({
	id: "T1",
	isResolved: false,
	comments: [
		{ commentId: "100", author: "maple[bot]", body: "**F1 · off by one**", thumbsUp: 0, thumbsDown: 0 },
	],
	...overrides,
})

describe("dismissedFindings", () => {
	it("dismisses a finding whose thread a person resolved", () => {
		assert.lengthOf(dismissedFindings([tracked()], [thread({ isResolved: true })]), 1)
	})

	it("dismisses a finding someone answered won't fix, but not on the bot's own reply", () => {
		const replied = thread({
			comments: [
				{ commentId: "100", author: "maple[bot]", body: "finding", thumbsUp: 0, thumbsDown: 0 },
				{
					commentId: "101",
					author: "octo",
					body: "Won't fix, this is intended.",
					thumbsUp: 0,
					thumbsDown: 0,
				},
			],
		})
		assert.lengthOf(dismissedFindings([tracked()], [replied]), 1)
		const botReply = thread({
			comments: [
				{ commentId: "100", author: "maple[bot]", body: "finding", thumbsUp: 0, thumbsDown: 0 },
				{ commentId: "101", author: "maple[bot]", body: "not an issue", thumbsUp: 0, thumbsDown: 0 },
			],
		})
		assert.lengthOf(dismissedFindings([tracked()], [botReply]), 0)
	})

	it("keeps a finding with no thread or an open, quiet one", () => {
		assert.lengthOf(dismissedFindings([tracked({ commentId: null })], [thread({ isResolved: true })]), 0)
		assert.lengthOf(dismissedFindings([tracked()], [thread()]), 0)
	})
})

describe("withoutRepeats", () => {
	const finding = (line: number, category: PrReviewFinding["category"] = "correctness") =>
		new PrReviewFinding({ path: "src/a.ts", line, category, severity: "warn", title: "x", body: "" })

	it("drops a new finding within three lines of an open or dismissed one in the same lens", () => {
		const { fresh, repeated } = withoutRepeats(
			[finding(12), finding(40), finding(11, "security")],
			[tracked(), tracked({ id: "row-2", handle: "F2", line: 41, status: "dismissed" })],
		)
		assert.equal(repeated, 2)
		assert.deepEqual(
			fresh.map((f) => [f.line, f.category]),
			[[11, "security"]],
		)
	})

	it("lets a resolved finding's spot be raised again", () => {
		assert.lengthOf(withoutRepeats([finding(10)], [tracked({ status: "resolved" })]).fresh, 1)
	})
})

describe("handles", () => {
	it("continues after the highest handle used", () => {
		assert.deepEqual(nextHandles(["F1", "F7", "junk"], 2), ["F8", "F9"])
		assert.deepEqual(nextHandles([], 1), ["F1"])
	})

	it("resolves only handles that are open", () => {
		const open = [tracked(), tracked({ id: "row-2", handle: "F2" })]
		assert.deepEqual(
			resolvedByHandle(["f2", "F9"], open).map((f) => f.handle),
			["F2"],
		)
	})
})

describe("pathIgnored", () => {
	it("matches directory prefixes, suffixes and globs", () => {
		assert.isTrue(pathIgnored("generated/api.ts", ["generated/"]))
		assert.isTrue(pathIgnored("src/proto/a.pb.go", ["*.pb.go"]))
		assert.isTrue(pathIgnored("apps/web/src/routeTree.gen.ts", ["apps/**/routeTree.gen.ts"]))
		assert.isFalse(pathIgnored("src/a.ts", ["generated/", "*.pb.go", ""]))
		assert.isFalse(pathIgnored("src/a.ts", undefined))
	})
})

describe("renderFollowUp", () => {
	it("names the changed files and the open handles", () => {
		const text = renderFollowUp({
			previousSha: "abcdef1234",
			changedPaths: ["src/a.ts"],
			open: [tracked()],
		}).join("\n")
		assert.include(text, "reviewed before, at abcdef1")
		assert.include(text, "src/a.ts")
		assert.include(text, "- F1 · src/a.ts:10 · correctness · warn · off by one")
	})
})
