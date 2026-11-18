import type { AwsConnectionId } from "@maple/primitives"
import { Context, Effect, Layer } from "effect"
import { AwsEventsRateLimit } from "@maple/backend/platform/bindings"
import { Env } from "@maple/backend/platform/Env"
import { makeRateLimitCheck, type RateLimitOutcome } from "../auth/ApiV2RateLimiter"

/**
 * One connection's deliveries, 30 a second: the setup's API destination sends 20 a second at most,
 * and every region's events go through it. The binding counts over ten seconds.
 */
export const AWS_EVENTS_RATE_LIMIT_REQUESTS = 300
export const AWS_EVENTS_RATE_LIMIT_PERIOD_SECONDS = 10

export interface AwsEventsRateLimiterApi {
	/** Counts one delivery. Asked only once its key was accepted, so the budget is the key holder's. */
	readonly check: (connectionId: AwsConnectionId) => Effect.Effect<RateLimitOutcome>
}

export class AwsEventsRateLimiter extends Context.Service<AwsEventsRateLimiter, AwsEventsRateLimiterApi>()(
	"@maple/backend/services/AwsEventsRateLimiter",
	{
		make: Effect.gen(function* () {
			const limiter = yield* Effect.serviceOption(AwsEventsRateLimit)
			const env = yield* Env
			const checkKey = makeRateLimitCheck(limiter, env.MAPLE_ENVIRONMENT, {
				spanName: "AwsEventsRateLimiter.check",
				failOpenMessage: "AWS events rate limiter unavailable; allowing delivery",
			})
			return {
				check: (connectionId) => checkKey(`awsev:${connectionId}`),
			} satisfies AwsEventsRateLimiterApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
