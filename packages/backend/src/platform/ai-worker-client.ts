/**
 * The transport and bearer for calling maple-ai's internal endpoints over the `AI_WORKER` service
 * binding, plus the best-effort call shape every such caller shares: a second opinion that never
 * fails the caller and never makes it wait past its own deadline.
 */
import { internalServiceBearer } from "@maple/domain/http"
import * as Cloudflare from "@alchemy.run/cloudflare"
import { Cause, type Duration, Effect, Option, Redacted, Result } from "effect"
import type { HttpClient } from "effect/http"
import { AiWorkerFetcher } from "./bindings"
import { summarizeCause } from "./describe-cause"
import { Env } from "./Env"

/** The binding routes by name, not host; `Request` only insists on some origin. */
export const MAPLE_AI_BASE_URL = "https://maple-ai.internal"

export interface AiWorkerConnection {
	readonly httpClient: HttpClient.HttpClient
	/** `Authorization` header value for maple-ai's internal endpoints. */
	readonly authorization: string
}

/** The connection, or why this deployment has none (no binding, or no service token). */
export const aiWorkerConnection: Effect.Effect<
	Result.Result<AiWorkerConnection, string>,
	never,
	Env
> = Effect.gen(function* () {
	const fetcher = yield* Effect.serviceOption(AiWorkerFetcher)
	const env = yield* Env
	const binding = Option.flatten(fetcher)
	const token = Option.map(env.INTERNAL_SERVICE_TOKEN, Redacted.value)
	if (Option.isNone(binding)) return Result.fail("no AI_WORKER service binding on this deployment")
	if (Option.isNone(token)) return Result.fail("INTERNAL_SERVICE_TOKEN is not configured")
	return Result.succeed({
		httpClient: Cloudflare.toHttpClient(Cloudflare.fromCloudflareFetcher(binding.value)),
		authorization: internalServiceBearer(token.value),
	})
})

/** Runs a maple-ai call whose failure or slowness logs and yields `null`; interrupts still propagate. */
export const bestEffortAiCall = <A, E, R>(
	call: Effect.Effect<A, E, R>,
	options: { readonly timeout: Duration.Input; readonly failed: string; readonly timedOut: string },
): Effect.Effect<A | null, never, R> =>
	call.pipe(
		Effect.map((answer): A | null => answer),
		Effect.catchCause((cause) =>
			Cause.hasInterruptsOnly(cause)
				? Effect.interrupt
				: Effect.logWarning(options.failed).pipe(
						Effect.annotateLogs({ error: summarizeCause(cause) }),
						Effect.as(null),
					),
		),
		Effect.timeoutOrElse({
			duration: options.timeout,
			orElse: () => Effect.logWarning(options.timedOut).pipe(Effect.as(null)),
		}),
	)
