/**
 * The team's own votes as a filter on new findings: a finding that reads like several the team
 * downvoted or dismissed is not posted, unless it also reads like several they upvoted or fixed.
 * Anything in between is posted, so the filter only ever removes what the team has already
 * rejected more than once.
 *
 * Pure, so the rules are tested without a model or a database; `PrReviewService` does the I/O.
 */
import type { PrReviewFinding, PrReviewFindingStatus } from "@maple/domain/http"

/**
 * Cosine similarity at which two findings count as the same kind of comment. Measured on
 * `text-embedding-3-small` (2026-09-24): the same kind of comment about different code scored
 * 0.52 to 0.68, different kinds at most 0.44. Re-measure before changing the model.
 */
export const FEEDBACK_SIMILARITY = 0.5

/** Similar labelled findings on one side needed before that side decides. */
export const FEEDBACK_VOTES = 3

/** Labelled findings read per review, newest first; bounds the in-memory comparison. */
export const FEEDBACK_EXAMPLE_LIMIT = 2_000

export type FeedbackLabel = "positive" | "negative"

/**
 * What the team said about a stored finding. A dismissal is negative whatever its reactions; then
 * the reactions decide; a finding a later head fixed is positive. Everything else says nothing.
 */
export const feedbackLabel = (finding: {
	readonly status: PrReviewFindingStatus
	readonly reactionsUp: number
	readonly reactionsDown: number
}): FeedbackLabel | undefined => {
	if (finding.status === "dismissed") return "negative"
	if (finding.reactionsDown > finding.reactionsUp) return "negative"
	if (finding.reactionsUp > finding.reactionsDown) return "positive"
	return finding.status === "resolved" ? "positive" : undefined
}

export interface FeedbackExample {
	readonly label: FeedbackLabel
	readonly embedding: ReadonlyArray<number>
}

/** The text a finding is embedded from: what the reader of the comment saw, without its location. */
export const findingText = (finding: Pick<PrReviewFinding, "category" | "title" | "body">): string =>
	`${finding.category}: ${finding.title}\n\n${finding.body}`

/** Security and critical findings are always posted, whatever the team voted on similar ones. */
export const feedbackExempt = (finding: Pick<PrReviewFinding, "category" | "severity">): boolean =>
	finding.category === "security" || finding.severity === "critical"

export const cosineSimilarity = (a: ReadonlyArray<number>, b: ReadonlyArray<number>): number => {
	if (a.length !== b.length || a.length === 0) return 0
	let dot = 0
	let normA = 0
	let normB = 0
	for (let i = 0; i < a.length; i++) {
		const x = a[i] ?? 0
		const y = b[i] ?? 0
		dot += x * y
		normA += x * x
		normB += y * y
	}
	return normA === 0 || normB === 0 ? 0 : dot / Math.sqrt(normA * normB)
}

export interface FeedbackVerdict {
	readonly similarNegative: number
	readonly similarPositive: number
	readonly suppress: boolean
}

/** Block on enough similar negatives, unless as many similar positives say otherwise. */
export const feedbackVerdict = (
	embedding: ReadonlyArray<number>,
	examples: ReadonlyArray<FeedbackExample>,
): FeedbackVerdict => {
	let similarNegative = 0
	let similarPositive = 0
	for (const example of examples) {
		if (cosineSimilarity(embedding, example.embedding) < FEEDBACK_SIMILARITY) continue
		if (example.label === "negative") similarNegative++
		else similarPositive++
	}
	return {
		similarNegative,
		similarPositive,
		suppress: similarNegative >= FEEDBACK_VOTES && similarPositive < FEEDBACK_VOTES,
	}
}

/**
 * Split findings into the ones to post, with their vectors, and the ones the team's votes
 * suppress. `embeddings` is index-aligned with `findings`; an exempt finding is never compared.
 */
export const applyFeedback = <F extends Pick<PrReviewFinding, "category" | "severity">>(
	findings: ReadonlyArray<F>,
	embeddings: ReadonlyArray<ReadonlyArray<number>>,
	examples: ReadonlyArray<FeedbackExample>,
): {
	readonly kept: ReadonlyArray<F>
	readonly keptVectors: ReadonlyArray<ReadonlyArray<number>>
	readonly suppressed: ReadonlyArray<F>
} => {
	const kept: Array<F> = []
	const keptVectors: Array<ReadonlyArray<number>> = []
	const suppressed: Array<F> = []
	findings.forEach((finding, i) => {
		const embedding = embeddings[i] ?? []
		if (!feedbackExempt(finding) && feedbackVerdict(embedding, examples).suppress) {
			suppressed.push(finding)
		} else {
			kept.push(finding)
			keptVectors.push(embedding)
		}
	})
	return { kept, keptVectors, suppressed }
}
