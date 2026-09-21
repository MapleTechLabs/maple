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
import {
	IncidentTriageRequest,
	IncidentTriageVerdict,
	MapleAiApi,
	internalServiceBearer,
} from "@maple/domain/http"
import { WorkerEnvironment } from "@maple/infra/worker-runtime"
import { Cause, Context, Duration, Effect, Layer, Option, Redacted } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { HttpApiClient } from "effect/unstable/httpapi"
import { Env } from "@maple/backend/platform/Env"
import { summarizeCause } from "@maple/backend/platform/describe-cause"

export const AI_WORKER_BINDING = "AI_WORKER"

/**
 * Bounded so a slow model can never stretch an alerting tick past its cron
 * slot: a classification that has not answered in this long is answered
 * "investigate", which is what the tick would have done without it.
 */
export const CLASSIFY_TIMEOUT = Duration.seconds(10)

/** The service binding as the client uses it: a Worker-to-Worker `fetch`. */
interface ServiceBinding {
	readonly fetch: (request: Request) => Promise<Response>
}

const isServiceBinding = (value: unknown): value is ServiceBinding =>
	typeof value === "object" && value !== null && typeof (value as ServiceBinding).fetch === "function"

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
			const env = yield* WorkerEnvironment
			const config = yield* Env
			const binding = env[AI_WORKER_BINDING]
			const token = Option.map(config.INTERNAL_SERVICE_TOKEN, Redacted.value)

			if (!isServiceBinding(binding) || Option.isNone(token)) {
				yield* Effect.logWarning("incident classifier is not available").pipe(
					Effect.annotateLogs({
						"maple.triage.reason": isServiceBinding(binding)
							? "INTERNAL_SERVICE_TOKEN is not configured"
							: "no AI_WORKER service binding on this deployment",
					}),
				)
				return unavailable
			}

			const authorization = internalServiceBearer(token.value)
			// The binding routes by name rather than by host; the origin below is the
			// formality `Request` insists on, and the fetch is the binding's own.
			// Bun's `fetch` type carries `preconnect`; the binding has no such hop to warm.
			const fetchOverBinding: typeof globalThis.fetch = Object.assign(
				(input: RequestInfo | URL, init?: RequestInit) => binding.fetch(new Request(input, init)),
				{ preconnect: () => Promise.resolve() },
			)
			const httpClient = yield* HttpClient.HttpClient
			const client = yield* HttpApiClient.group(MapleAiApi, {
				group: "triage",
				httpClient,
				baseUrl: "https://maple-ai.internal",
			})

			const classify: IncidentClassifierApi["classify"] = Effect.fn("IncidentClassifier.classify")(
				function* (request) {
					return yield* client.classify({ headers: { authorization }, payload: request }).pipe(
						Effect.map((verdict): IncidentTriageVerdict | null => verdict),
						Effect.provideService(FetchHttpClient.Fetch, fetchOverBinding),
						Effect.catchCause((cause) =>
							Cause.hasInterruptsOnly(cause)
								? Effect.interrupt
								: Effect.logWarning("incident classifier call failed").pipe(
										Effect.annotateLogs({ error: summarizeCause(cause) }),
										Effect.as(null),
									),
						),
						Effect.timeoutOrElse({
							duration: CLASSIFY_TIMEOUT,
							orElse: () =>
								Effect.logWarning("incident classifier timed out").pipe(Effect.as(null)),
						}),
					)
				},
			)

			return { classify } satisfies IncidentClassifierApi
		}),
	},
) {
	/** The fetch-backed client the calls run on; the binding supplies the fetch itself. */
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(FetchHttpClient.layer))
}
