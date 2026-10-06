/**
 * Fire-and-forget Autumn usage tracking for every AI surface Maple bills:
 * autonomous triage, an attended chat turn, and the
 * chat-platform bot. All of them meter the same two features — the source
 * names the surface inside the idempotency key. Infallible by type, because every
 * caller reaches it from a place where a failure must not propagate.
 *
 * The idempotency key carries the source, so two surfaces that legitimately key
 * on the same id can never collide — and a retry of any of them bills once.
 */
import { Config, Duration, Effect, Option, Redacted } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { AUTUMN_API_VERSION, AUTUMN_TRACK_PATH } from "@maple/backend/services/billing/autumn-api"

const DEFAULT_AUTUMN_API_URL = "https://api.useautumn.com"

/**
 * Ceiling on one track call.
 *
 * Every caller awaits this from somewhere that is holding something open — a chat
 * turn holds the session's turn slot until it resolves, so an unbounded stall would
 * leave a finished conversation unable to accept the next message. A dropped meter
 * event is the cheaper failure, and it is already the failure mode for a non-2xx.
 */
const TRACK_TIMEOUT = Duration.seconds(5)

export interface TrackTokenUsageOptions {
	readonly orgId: string
	readonly inputTokens: number
	readonly outputTokens: number
	readonly idempotencyKey: string
	readonly source: "triage" | "review" | "chat" | "bot"
}

interface TrackEvent {
	readonly featureId: "ai_input_tokens" | "ai_output_tokens"
	readonly value: number
	readonly idempotencyKey: string
}

/** A setting that is absent, blank or malformed reads as unset, as the raw-env version did. */
const optional = <A>(config: Config.Config<A>) =>
	Config.option(config).pipe(Config.orElse(() => Config.succeed(Option.none<A>())))

const notBlank = (value: string) => value.trim() !== ""

const trackerConfig = Config.all({
	secretKey: optional(Config.Redacted("AUTUMN_SECRET_KEY")).pipe(
		Config.map(Option.filter((key) => notBlank(Redacted.value(key)))),
	),
	defaultOrgId: optional(Config.String("MAPLE_DEFAULT_ORG_ID")).pipe(Config.map(Option.filter(notBlank))),
	apiUrl: optional(Config.String("AUTUMN_API_URL")).pipe(Config.map(Option.filter(notBlank))),
})

const postTrack = (
	client: HttpClient.HttpClient,
	apiUrl: string,
	secretKey: Redacted.Redacted<string>,
	customerId: string,
	event: TrackEvent,
) =>
	client
		.execute(
			HttpClientRequest.post(`${apiUrl}${AUTUMN_TRACK_PATH}`).pipe(
				HttpClientRequest.bearerToken(Redacted.value(secretKey)),
				HttpClientRequest.setHeader("x-api-version", AUTUMN_API_VERSION),
				HttpClientRequest.bodyJsonUnsafe({
					customer_id: customerId,
					feature_id: event.featureId,
					value: event.value,
					idempotency_key: event.idempotencyKey,
				}),
			),
		)
		.pipe(
			Effect.flatMap((response) =>
				response.status >= 200 && response.status < 300
					? Effect.void
					: response.text.pipe(
							Effect.orElseSucceed(() => ""),
							Effect.flatMap((body) =>
								Effect.logWarning("autumn track failed").pipe(
									Effect.annotateLogs({
										status: response.status,
										feature: event.featureId,
										body,
									}),
								),
							),
						),
			),
			Effect.timeout(TRACK_TIMEOUT),
			Effect.catchCause((cause) =>
				Effect.logWarning("autumn track error", cause).pipe(
					Effect.annotateLogs({ feature: event.featureId }),
				),
			),
		)

export const trackTokenUsage = Effect.fn("trackTokenUsage")(function* ({
	orgId,
	inputTokens,
	outputTokens,
	idempotencyKey,
	source,
}: TrackTokenUsageOptions) {
	if (inputTokens <= 0 && outputTokens <= 0) return
	const config = yield* trackerConfig.pipe(Effect.orElseSucceed(() => undefined))
	if (config === undefined || Option.isNone(config.secretKey)) return
	if (Option.contains(config.defaultOrgId, orgId)) return

	const apiUrl = Option.getOrElse(config.apiUrl, () => DEFAULT_AUTUMN_API_URL).replace(/\/+$/, "")
	const events: TrackEvent[] = []
	if (inputTokens > 0) {
		events.push({
			featureId: "ai_input_tokens",
			value: inputTokens,
			idempotencyKey: `${idempotencyKey}:${source}:input`,
		})
	}
	if (outputTokens > 0) {
		events.push({
			featureId: "ai_output_tokens",
			value: outputTokens,
			idempotencyKey: `${idempotencyKey}:${source}:output`,
		})
	}

	const client = yield* HttpClient.HttpClient
	const secretKey = config.secretKey.value
	yield* Effect.forEach(events, (event) => postTrack(client, apiUrl, secretKey, orgId, event), {
		concurrency: "unbounded",
		discard: true,
	})
})
