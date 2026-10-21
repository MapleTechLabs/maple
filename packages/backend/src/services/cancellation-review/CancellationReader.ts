/**
 * api's half of the model read: asks maple-ai over the `AI_WORKER` binding for a
 * second opinion on a cancellation, as `IncidentClassifier` does for incidents.
 * The report never waits on it for long and never fails because of it: no
 * binding, no token, an error or a slow answer is `null`, and the report goes
 * out with the rules' reason alone.
 */
import {
	type CancellationModelRead,
	type CancellationModelRequest,
	MapleAiApi,
	internalServiceBearer,
} from "@maple/domain/http"
import * as Cloudflare from "alchemy/Cloudflare"
import { Cause, Context, Duration, Effect, Layer, Option, Redacted } from "effect"
import { HttpApiClient } from "effect/http-api"
import { AiWorkerFetcher } from "@maple/backend/platform/bindings"
import { Env } from "@maple/backend/platform/Env"
import { summarizeCause } from "@maple/backend/platform/describe-cause"

/**
 * The review runs inside Autumn's webhook request, which Svix gives up on after
 * 15 seconds, after the other reads. A model slower than this is skipped.
 */
export const READ_TIMEOUT = Duration.seconds(8)

export interface CancellationReaderApi {
	readonly read: (request: CancellationModelRequest) => Effect.Effect<CancellationModelRead | null>
}

export class CancellationReader extends Context.Service<CancellationReader, CancellationReaderApi>()(
	"@maple/backend/cancellation-review/CancellationReader",
	{
		make: Effect.gen(function* () {
			const binding = Option.flatten(yield* Effect.serviceOption(AiWorkerFetcher))
			const token = Option.map((yield* Env).INTERNAL_SERVICE_TOKEN, Redacted.value)
			if (Option.isNone(binding) || Option.isNone(token)) {
				return { read: () => Effect.succeed(null) } satisfies CancellationReaderApi
			}

			const authorization = internalServiceBearer(token.value)
			const client = yield* HttpApiClient.group(MapleAiApi, {
				group: "cancellationReview",
				httpClient: Cloudflare.toHttpClient(Cloudflare.fromCloudflareFetcher(binding.value)),
				baseUrl: "https://maple-ai.internal",
			})

			const read: CancellationReaderApi["read"] = Effect.fn("CancellationReader.read")(
				function* (request) {
					return yield* client.read({ headers: { authorization }, payload: request }).pipe(
						Effect.map((answer): CancellationModelRead | null => answer),
						Effect.catchCause((cause) =>
							Cause.hasInterruptsOnly(cause)
								? Effect.interrupt
								: Effect.logWarning("cancellation model read failed").pipe(
										Effect.annotateLogs({ error: summarizeCause(cause) }),
										Effect.as(null),
									),
						),
						Effect.timeoutOrElse({
							duration: READ_TIMEOUT,
							orElse: () =>
								Effect.logWarning("cancellation model read timed out").pipe(Effect.as(null)),
						}),
					)
				},
			)

			return { read } satisfies CancellationReaderApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
