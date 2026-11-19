import { Array as Arr } from "effect"
import { assert, describe, it } from "vitest"
import {
	applyFeedback,
	cosineSimilarity,
	type FeedbackExample,
	feedbackLabel,
	findingText,
	NO_FEEDBACK_VOTES,
	suppressedByVotes,
	tallyFeedback,
} from "./feedback"

const NOISE = [1, 0, 0]
const BUG = [0, 1, 0]
/** Close to NOISE (cosine ~0.995), well above the similarity bar. */
const NEAR_NOISE = [1, 0.1, 0]

const examples = (label: FeedbackExample["label"], embedding: ReadonlyArray<number>, n: number) =>
	Array.from({ length: n }, (): FeedbackExample => ({ label, embedding }))

describe("feedbackLabel", () => {
	it("treats a dismissal as negative whatever its reactions", () => {
		assert.equal(feedbackLabel({ status: "dismissed", reactionsUp: 5, reactionsDown: 0 }), "negative")
	})

	it("lets reactions decide for an open or resolved finding", () => {
		assert.equal(feedbackLabel({ status: "open", reactionsUp: 0, reactionsDown: 1 }), "negative")
		assert.equal(feedbackLabel({ status: "open", reactionsUp: 2, reactionsDown: 1 }), "positive")
		assert.equal(feedbackLabel({ status: "resolved", reactionsUp: 0, reactionsDown: 2 }), "negative")
	})

	it("counts a fixed finding as positive and says nothing about an untouched one", () => {
		assert.equal(feedbackLabel({ status: "resolved", reactionsUp: 0, reactionsDown: 0 }), "positive")
		assert.isUndefined(feedbackLabel({ status: "open", reactionsUp: 0, reactionsDown: 0 }))
		assert.isUndefined(feedbackLabel({ status: "open", reactionsUp: 1, reactionsDown: 1 }))
	})
})

describe("cosineSimilarity", () => {
	it("is 1 for the same direction and 0 for orthogonal, mismatched or zero vectors", () => {
		assert.closeTo(cosineSimilarity([2, 0], [5, 0]), 1, 1e-9)
		assert.equal(cosineSimilarity(NOISE, BUG), 0)
		assert.equal(cosineSimilarity([1, 0], [1, 0, 0]), 0)
		assert.equal(cosineSimilarity([0, 0], [1, 0]), 0)
	})
})

const votesOf = (embedding: ReadonlyArray<number>, all: ReadonlyArray<FeedbackExample>) =>
	tallyFeedback(NO_FEEDBACK_VOTES, embedding, all)

describe("tallyFeedback", () => {
	it("suppresses a finding similar to three negatives", () => {
		const votes = votesOf(NEAR_NOISE, examples("negative", NOISE, 3))
		assert.deepEqual(votes, { similarNegative: 3, similarPositive: 0 })
		assert.isTrue(suppressedByVotes(votes))
	})

	it("keeps it below three similar negatives", () => {
		assert.isFalse(suppressedByVotes(votesOf(NEAR_NOISE, examples("negative", NOISE, 2))))
	})

	it("keeps it when as many similar positives disagree", () => {
		const mixed = [...examples("negative", NOISE, 4), ...examples("positive", NOISE, 3)]
		assert.isFalse(suppressedByVotes(votesOf(NEAR_NOISE, mixed)))
	})

	it("ignores negatives about something else", () => {
		assert.isFalse(suppressedByVotes(votesOf(BUG, examples("negative", NOISE, 10))))
	})

	it("counts examples read a page at a time the same as all at once", () => {
		const all = [
			...examples("negative", NOISE, 2),
			...examples("positive", NOISE, 1),
			...examples("negative", BUG, 2),
			...examples("negative", NOISE, 2),
		]
		const paged = Arr.reduce(
			[all.slice(0, 2), all.slice(2, 5), all.slice(5)],
			NO_FEEDBACK_VOTES,
			(votes, page) => tallyFeedback(votes, NEAR_NOISE, page),
		)
		assert.deepEqual(paged, votesOf(NEAR_NOISE, all))
		assert.deepEqual(paged, { similarNegative: 4, similarPositive: 1 })
	})
})

describe("applyFeedback", () => {
	const noisy = votesOf(NOISE, examples("negative", NOISE, 3))

	it("never suppresses security or critical findings", () => {
		const findings = [
			{ category: "security" as const, severity: "warn" as const },
			{ category: "convention" as const, severity: "critical" as const },
			{ category: "convention" as const, severity: "info" as const },
		]
		const { kept, keptVectors, suppressed } = applyFeedback(
			findings,
			[NOISE, NOISE, NOISE],
			[noisy, noisy, noisy],
		)
		assert.deepEqual(kept, findings.slice(0, 2))
		assert.deepEqual(keptVectors, [NOISE, NOISE])
		assert.deepEqual(suppressed, findings.slice(2))
	})

	it("keeps a finding without a vector or votes", () => {
		const findings = [{ category: "convention" as const, severity: "info" as const }]
		assert.equal(applyFeedback(findings, [], []).kept.length, 1)
	})
})

describe("findingText", () => {
	it("embeds what the reader saw, not where it was", () => {
		assert.equal(
			findingText({ category: "convention", title: "Prefer const", body: "`x` is never reassigned." }),
			"convention: Prefer const\n\n`x` is never reassigned.",
		)
	})
})
