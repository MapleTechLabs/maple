/**
 * The consuming Worker's half of the incident classifier: `maybeEnqueueTriage`
 * asks it whether an incident deserves an investigation before spending one.
 *
 * The decision model and its key live on maple-ai, so this is a call over the
 * `AI_WORKER` service binding to `POST /internal/triage/classify`, authenticated
 * with the internal service token. Modelled on `SandboxClient`: a deployment
 * without the binding gets a classifier that answers nothing, which the gate
 * reads as "investigate", never as "skip".
 */
import { IncidentTriageRequest, IncidentTriageVerdict, MapleAiApi } from "@maple/domain/http"
import { Context, Duration, Effect, Layer, Result } from "effect"
import { HttpApiClient } from "effect/http-api"
import {
	aiWorkerConnection,
	bestEffortAiCall,
	MAPLE_AI_BASE_URL,
} from "@maple/backend/platform/ai-worker-client"

/**
 * Bounded so a slow model can never stretch an alerting tick past its cron
 * slot: a classification that has not answered in this long is answered
 * "investigate", which is what the tick would have done without it.
 */
export const CLASSIFY_TIMEOUT = Duration.seconds(10)

export interface IncidentClassifierApi {
	/**
	 * `null` when there is no verdict: no binding, no token, a failed call or a
	 * slow one. Never fails, because the gate treats no verdict as "investigate"
	 * and a classifier outage must not become a policy of dropping incidents.
	 */
	readonly classify: (request: IncidentTriageRequest) => Effect.Effect<IncidentTriageVerdict | null>
}

const unavailable: IncidentClassifierApi = { classify: () => Effect.succeed(null) }

export class IncidentClassifier extends Context.Service<IncidentClassifier, IncidentClassifierApi>()(
	"@maple/backend/errors/IncidentClassifier",
	{
		make: Effect.gen(function* () {
			const connection = yield* aiWorkerConnection
			if (Result.isFailure(connection)) {
				yield* Effect.logWarning("incident classifier is not available").pipe(
					Effect.annotateLogs({ "maple.triage.reason": connection.failure }),
				)
				return unavailable
			}

			const { authorization, httpClient } = connection.success
			const client = yield* HttpApiClient.group(MapleAiApi, {
				group: "triage",
				httpClient,
				baseUrl: MAPLE_AI_BASE_URL,
			})

			const classify: IncidentClassifierApi["classify"] = Effect.fn("IncidentClassifier.classify")(
				function* (request) {
					return yield* bestEffortAiCall(
						client.classify({ headers: { authorization }, payload: request }),
						{
							timeout: CLASSIFY_TIMEOUT,
							failed: "incident classifier call failed",
							timedOut: "incident classifier timed out",
						},
					)
				},
			)

			return { classify } satisfies IncidentClassifierApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
