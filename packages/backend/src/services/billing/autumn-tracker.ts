/**
 * Fire-and-forget Autumn usage tracking for every AI surface Maple bills:
 * autonomous triage, an attended chat turn, and the
 * chat-platform bot. The source names the surface inside the idempotency key,
 * so two surfaces that legitimately key on the same id can never collide, and a
 * retry of any of them bills once. Infallible by type, because every caller
 * reaches it from a place where a failure must not propagate.
 *
 * Two meters run side by side while AI credits roll out: {@link trackAiCredits}
 * charges dollars per model through Autumn's AI credit system, and
 * {@link trackTokenUsage} keeps the legacy raw token counts for comparison.
 */
import { Config, Duration, Effect, Option, Redacted } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import {
	AUTUMN_API_VERSION,
	AUTUMN_TRACK_PATH,
	AUTUMN_TRACK_TOKENS_PATH,
} from "@maple/backend/services/billing/autumn-api"

const DEFAULT_AUTUMN_API_URL = "https://api.useautumn.com"

/** The AI credit system feature in `apps/api/autumn.config.ts`. */
export const AI_CREDITS_FEATURE_ID = "ai_credits"

/**
 * Ceiling on one track call.
 *
 * Every caller awaits this from somewhere that is holding something open — a chat
 * turn holds the session's turn slot until it resolves, so an unbounded stall would
 * leave a finished conversation unable to accept the next message. A dropped meter
 * event is the cheaper failure, and it is already the failure mode for a non-2xx.
 */
const TRACK_TIMEOUT = Duration.seconds(5)

export type AiUsageSource = "triage" | "review" | "chat" | "bot"

export interface TrackTokenUsageOptions {
	readonly orgId: string
	readonly inputTokens: number
	readonly outputTokens: number
	readonly idempotencyKey: string
	readonly source: AiUsageSource
}

/**
 * One AI credit charge: a model call, or consecutive calls to one model, in Autumn's exclusive token pools: `inputTokens` excludes cache
 * reads and writes, `outputTokens` excludes reasoning. Autumn prices each pool at the model's rate.
 */
export interface AiModelSpend {
	/** `<models.dev provider>/<model>`, e.g. `openrouter/z-ai/glm-5.3-flash`. */
	readonly modelId: string
	readonly inputTokens: number
	readonly outputTokens: number
	readonly cacheReadTokens: number
	readonly cacheWriteTokens: number
	readonly reasoningTokens: number
}

export interface TrackAiCreditsOptions {
	readonly orgId: string
	/** In call order: a charge's position is part of its idempotency key. */
	readonly spends: ReadonlyArray<AiModelSpend>
	readonly idempotencyKey: string
	readonly source: AiUsageSource
}

interface UsageRequest {
	readonly path: string
	readonly body: Record<string, unknown>
	/** Sent as the `Idempotency-Key` header, which Autumn honours on every route. */
	readonly idempotencyKey?: string
	/** What the warning logs name: a feature id or a model id. */
	readonly label: string
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

/** The tracker's settings, or `undefined` when this org must not be metered. */
const resolveTracker = Effect.fn("AutumnTracker.resolveTracker")(function* (orgId: string) {
	const config = yield* trackerConfig.pipe(Effect.orElseSucceed(() => undefined))
	if (config === undefined || Option.isNone(config.secretKey)) return undefined
	if (Option.contains(config.defaultOrgId, orgId)) return undefined
	return {
		apiUrl: Option.getOrElse(config.apiUrl, () => DEFAULT_AUTUMN_API_URL).replace(/\/+$/, ""),
		secretKey: config.secretKey.value,
	}
})

const postUsage = (
	client: HttpClient.HttpClient,
	tracker: { readonly apiUrl: string; readonly secretKey: Redacted.Redacted<string> },
	request: UsageRequest,
) =>
	client
		.execute(
			HttpClientRequest.post(`${tracker.apiUrl}${request.path}`).pipe(
				HttpClientRequest.bearerToken(Redacted.value(tracker.secretKey)),
				HttpClientRequest.setHeader("x-api-version", AUTUMN_API_VERSION),
				request.idempotencyKey === undefined
					? (req) => req
					: HttpClientRequest.setHeader("Idempotency-Key", request.idempotencyKey),
				HttpClientRequest.bodyJsonUnsafe(request.body),
			),
		)
		.pipe(
			Effect.flatMap((response) =>
				// 409 is Autumn refusing a key it already counted: the retry this key exists for.
				(response.status >= 200 && response.status < 300) || response.status === 409
					? Effect.void
					: response.text.pipe(
							Effect.orElseSucceed(() => ""),
							Effect.flatMap((body) =>
								Effect.logWarning("autumn track failed").pipe(
									Effect.annotateLogs({
										status: response.status,
										path: request.path,
										feature: request.label,
										body,
									}),
								),
							),
						),
			),
			Effect.timeout(TRACK_TIMEOUT),
			Effect.catchCause((cause) =>
				Effect.logWarning("autumn track error", cause).pipe(
					Effect.annotateLogs({ path: request.path, feature: request.label }),
				),
			),
			// Named like `autumn-http.ts`'s span so every Autumn call reads as one dependency.
			Effect.withSpan("autumn.request", {
				kind: "client",
				attributes: { "autumn.route": request.path, "peer.service": "autumn" },
			}),
		)

const postAll = (orgId: string, requests: ReadonlyArray<UsageRequest>) =>
	Effect.gen(function* () {
		if (requests.length === 0) return
		const tracker = yield* resolveTracker(orgId)
		if (tracker === undefined) return
		const client = yield* HttpClient.HttpClient
		yield* Effect.forEach(requests, (request) => postUsage(client, tracker, request), {
			concurrency: 8,
			discard: true,
		})
	})

/** Legacy raw token counts, kept beside {@link trackAiCredits} until the credit system is trusted. */
export const trackTokenUsage = Effect.fn("AutumnTracker.trackTokenUsage")(function* ({
	orgId,
	inputTokens,
	outputTokens,
	idempotencyKey,
	source,
}: TrackTokenUsageOptions) {
	const counts = [
		{ featureId: "ai_input_tokens", value: inputTokens, suffix: "input" },
		{ featureId: "ai_output_tokens", value: outputTokens, suffix: "output" },
	].filter((count) => count.value > 0)
	yield* postAll(
		orgId,
		counts.map((count) => ({
			path: AUTUMN_TRACK_PATH,
			label: count.featureId,
			body: {
				customer_id: orgId,
				feature_id: count.featureId,
				value: count.value,
				idempotency_key: `${idempotencyKey}:${source}:${count.suffix}`,
			},
		})),
	)
})

const spendsAnything = (spend: AiModelSpend) =>
	spend.inputTokens +
		spend.outputTokens +
		spend.cacheReadTokens +
		spend.cacheWriteTokens +
		spend.reasoningTokens >
	0

/**
 * Charge a turn's model calls to the org's AI credits, one `track_tokens` call per charge.
 *
 * Autumn turns tokens into dollars from the model's published rates plus the markup configured
 * on the feature, so a cache read or a cheap model costs what it actually costs. The default
 * overage behaviour is kept on purpose: `overflow` would ignore the org's spend limit.
 */
export const trackAiCredits = Effect.fn("AutumnTracker.trackAiCredits")(function* ({
	orgId,
	spends,
	idempotencyKey,
	source,
}: TrackAiCreditsOptions) {
	yield* postAll(
		orgId,
		spends
			.flatMap((spend, index) =>
				spendsAnything(spend) ? [{ spend, key: `${idempotencyKey}:${source}:credits:${index}` }] : [],
			)
			.map(({ spend, key }) => ({
				path: AUTUMN_TRACK_TOKENS_PATH,
				label: spend.modelId,
				idempotencyKey: key,
				body: {
					customer_id: orgId,
					feature_id: AI_CREDITS_FEATURE_ID,
					model_id: spend.modelId,
					input_tokens: spend.inputTokens,
					output_tokens: spend.outputTokens,
					cache_read_tokens: spend.cacheReadTokens,
					cache_write_tokens: spend.cacheWriteTokens,
					reasoning_tokens: spend.reasoningTokens,
					properties: { source },
				},
			})),
	)
})
