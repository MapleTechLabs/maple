/**
 * A running review's progress, shown on its pull request comment while it works.
 *
 * Tool calls are recorded as they happen; a heartbeat fiber writes the comment on a fixed beat, so
 * the elapsed time keeps moving through a long model response with no tool call in it. Writes take a
 * single permit and cannot be interrupted midway, so stopping the feed waits out an edit in flight
 * and the report's own edit always lands after the last progress edit.
 */
import {
	INVESTIGATION_PROGRESS_STEPS,
	type InvestigationStep,
	type PrReviewFindingCounts,
	type PrReviewProgress,
} from "@maple/domain/http"
import { Clock, Duration, Effect, Fiber, Queue, Ref, Schedule, Semaphore } from "effect"
import { reviewStepLabel, type ToolCallInput } from "./progress"
import type { ReviewCoverage } from "./review-coverage"
import type { ReviewLedger } from "./review-ledger"

/** Each write edits a GitHub comment, so the beat stays well inside the API's rate limits. */
export const REVIEW_PROGRESS_HEARTBEAT = Duration.seconds(30)

export interface ReviewProgressFeed {
	/** Note a tool call. Synchronous: it is called from the run's event callback. */
	readonly step: (tool: string, input: ToolCallInput) => void
	/** The pass ended without a report; say the write-up is under way, now rather than on the beat. */
	readonly closingOut: Effect.Effect<void>
	/** Stop the feed, waiting out a write in flight. Safe to call more than once. */
	readonly close: Effect.Effect<void>
}

interface FeedState {
	readonly stepCount: number
	readonly steps: ReadonlyArray<InvestigationStep>
	readonly closingOut: boolean
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
	const calls = yield* Queue.unbounded<{ readonly tool: string; readonly input: ToolCallInput }>()
	const state = yield* Ref.make<FeedState>({ stepCount: 0, steps: [], closingOut: false })
	const permit = yield* Semaphore.make(1)
	const open = yield* Ref.make(true)

	const record = Effect.gen(function* () {
		const call = yield* Queue.take(calls)
		const at = yield* Clock.currentTimeMillis
		yield* Ref.update(state, (current) => ({
			...current,
			stepCount: current.stepCount + 1,
			steps: [
				...current.steps,
				{ tool: call.tool, label: reviewStepLabel(call.tool, call.input), at },
			].slice(-INVESTIGATION_PROGRESS_STEPS),
		}))
	}).pipe(Effect.forever)

	const writeNow = Effect.gen(function* () {
		if (!(yield* Ref.get(open))) return
		const current = yield* Ref.get(state)
		const { due, read } = input.coverage.counts()
		yield* input.write({
			startedAt,
			updatedAt: yield* Clock.currentTimeMillis,
			stepCount: current.stepCount,
			steps: current.steps,
			filesDue: due,
			filesRead: read,
			findings: countFindings(input.ledger),
			closingOut: current.closingOut,
		})
	}).pipe(permit.withPermits(1), Effect.uninterruptible)

	const heartbeat = writeNow.pipe(Effect.repeat(Schedule.spaced(REVIEW_PROGRESS_HEARTBEAT)))
	const fiber = yield* Effect.forkChild(
		Effect.all([record, heartbeat], { concurrency: "unbounded", discard: true }),
	)

	return {
		step: (tool, toolInput) => {
			Queue.offerUnsafe(calls, { tool, input: toolInput })
		},
		closingOut: Ref.update(state, (current) => ({ ...current, closingOut: true })).pipe(
			Effect.andThen(writeNow),
		),
		// Under the permit: an edit in flight finishes first, and none starts after.
		close: Ref.set(open, false).pipe(permit.withPermits(1), Effect.andThen(Fiber.interrupt(fiber))),
	} satisfies ReviewProgressFeed
})
