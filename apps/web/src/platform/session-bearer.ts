import { readJwtExpMs } from "../lib/services/common/auth-headers"
import { isClerkAuthEnabled } from "../lib/services/common/auth-mode"
import { Clock, Context, Duration, Effect, Layer, Option, Semaphore } from "effect"
import {
	announceSessionTokenChanged,
	clearSessionToken,
	MapleAuthApi,
	readSessionToken,
	saveSessionToken,
} from "./auth-api"
import { clerkSessionToken, freshClerkSessionToken } from "./clerk"

/** Renew this far ahead of expiry. */
const RENEW_AHEAD = Duration.minutes(5)

/** The bearer token API requests carry: the self-hosted session or Clerk's session JWT. */
export class SessionBearer extends Context.Service<
	SessionBearer,
	{
		readonly token: Effect.Effect<Option.Option<string>>
		/** Skips any token cache; for resending a request the API rejected. */
		readonly freshToken: Effect.Effect<Option.Option<string>>
	}
>()("@maple/web/SessionBearer") {
	static readonly layer = Layer.effect(
		this,
		isClerkAuthEnabled
			? Effect.succeed({ token: clerkSessionToken, freshToken: freshClerkSessionToken })
			: makeSelfHosted(),
	).pipe(Layer.provide(MapleAuthApi.layer))
}

function makeSelfHosted() {
	return Effect.gen(function* () {
		const auth = yield* MapleAuthApi
		// One renewal at a time: a burst of requests finding the same near-expiry token renews once.
		const renewal = yield* Semaphore.make(1)

		const renew = (token: string) =>
			auth.refresh(token).pipe(
				Effect.tap((renewed) => saveSessionToken(renewed.token)),
				Effect.map((renewed) => Option.some(renewed.token)),
				Effect.catchTag("@maple/web/SessionCheckError", (error) =>
					error.reason === "Rejected"
						? Effect.as(
								Effect.andThen(clearSessionToken, announceSessionTokenChanged),
								Option.none(),
							)
						: Effect.succeed(Option.some(token)),
				),
			)

		const freshToken = (token: string) =>
			Effect.gen(function* () {
				const expiresAt = readJwtExpMs(token)
				const now = yield* Clock.currentTimeMillis
				// A token without `exp` predates expiring sessions: it has no deadline to renew ahead of.
				if (expiresAt === undefined || expiresAt - now > Duration.toMillis(RENEW_AHEAD)) {
					return Option.some(token)
				}
				return yield* renew(token)
			})

		const token = readSessionToken.pipe(
			Effect.flatMap(Option.match({ onNone: () => Effect.succeedNone, onSome: freshToken })),
			renewal.withPermits(1),
		)
		// The stored token is the only one there is; re-reading it picks up a concurrent renewal.
		return { token, freshToken: token }
	})
}
