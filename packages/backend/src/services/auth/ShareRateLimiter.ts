import { Context, Effect, Layer } from "effect"
import { ApiV2RateLimit, ShareLinkRateLimit } from "@maple/backend/platform/bindings"
import { Env } from "@maple/backend/platform/Env"
import {
	makeRateLimitCheck,
	type RateLimitOutcome,
	shareIpRateLimitKey,
	shareTokenRateLimitKey,
} from "./ApiV2RateLimiter"

/** Every viewer of one link together, per minute: a wall board and a full room fit well inside. */
export const SHARE_LINK_RATE_LIMIT_REQUESTS = 6000
export const SHARE_LINK_RATE_LIMIT_PERIOD_SECONDS = 60

export interface ShareRateLimiterApi {
	/**
	 * One share request: the viewer's own IP bucket and the link's aggregate bucket must both
	 * pass. Requests over the viewer's budget never reach the link bucket, which is ten times
	 * larger, so no single client can lock every other viewer out of the link.
	 */
	readonly check: (input: {
		readonly tokenHashPrefix: string
		readonly ip: string | undefined
	}) => Effect.Effect<RateLimitOutcome>
}

export class ShareRateLimiter extends Context.Service<ShareRateLimiter, ShareRateLimiterApi>()(
	"@maple/backend/services/ShareRateLimiter",
	{
		make: Effect.gen(function* () {
			const env = yield* Env
			const linkBinding = yield* Effect.serviceOption(ShareLinkRateLimit)
			const viewerBinding = yield* Effect.serviceOption(ApiV2RateLimit)
			const link = makeRateLimitCheck(linkBinding, env.MAPLE_ENVIRONMENT, {
				spanName: "ShareRateLimiter.checkLink",
				failOpenMessage: "Share link rate limiter unavailable; allowing request",
			})
			const viewer = makeRateLimitCheck(viewerBinding, env.MAPLE_ENVIRONMENT, {
				spanName: "ShareRateLimiter.checkViewer",
				failOpenMessage: "Share viewer rate limiter unavailable; allowing request",
			})

			const check = Effect.fn("ShareRateLimiter.check")(function* (input: {
				readonly tokenHashPrefix: string
				readonly ip: string | undefined
			}) {
				// The viewer's own bucket first: a request it refuses never spends the link's
				// budget, so one client can use at most its own share of the link.
				const viewerOutcome =
					input.ip === undefined ? "allowed" : yield* viewer(shareIpRateLimitKey(input.ip))
				if (viewerOutcome === "limited") return "limited" as const
				const linkOutcome = yield* link(shareTokenRateLimitKey(input.tokenHashPrefix))
				if (linkOutcome === "limited") return "limited" as const
				return viewerOutcome === "failed_open" || linkOutcome === "failed_open"
					? ("failed_open" as const)
					: ("allowed" as const)
			})
			return { check } satisfies ShareRateLimiterApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
