// The one way backend code sends telemetry to the ingest gateway: OTLP JSON, the org's public key,
// one timeout and one error. Pollers map `IngestSendError` onto their own failure handling.

import { Duration, Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { Env } from "@maple/backend/platform/Env"
import { isIngestRefusal, summarizeUpstreamBody } from "@maple/backend/services/integrations/upstream-body"

/** Covers the error-body read too, so a stalled body cannot outlive a poller's lease. */
const DEFAULT_TIMEOUT = Duration.seconds(30)

export interface IngestRequest {
	readonly signal: "traces" | "logs" | "metrics"
	/** The org's public ingest key. */
	readonly ingestKey: string
	/** An OTLP JSON body for `signal`. */
	readonly payload: unknown
	/** Names the data in messages, e.g. "Railway metrics". */
	readonly label: string
	/** Replaces the default client, for a caller counting its requests against a budget. */
	readonly client?: HttpClient.HttpClient
	/** Defaults to 30 seconds. */
	readonly timeout?: Duration.Duration
}

export class IngestSendError extends Schema.TaggedError<IngestSendError>()(
	"@maple/backend/ingest/IngestSendError",
	{
		message: Schema.String,
		/** The gateway's status; absent when the request failed or timed out. */
		status: Schema.optionalKey(Schema.Number),
		cause: Schema.optionalKey(Schema.Defect()),
	},
) {}

/** The gateway refused the org's key (billing, revoked, edge block): retrying cannot succeed. */
export const isRefusal = (error: IngestSendError) =>
	error.status !== undefined && isIngestRefusal(error.status)

export const makeIngestSender = Effect.gen(function* () {
	const env = yield* Env
	const httpClient = yield* HttpClient.HttpClient
	const baseUrl = env.MAPLE_INGEST_PUBLIC_URL.replace(/\/+$/, "")

	const send = Effect.fn("IngestSender.send")(
		function* (request: IngestRequest) {
			yield* Effect.annotateCurrentSpan("maple.ingest.signal", request.signal)
			const post = HttpClientRequest.post(`${baseUrl}/v1/${request.signal}`).pipe(
				HttpClientRequest.bearerToken(request.ingestKey),
				HttpClientRequest.bodyJsonUnsafe(request.payload),
			)
			const response = yield* (request.client ?? httpClient).execute(post).pipe(
				Effect.annotateSpans("peer.service", "ingest"),
				Effect.mapError(
					(error) =>
						new IngestSendError({
							message: `${request.label} ingest failed: ${error.message}`,
							cause: error,
						}),
				),
			)
			if (response.status >= 300) {
				const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
				return yield* new IngestSendError({
					message: `${request.label} ingest returned ${response.status}: ${summarizeUpstreamBody(body, response.headers)}`,
					status: response.status,
				})
			}
		},
		(effect, request) =>
			effect.pipe(
				Effect.timeoutOrElse({
					duration: request.timeout ?? DEFAULT_TIMEOUT,
					orElse: () =>
						Effect.fail(new IngestSendError({ message: `${request.label} ingest timed out` })),
				}),
			),
	)

	return { send }
})
