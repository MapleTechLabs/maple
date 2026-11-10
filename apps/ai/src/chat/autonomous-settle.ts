/**
 * How an autonomous turn's rows are settled when it stops without a report: after its phases, or
 * when an abort or a stale expiry cuts them short. The runner supplies the phases and the writes.
 */
import type { PrReviewFailureReason } from "@maple/domain/http"
import { Effect, Option } from "effect"
import type { AutonomousOutcome } from "./autonomous-outcome"
import { abortReason, type TurnObservability } from "./turn-outcome"

/** What the investigation row records when the turn was stopped before its report. */
export const NO_DIAGNOSIS_INTERRUPTED =
	"interrupted: the run was stopped before it submitted a diagnosis; retry"
/** What the reply row records when its turn was evicted: a reply is never started again. */
export const NO_REPLY_INTERRUPTED = "interrupted: the run was restarted before it submitted an answer"
/** How long a row write that settles an unfinished turn may take; it can run in a finalizer. */
const ROW_WRITE_TIMEOUT = "10 seconds"

/** The rows this turn owns, each with the write that marks it failed. */
export interface UnfinishedRows<EI, ER, EV> {
	readonly failInvestigation?: (error: string) => Effect.Effect<void, EI>
	readonly failReply?: Effect.Effect<void, ER>
	readonly failReview?: (reason: PrReviewFailureReason) => Effect.Effect<void, EV>
}

export const settleRow = <E>(write: Effect.Effect<void, E>, failed: string) =>
	write.pipe(
		Effect.timeout(ROW_WRITE_TIMEOUT),
		Effect.catchCause((cause) => Effect.logError(failed, cause)),
	)

/**
 * A turn the session gave up after an eviction. Nothing runs: the rows it owned are marked failed,
 * which is also what tells the pull request, since the dead fiber's own settling never ran.
 */
export const settleAbandoned = <ER, EV>(rows: {
	readonly failReply?: Effect.Effect<void, ER>
	readonly failReview?: Effect.Effect<void, EV>
}) =>
	Effect.gen(function* () {
		if (rows.failReview !== undefined)
			yield* settleRow(rows.failReview, "Could not record the abandoned review")
		if (rows.failReply !== undefined)
			yield* settleRow(rows.failReply, "Could not record the abandoned reply")
	})

/**
 * `settleAbandoned` for the rows a turn names: its review, its reply, or neither. Apart from the
 * runner so the choice of write, and what each is told, is testable without a turn's runtime.
 */
export const settleAbandonedTurn = <Org, ReviewId, ReplyId, ReviewError, ER, EV>(turn: {
	readonly orgId: Org
	readonly prReviewId: ReviewId | undefined
	readonly prReplyId: ReplyId | undefined
	readonly reviewInterrupted: ReviewError
	readonly failReview: (orgId: Org, id: ReviewId, error: ReviewError) => Effect.Effect<void, EV>
	readonly failReply: (orgId: Org, id: ReplyId, error: string) => Effect.Effect<void, ER>
}) =>
	settleAbandoned({
		...(turn.prReviewId === undefined
			? undefined
			: { failReview: turn.failReview(turn.orgId, turn.prReviewId, turn.reviewInterrupted) }),
		...(turn.prReplyId === undefined
			? undefined
			: { failReply: turn.failReply(turn.orgId, turn.prReplyId, NO_REPLY_INTERRUPTED) }),
	})

export const makeUnfinishedSettler = <EI, ER, EV>(options: {
	readonly outcome: AutonomousOutcome
	readonly signal: AbortSignal | undefined
	readonly observability: TurnObservability
	readonly rows: UnfinishedRows<EI, ER, EV>
}) => {
	const { outcome, signal, observability, rows } = options
	/** Not on a supersede: the newer head's review owns the row and marks it skipped itself. */
	const failUnfinished = (reason: PrReviewFailureReason, investigationError: string) =>
		Effect.gen(function* () {
			if (outcome.submitted()) return
			if (Option.contains(abortReason(signal), "superseded")) return
			if (rows.failInvestigation !== undefined) {
				observability.failureReason = "NoDiagnosis"
				yield* settleRow(
					rows.failInvestigation(investigationError),
					"Could not record the failed pass",
				)
			}
			if (rows.failReply !== undefined) {
				observability.failureReason = "NoReply"
				yield* settleRow(rows.failReply, "Could not record the failed reply")
			}
			if (rows.failReview !== undefined) {
				observability.failureReason = "NoReview"
				yield* Effect.annotateCurrentSpan("maple.pr_review.failure_reason", reason)
				yield* settleRow(rows.failReview(reason), "Could not record the failed review")
			}
		})

	/** An abort between or during phases still settles the rows: nothing else moves them off `running`. */
	const aborted = Effect.suspend(() => {
		observability.outcome = "aborted"
		return failUnfinished("interrupted", NO_DIAGNOSIS_INTERRUPTED)
	})

	return { failUnfinished, aborted }
}

/**
 * Run the phases, then settle exactly once: `settle` while the turn still holds its slot, else
 * `aborted`. Settling is uninterruptible, so an abort arriving then cannot settle the rows twice.
 */
export const runAutonomousTurn = <E, R, E2, R2>(options: {
	readonly phases: Effect.Effect<void, E, R>
	readonly settle: Effect.Effect<void, E2, R2>
	readonly aborted: Effect.Effect<void>
	readonly holdsTurn: () => boolean
}): Effect.Effect<void, E | E2, R | R2> =>
	Effect.uninterruptibleMask((restore) =>
		restore(options.phases).pipe(
			Effect.onInterrupt(() => options.aborted),
			Effect.andThen(Effect.suspend(() => (options.holdsTurn() ? options.settle : options.aborted))),
		),
	)
