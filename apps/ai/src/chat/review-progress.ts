/**
 * A running review's progress, shown on its pull request comment while it works: the shared
 * progress feed, writing on every beat so the elapsed time keeps moving through a long model
 * response, with what only a review knows (files read, findings saved, the close-out) added.
 */
import type { PrReviewFindingCounts, PrReviewProgress } from "@maple/domain/http"
import { Clock, Duration, Effect, Ref } from "effect"
import { makeProgressFeed, type ProgressFeed, reviewStepLabel } from "./progress"
import type { ReviewCoverage } from "./review-coverage"
import type { ReviewLedger } from "./review-ledger"

/** Each write edits a GitHub comment, so the beat stays well inside the API's rate limits. */
export const REVIEW_PROGRESS_HEARTBEAT = Duration.seconds(30)

export interface ReviewProgressFeed extends Pick<ProgressFeed, "step" | "pause" | "resume" | "close"> {
	/** The pass ended without a report; say the write-up is under way, now rather than on the beat. */
	readonly closingOut: Effect.Effect<void>
}

const countFindings = (ledger: ReviewLedger): PrReviewFindingCounts =>
	ledger
		.findings()
		.reduce<PrReviewFindingCounts>(
			(counts, finding) => ({ ...counts, [finding.severity]: counts[finding.severity] + 1 }),
			{ critical: 0, warn: 0, info: 0 },
		)

export const makeReviewProgressFeed = Effect.fn("makeReviewProgressFeed")(function* (input: {
	readonly coverage: ReviewCoverage
	readonly ledger: ReviewLedger
	readonly write: (progress: PrReviewProgress) => Effect.Effect<void>
}) {
	const startedAt = yield* Clock.currentTimeMillis
	const closingOut = yield* Ref.make(false)
	const feed = yield* makeProgressFeed({
		label: reviewStepLabel,
		heartbeat: REVIEW_PROGRESS_HEARTBEAT,
		everyBeat: true,
		write: (record) =>
			Effect.gen(function* () {
				const { due, read } = input.coverage.counts()
				yield* input.write({
					...record,
					startedAt,
					filesDue: due,
					filesRead: read,
					findings: countFindings(input.ledger),
					closingOut: yield* Ref.get(closingOut),
				})
			}),
	})
	return {
		step: feed.step,
		pause: feed.pause,
		resume: feed.resume,
		closingOut: Ref.set(closingOut, true).pipe(Effect.andThen(feed.writeNow)),
		close: feed.close,
	} satisfies ReviewProgressFeed
})
