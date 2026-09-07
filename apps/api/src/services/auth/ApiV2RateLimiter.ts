import type { ApiKeyId } from "@maple/domain/http"
import { Context, Effect, Layer, Option } from "effect"
import { ApiV2RateLimit, type RateLimiter } from "@/platform/bindings"

export const API_V2_RATE_LIMIT_REQUESTS = 600
export const API_V2_RATE_LIMIT_PERIOD_SECONDS = 60

export type RateLimitOutcome = "allowed" | "limited" | "failed_open"

export interface RateLimiterApi {
	/**
	 * Rate-limit one caller-chosen key.
	 *
	 * Takes an opaque string rather than an `ApiKeyId` because the v2 API is no
	 * longer the only caller: the public share surface limits per share token and
	 * per client IP, neither of which is an API key. The `v2:` / `share:` scoping
	 * prefix therefore belongs to the caller — see `makeApiV2RateLimitKey`.
	 */
	readonly check: (key: string) => Effect.Effect<RateLimitOutcome>
}

export const makeApiV2RateLimitKey = (partition: string, key: string): string => `${partition}:${key}`

/** The v2 API's own scoping prefix, preserving the pre-generalization key shape. */
export const apiV2RateLimitKey = (keyId: ApiKeyId): string => `v2:${keyId}`

/** Share links are limited per token, and separately per client IP. */
export const shareTokenRateLimitKey = (tokenHashPrefix: string): string => `share:${tokenHashPrefix}`
export const shareIpRateLimitKey = (ip: string): string => `shareip:${ip}`

/**
 * Social-preview traffic, bucketed apart from the viewer keys above.
 *
 * The unfurl path is machine traffic — every chat client that sees the link
 * fetches it, and the page worker asks on each document request. Sharing the
 * viewer's bucket would let that crowd rate-limit the humans the link was sent
 * to, which is the failure this separation exists to prevent.
 */
export const shareOgRateLimitKey = (shareKeyPrefix: string): string => `shareog:${shareKeyPrefix}`

/**
 * The one fail-open check implementation behind every limiter service: allow /
 * limited from the binding, `failed_open` (with `maple.rate_limit.outcome`
 * telemetry, never a silent pass) when the binding or partition is unavailable.
 */
export const makeRateLimitCheck = (
	limiter: Option.Option<RateLimiter>,
	config: { readonly spanName: string; readonly failOpenMessage: string },
): RateLimiterApi["check"] => {
	const warnFailedOpen = (
		reason: "binding_missing" | "partition_missing" | "binding_error",
		cause?: unknown,
	) =>
		Effect.logWarning(config.failOpenMessage).pipe(
			Effect.annotateLogs({
				"maple.rate_limit.outcome": "failed_open",
				"maple.rate_limit.reason": reason,
				...(cause instanceof Error ? { "error.type": cause.name } : undefined),
			}),
		)

	return Effect.fn(config.spanName)(function* (key: string) {
		if (Option.isNone(limiter)) {
			yield* warnFailedOpen("binding_missing")
			return "failed_open" as const
		}

		const partition = limiter.value.partition
		if (partition === undefined) {
			yield* warnFailedOpen("partition_missing")
			return "failed_open" as const
		}

		return yield* limiter.value.limit(makeApiV2RateLimitKey(partition, key)).pipe(
			Effect.map(({ success }) => (success ? ("allowed" as const) : ("limited" as const))),
			Effect.catchTag("@maple/api/platform/RateLimitBindingError", (error) =>
				warnFailedOpen("binding_error", error.cause).pipe(Effect.as<RateLimitOutcome>("failed_open")),
			),
		)
	})
}

export class ApiV2RateLimiter extends Context.Service<ApiV2RateLimiter, RateLimiterApi>()(
	"@maple/api/services/ApiV2RateLimiter",
	{
		make: Effect.gen(function* () {
			const limiter = yield* Effect.serviceOption(ApiV2RateLimit)
			const check = makeRateLimitCheck(limiter, {
				spanName: "ApiV2RateLimiter.check",
				failOpenMessage: "API v2 rate limiter unavailable; allowing request",
			})
			return { check } satisfies RateLimiterApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
