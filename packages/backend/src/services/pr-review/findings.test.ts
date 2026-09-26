import { PrReviewFinding, type PullRequestReviewThread } from "@maple/domain/http"
import { assert, describe, it } from "vitest"
import {
	dismissedFindings,
	followUpScope,
	ignoredPathsInKickoff,
	mergeSavedFindings,
	nextHandles,
	pathIgnored,
	renderFollowUp,
	renderIgnoredPaths,
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

	it("never dismisses on a question or a negation", () => {
		for (const body of [
			"Is this intended?",
			"Why is this not an issue here?",
			"This is not by design, fix it.",
		]) {
			const replied = thread({
				comments: [
					{ commentId: "100", author: "maple[bot]", body: "finding", thumbsUp: 0, thumbsDown: 0 },
					{ commentId: "101", author: "alice", body, thumbsUp: 0, thumbsDown: 0 },
				],
			})
			assert.lengthOf(dismissedFindings([tracked()], [replied]), 0, body)
		}
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
	const finding = (
		line: number,
		title = "Off by one",
		category: PrReviewFinding["category"] = "correctness",
	) => new PrReviewFinding({ path: "src/a.ts", line, category, severity: "warn", title, body: "" })

	it("drops a near-exact restatement of an open or dismissed finding", () => {
		const { fresh, repeated } = withoutRepeats(
			[
				finding(12, "Off-by-one"),
				finding(40, "leaked file handle"),
				finding(11, "off by one", "security"),
			],
			[
				tracked(),
				tracked({
					id: "row-2",
					handle: "F2",
					line: 41,
					title: "Leaked file handle",
					status: "dismissed",
				}),
			],
		)
		assert.equal(repeated, 2)
		assert.deepEqual(
			fresh.map((f) => [f.line, f.category]),
			[[11, "security"]],
		)
	})

	it("keeps a different bug next to an open finding", () => {
		const { fresh, repeated } = withoutRepeats([finding(11, "Unchecked null customer id")], [tracked()])
		assert.equal(repeated, 0)
		assert.lengthOf(fresh, 1)
	})

	it("leaves a restatement whose code moved to the reviewer's judgement", () => {
		assert.lengthOf(withoutRepeats([finding(30)], [tracked()]).fresh, 1)
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
	it("names the changed files and the open handles, and asks for a judgement per finding", () => {
		const text = renderFollowUp({
			previousSha: "abcdef1234",
			changes: { paths: ["src/a.ts"], rewritten: false },
			open: [tracked()],
		}).join("\n")
		assert.include(text, "reviewed before, at abcdef1")
		assert.include(text, "the rest was already reviewed: src/a.ts.")
		assert.include(text, "Lines being modified is not enough")
		assert.include(text, "leave it open when unsure")
		assert.include(text, "- F1 · src/a.ts:10 · correctness · warn · off by one")
	})

	it("says a rebase was compared file by file", () => {
		const text = renderFollowUp({
			previousSha: "abcdef1234",
			changes: { paths: ["src/b.ts"], rewritten: true },
			open: [],
		}).join("\n")
		assert.include(text, "rebased or force-pushed")
		assert.include(text, "the rest was already reviewed: src/b.ts.")
	})

	it("asks for the whole diff when the change could not be compared", () => {
		for (const changes of [undefined, { paths: undefined, rewritten: true }]) {
			const text = renderFollowUp({ previousSha: "abcdef1234", changes, open: [] }).join("\n")
			assert.include(text, "review the whole diff")
		}
	})
})

describe("followUpScope", () => {
	const kickoff = (paths: ReadonlyArray<string> | undefined, rewritten = false) =>
		[
			"Review pull request #7 of octo/shop.",
			"",
			...renderFollowUp({ previousSha: "abcdef1234", changes: { paths, rewritten }, open: [] }),
		].join("\n")

	it("reads back the files renderFollowUp names", () => {
		assert.deepEqual(followUpScope(kickoff(["src/a.ts", "src/b.ts"])), ["src/a.ts", "src/b.ts"])
	})

	it("reads back the files a rebase-safe comparison names", () => {
		assert.deepEqual(followUpScope(kickoff(["src/a.ts"], true)), ["src/a.ts"])
		assert.deepEqual(followUpScope(kickoff([], true)), [])
		assert.isUndefined(followUpScope(kickoff(undefined, true)))
	})

	it("reads back the listed files when the list is cut", () => {
		const paths = Array.from({ length: 70 }, (_, i) => `src/f${i}.ts`)
		assert.deepEqual(followUpScope(kickoff(paths)), paths.slice(0, 60))
	})

	it("is empty when nothing changed and undefined when the kickoff names no scope", () => {
		assert.deepEqual(followUpScope(kickoff([])), [])
		assert.isUndefined(followUpScope(kickoff(undefined)))
		assert.isUndefined(followUpScope("Review pull request #7 of octo/shop."))
	})
})

describe("ignoredPathsInKickoff", () => {
	it("reads back the patterns the kickoff states", () => {
		const kickoff = ["Review pull request #7.", renderIgnoredPaths(["generated/", "*.pb.go"]), ""].join(
			"\n",
		)
		assert.deepEqual(ignoredPathsInKickoff(kickoff), ["generated/", "*.pb.go"])
		assert.deepEqual(ignoredPathsInKickoff("Review pull request #7."), [])
	})
})

describe("mergeSavedFindings", () => {
	const finding = (line: number, title: string) =>
		new PrReviewFinding({
			path: "src/a.ts",
			line,
			category: "correctness",
			severity: "warn",
			title,
			body: "",
		})

	it("keeps saved findings first and drops a submitted restatement of one", () => {
		const saved = [finding(10, "`charge` runs twice on retry")]
		const merged = mergeSavedFindings(saved, [
			finding(11, "`charge` runs twice on a retry"),
			finding(40, "Tenant filter missing from `listKeys`"),
		])
		assert.deepEqual(
			merged.map((item) => item.line),
			[10, 40],
		)
	})
})
