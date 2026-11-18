import { Clock, Context, Effect, Layer, Option } from "effect"
import { SelfHostedLoginRateLimitError } from "@maple/domain/http"
import { SelfHostedLoginRateLimit } from "@maple/backend/platform/bindings"
import { Env } from "@maple/backend/platform/Env"

/** Root-password attempts one client may make per window, right or wrong. */
export const SELF_HOSTED_LOGIN_RATE_LIMIT_ATTEMPTS = 10
export const SELF_HOSTED_LOGIN_RATE_LIMIT_PERIOD_SECONDS = 60
/** Past this many live clients, new ones share one bucket, so the map cannot grow without bound. */
const MAX_TRACKED_CLIENTS = 10_000
const OVERFLOW_KEY = "overflow"

export interface SelfHostedLoginRateLimiterApi {
	/** Spends one attempt for `clientKey`, or fails once the client is over the limit. */
	readonly check: (clientKey: string) => Effect.Effect<void, SelfHostedLoginRateLimitError>
}

const limited = (retryAfterSeconds: number) =>
	new SelfHostedLoginRateLimitError({
		message: "Too many sign-in attempts. Wait a minute and try again.",
		retryAfterSeconds,
	})

/**
 * Limits `POST /api/auth/login` per client. The api Worker uses its rate-limit binding; a host
 * without one (or a binding outage) falls back to a fixed window held in this process, so the
 * limit never fails open.
 */
export class SelfHostedLoginRateLimiter extends Context.Service<
	SelfHostedLoginRateLimiter,
	SelfHostedLoginRateLimiterApi
>()("@maple/backend/services/SelfHostedLoginRateLimiter", {
	make: Effect.gen(function* () {
		const env = yield* Env
		const binding = yield* Effect.serviceOption(SelfHostedLoginRateLimit)
		const periodMs = SELF_HOSTED_LOGIN_RATE_LIMIT_PERIOD_SECONDS * 1000
		const windows = new Map<string, { readonly startedAt: number; attempts: number }>()

		const prune = (now: number) =>
			windows.forEach((window, key) => {
				if (now - window.startedAt >= periodMs) windows.delete(key)
			})

		const checkInProcess = Effect.fn("SelfHostedLoginRateLimiter.checkInProcess")(function* (
			clientKey: string,
		) {
			const now = yield* Clock.currentTimeMillis
			if (windows.size >= MAX_TRACKED_CLIENTS) prune(now)
			const key =
				windows.has(clientKey) || windows.size < MAX_TRACKED_CLIENTS ? clientKey : OVERFLOW_KEY
			const current = windows.get(key)
			if (current === undefined || now - current.startedAt >= periodMs) {
				windows.set(key, { startedAt: now, attempts: 1 })
				return
			}
			if (current.attempts >= SELF_HOSTED_LOGIN_RATE_LIMIT_ATTEMPTS) {
				return yield* limited(Math.max(1, Math.ceil((current.startedAt + periodMs - now) / 1000)))
			}
			current.attempts += 1
		})

		const check = Effect.fn("SelfHostedLoginRateLimiter.check")(function* (clientKey: string) {
			if (Option.isNone(binding)) return yield* checkInProcess(clientKey)
			const outcome = yield* binding.value
				.limit(`${env.MAPLE_ENVIRONMENT}:self-hosted-login:${clientKey}`)
				.pipe(Effect.option)
			if (Option.isNone(outcome)) {
				yield* Effect.logWarning("Login rate limiter unavailable; using the in-process limit")
				return yield* checkInProcess(clientKey)
			}
			if (!outcome.value.success) return yield* limited(SELF_HOSTED_LOGIN_RATE_LIMIT_PERIOD_SECONDS)
		})

		return { check } satisfies SelfHostedLoginRateLimiterApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}
