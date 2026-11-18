/**
 * A review's progress across the attempts a Durable Object reset starts, and what is filed when
 * the session gives the review up. Fed the real renderers' answers, since coverage reads them back.
 */
import { PrReviewFinding, type PullRequestFile, type SubmitPrReviewRequest } from "@maple/domain/http"
import { Array as Arr, Effect, Option } from "effect"
import { assert, describe, it } from "@effect/vitest"
import { renderChangedFiles, renderFileDiffs } from "../../mcp/tools/pull-request"
import {
	checkpointedReviewState,
	decodeReviewCheckpoint,
	encodeReviewCheckpoint,
	fileAbandonedReview,
	type ReviewCheckpoint,
} from "./checkpoint"

const file = (path: string): PullRequestFile => ({
	path,
	previousPath: null,
	status: "modified",
	additions: 1,
	deletions: 0,
	patch: "@@ -1 +1 @@\n+x",
})
const FILES = [file("src/a.ts"), file("src/b.ts"), file("src/c.ts")]
const listing = Arr.getUnsafe(renderChangedFiles("octo/shop", 7, FILES).content, 0).text
const diffs = (...paths: Array<string>) =>
	Arr.getUnsafe(renderFileDiffs("octo/shop", 7, FILES, paths).content, 0).text

const finding = (line: number, title: string) =>
	new PrReviewFinding({
		path: "src/a.ts",
		line,
		category: "correctness",
		severity: "warn",
		title,
		body: "It breaks on an empty list.",
	})
const CHILD_ANSWER =
	"src/b.ts:1 | warn | correctness | Off by one | The loop skips the last item | Use <= | -"

/** An attempt whose checkpoint writes land in `store`, as the session's row would. */
const attempt = (store: { current: Option.Option<ReviewCheckpoint> }) =>
	checkpointedReviewState({
		kickoff: "Review pull request #7.",
		model: "review-model",
		prior: store.current,
		save: (checkpoint) => {
			store.current = decodeReviewCheckpoint(encodeReviewCheckpoint(checkpoint))
		},
	})

describe("checkpointedReviewState", () => {
	it("hands a reset attempt's findings to the next one, and keeps every attempt's reads", () => {
		const store = { current: Option.none<ReviewCheckpoint>() }
		const first = attempt(store)
		first.coverage.observe("pr_changed_files", listing)
		first.coverage.observe("pr_file_diff", diffs("src/a.ts"))
		assert.strictEqual(first.ledger.record(finding(1, "Empty list")), "recorded")
		first.childFindings.observe(CHILD_ANSWER)

		const second = attempt(store)
		assert.deepEqual(
			Arr.map(second.ledger.findings(), (saved) => saved.title),
			["Empty list"],
		)
		assert.deepEqual(
			Arr.map(second.childFindings.all(), (child) => child.title),
			["Off by one"],
		)
		// The new attempt has not seen a diff yet, so it still owes every file.
		second.coverage.observe("pr_changed_files", listing)
		assert.deepEqual(second.coverage.unread(), ["src/a.ts", "src/b.ts", "src/c.ts"])
		second.coverage.observe("pr_file_diff", diffs("src/b.ts"))
		// A finding the first attempt saved is a repeat, not a second copy.
		assert.strictEqual(second.ledger.record(finding(1, "Empty list")), "repeat")

		const saved = Option.getOrThrow(store.current)
		assert.deepEqual(saved.read, ["src/a.ts", "src/b.ts"])
		assert.deepEqual(saved.due, ["src/a.ts", "src/b.ts", "src/c.ts"])
		assert.strictEqual(saved.model, "review-model")
	})

	it("keeps a child's finding once when a restarted attempt's child reports it again", () => {
		const store = { current: Option.none<ReviewCheckpoint>() }
		attempt(store).childFindings.observe(CHILD_ANSWER)
		const second = attempt(store)
		second.childFindings.observe(CHILD_ANSWER)
		assert.lengthOf(second.childFindings.all(), 1)
		assert.lengthOf(Option.getOrThrow(store.current).children, 1)
	})

	it("writes nothing for a tool answer that changes neither reads nor findings", () => {
		const writes: Array<ReviewCheckpoint> = []
		const state = checkpointedReviewState({
			kickoff: "Review pull request #7.",
			model: "review-model",
			prior: Option.none(),
			save: (checkpoint) => writes.push(checkpoint),
		})
		state.coverage.observe("sandbox_read_file", "export const a = 1")
		assert.lengthOf(writes, 0)
	})
})

describe("decodeReviewCheckpoint", () => {
	it("reads a missing or unreadable row as none", () => {
		assert.isTrue(Option.isNone(decodeReviewCheckpoint(undefined)))
		assert.isTrue(Option.isNone(decodeReviewCheckpoint("{not json")))
		assert.isTrue(Option.isNone(decodeReviewCheckpoint(JSON.stringify({ saved: "nope" }))))
	})
})

describe("fileAbandonedReview", () => {
	const checkpoint: ReviewCheckpoint = {
		saved: [finding(1, "Empty list")],
		children: [],
		due: ["src/a.ts", "src/b.ts", "src/c.ts"],
		read: ["src/a.ts"],
		model: "review-model",
	}

	it.effect("files the saved findings as an interrupted partial naming the unread files", () =>
		Effect.gen(function* () {
			const filed: Array<SubmitPrReviewRequest> = []
			const result = yield* fileAbandonedReview({
				checkpoint: Option.some(checkpoint),
				submit: (request) => Effect.sync(() => filed.push(request)),
			})
			assert.isTrue(result)
			assert.lengthOf(filed, 1)
			const request = filed[0]!
			assert.isTrue(request.partial)
			assert.strictEqual(request.partialReason, "interrupted")
			assert.strictEqual(request.model, "review-model")
			assert.deepEqual(request.report.unreviewed, ["src/b.ts", "src/c.ts"])
			assert.deepEqual(
				Arr.map(request.report.findings, (saved) => saved.title),
				["Empty list"],
			)
		}),
	)

	it.effect("files nothing without a checkpoint or without findings", () =>
		Effect.gen(function* () {
			const filed: Array<SubmitPrReviewRequest> = []
			const submit = (request: SubmitPrReviewRequest) => Effect.sync(() => filed.push(request))
			assert.isFalse(yield* fileAbandonedReview({ checkpoint: Option.none(), submit }))
			assert.isFalse(
				yield* fileAbandonedReview({ checkpoint: Option.some({ ...checkpoint, saved: [] }), submit }),
			)
			assert.lengthOf(filed, 0)
		}),
	)

	it.effect("answers false when the filing fails, so the review is failed as before", () =>
		Effect.gen(function* () {
			const result = yield* fileAbandonedReview({
				checkpoint: Option.some(checkpoint),
				submit: () => Effect.fail("database unavailable"),
			})
			assert.isFalse(result)
		}),
	)
})
