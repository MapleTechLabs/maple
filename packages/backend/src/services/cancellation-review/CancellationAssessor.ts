/**
 * The api Worker's half of the cancellation assessment: the decision model and
 * its key live on maple-ai, so this is a call over the `AI_WORKER` service
 * binding to `POST /internal/cancellation/assess`, authenticated with the
 * internal service token. Same wiring as `IncidentClassifier`.
 */
import {
	type CancellationAssessment,
	type CancellationSnapshot,
	MapleAiApi,
	internalServiceBearer,
} from "@maple/domain/http"
import * as Cloudflare from "alchemy/Cloudflare"
import { Cause, Context, Duration, Effect, Layer, Option, Redacted } from "effect"
import { HttpApiClient } from "effect/http-api"
import { AiWorkerFetcher } from "@maple/backend/platform/bindings"
import { Env } from "@maple/backend/platform/Env"
import { summarizeCause } from "@maple/backend/platform/describe-cause"

const ASSESS_TIMEOUT = Duration.seconds(15)

export interface CancellationAssessorApi {
	/**
	 * `null` when there is no answer: no binding, no token, a failed call or a
	 * slow one. Never fails, because the report is worth posting without it.
	 */
	readonly assess: (snapshot: CancellationSnapshot) => Effect.Effect<CancellationAssessment | null>
}

const unavailable: CancellationAssessorApi = { assess: () => Effect.succeed(null) }

export class CancellationAssessor extends Context.Service<CancellationAssessor, CancellationAssessorApi>()(
	"@maple/backend/cancellation-review/CancellationAssessor",
	{
		make: Effect.gen(function* () {
			const binding = Option.flatten(yield* Effect.serviceOption(AiWorkerFetcher))
			const config = yield* Env
			const token = Option.map(config.INTERNAL_SERVICE_TOKEN, Redacted.value)
			if (Option.isNone(binding) || Option.isNone(token)) {
				yield* Effect.logWarning("cancellation assessor is not available; reports carry no model read").pipe(
					Effect.annotateLogs({
						reason: Option.isSome(binding)
							? "INTERNAL_SERVICE_TOKEN is not configured"
							: "no AI_WORKER service binding on this deployment",
					}),
				)
				return unavailable
			}

			const authorization = internalServiceBearer(token.value)
			// The binding routes by name rather than by host; the origin is a formality.
			const httpClient = Cloudflare.toHttpClient(Cloudflare.fromCloudflareFetcher(binding.value))
			const client = yield* HttpApiClient.group(MapleAiApi, {
				group: "cancellation",
				httpClient,
				baseUrl: "https://maple-ai.internal",
			})

			const assess: CancellationAssessorApi["assess"] = Effect.fn("CancellationAssessor.assess")(
				function* (snapshot) {
					return yield* client.assess({ headers: { authorization }, payload: snapshot }).pipe(
						Effect.map((assessment): CancellationAssessment | null => assessment),
						Effect.catchCause((cause) =>
							Cause.hasInterruptsOnly(cause)
								? Effect.interrupt
								: Effect.logWarning("cancellation assessment call failed").pipe(
										Effect.annotateLogs({ error: summarizeCause(cause) }),
										Effect.as(null),
									),
						),
						Effect.timeoutOrElse({
							duration: ASSESS_TIMEOUT,
							orElse: () =>
								Effect.logWarning("cancellation assessment timed out").pipe(Effect.as(null)),
						}),
					)
				},
			)

			return { assess } satisfies CancellationAssessorApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
