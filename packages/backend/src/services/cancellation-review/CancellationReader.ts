/**
 * api's half of the model read: asks maple-ai over the `AI_WORKER` binding for a
 * second opinion on a cancellation, as `IncidentClassifier` does for incidents.
 * The report never waits on it for long and never fails because of it: no
 * binding, no token, an error or a slow answer is `null`, and the report goes
 * out with the rules' reason alone.
 */
import { type CancellationModelRead, type CancellationModelRequest, MapleAiApi } from "@maple/domain/http"
import { Context, Duration, Effect, Layer, Result } from "effect"
import { HttpApiClient } from "effect/http-api"
import {
	aiWorkerConnection,
	bestEffortAiCall,
	MAPLE_AI_BASE_URL,
} from "@maple/backend/platform/ai-worker-client"

/** The review runs on a queue, after its evidence reads; a model slower than this is skipped. */
export const READ_TIMEOUT = Duration.seconds(60)

export interface CancellationReaderApi {
	readonly read: (request: CancellationModelRequest) => Effect.Effect<CancellationModelRead | null>
}

export class CancellationReader extends Context.Service<CancellationReader, CancellationReaderApi>()(
	"@maple/backend/cancellation-review/CancellationReader",
	{
		make: Effect.gen(function* () {
			const connection = yield* aiWorkerConnection
			if (Result.isFailure(connection)) {
				return { read: () => Effect.succeed(null) } satisfies CancellationReaderApi
			}

			const { authorization, httpClient } = connection.success
			const client = yield* HttpApiClient.group(MapleAiApi, {
				group: "cancellationReview",
				httpClient,
				baseUrl: MAPLE_AI_BASE_URL,
			})

			const read: CancellationReaderApi["read"] = Effect.fn("CancellationReader.read")(
				function* (request) {
					return yield* bestEffortAiCall(
						client.read({ headers: { authorization }, payload: request }),
						{
							timeout: READ_TIMEOUT,
							failed: "cancellation model read failed",
							timedOut: "cancellation model read timed out",
						},
					)
				},
			)

			return { read } satisfies CancellationReaderApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
