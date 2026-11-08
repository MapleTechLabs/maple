/**
 * The AI credit check a turn passes before its model runs. Only spent credits or a reached cap block
 * the turn: billing being unreachable runs it, since `meterTurn` still bills what it spends afterwards.
 */
import {
	AiCredits,
	type AiCreditsExhausted,
	AiCreditsUnavailable,
} from "@maple/backend/services/billing/AiCredits"
import type { OrgId } from "@maple/domain/primitives"
import { Effect, Option } from "effect"

const CHECK_TIMEOUT = "3 seconds"

/** What a refused PR reply posts: the reason, not an invitation to retry into the same refusal. */
export const creditRefusalNotice = (refusal: AiCreditsExhausted): string =>
	`I can't answer this right now: ${refusal.message}`

/** Why the turn may not run, or None when it may. `ownKey` turns are paid on OpenRouter, never refused. */
export const turnCreditRefusal = (orgId: OrgId, ownKey: boolean) =>
	Effect.gen(function* () {
		const credits = yield* AiCredits
		return yield* credits.ensure(orgId, { ownKey }).pipe(
			// A hung billing read must not hold every turn: past this, the turn runs.
			Effect.timeoutOrElse({
				duration: CHECK_TIMEOUT,
				orElse: () => Effect.fail(new AiCreditsUnavailable({ message: "AI credit check timed out" })),
			}),
			Effect.as(Option.none<AiCreditsExhausted>()),
			Effect.catchTags({
				// A plan without AI credits (custom, legacy) is not metered on them: its turns run as before.
				"@maple/backend/billing/AiCreditsExhausted": (refusal) =>
					refusal.reason === "no_credits" ? Effect.succeedNone : Effect.succeedSome(refusal),
				"@maple/backend/billing/AiCreditsUnavailable": (error) =>
					Effect.annotateCurrentSpan("maple.ai_credits.unavailable", true).pipe(
						Effect.andThen(
							Effect.logWarning("Could not check AI credits; running the turn").pipe(
								Effect.annotateLogs({ orgId, error: error.message }),
							),
						),
						Effect.as(Option.none<AiCreditsExhausted>()),
					),
			}),
		)
	})

/** What an investigation row records when its turn was refused: the reason's code, then its message. */
export const creditRefusalError = (refusal: AiCreditsExhausted): string =>
	`ai_credits_${refusal.reason}: ${refusal.message}`
