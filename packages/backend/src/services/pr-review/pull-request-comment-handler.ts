import { Effect, Layer } from "effect"
import { PullRequestCommentSink } from "@maple/backend/services/integrations/vcs/PullRequestEventSink"
import { PrReviewConversationService } from "./PrReviewConversationService"

/**
 * `@maple` mentions as a consumer of the VCS layer's comment port. The adapter lives on the review
 * side for the reason the review trigger's does: VCS maps events, reviews answer them.
 */
export const prReviewCommentSinkLive = Layer.effect(
	PullRequestCommentSink,
	Effect.gen(function* () {
		const conversations = yield* PrReviewConversationService
		return {
			onPullRequestComment: (orgId, job) =>
				conversations.onPullRequestComment(orgId, job).pipe(
					Effect.flatMap((outcome) =>
						Effect.annotateCurrentSpan({
							"maple.pr_reply.trigger": outcome.outcome,
							...(outcome.skipReason === undefined
								? undefined
								: { "maple.pr_reply.skip_reason": outcome.skipReason }),
						}),
					),
				),
		}
	}),
).pipe(Layer.provide(PrReviewConversationService.layer))
