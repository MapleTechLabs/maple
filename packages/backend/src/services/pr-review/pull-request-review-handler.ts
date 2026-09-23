import { Effect } from "effect"
import type { PullRequestEventHandler } from "@maple/backend/services/integrations/vcs/PullRequestEventSink"
import { PrReviewService } from "./PrReviewService"

/**
 * The review trigger as a consumer of the VCS layer's pull-request port.
 *
 * Beside the fix-verification handler in the fan-out, and like it the adapter lives on the
 * consumer's side so the dependency points one way: reviews know about the port, VCS does not
 * know about reviews. `onPullRequestEvent` already never fails; the outcome goes on the span.
 */
export const prReviewPullRequestHandler: PullRequestEventHandler<PrReviewService> = Effect.gen(function* () {
	const reviews = yield* PrReviewService
	return {
		onPullRequestEvent: (orgId, job) =>
			reviews.onPullRequestEvent(orgId, job).pipe(
				Effect.flatMap((outcome) =>
					Effect.annotateCurrentSpan({
						"maple.pr_review.trigger": outcome.outcome,
						...(outcome.skipReason === undefined
							? undefined
							: { "maple.pr_review.skip_reason": outcome.skipReason }),
					}),
				),
			),
	}
})
